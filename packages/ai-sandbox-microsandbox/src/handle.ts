/**
 * SandboxHandle backed by a microsandbox microVM (via the `microsandbox` SDK).
 * The VM runs on this host under libkrun, with its own guest kernel; fs/exec/git
 * operate inside it. Paths are real guest paths (default workdir `/workspace`).
 *
 * fs uses the SDK's native guest filesystem API. exec and spawn both stream a
 * `sh -c` through the guest agent, with `cwd`/`env` passed natively. stdout and
 * stderr arrive as separate events.
 */
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { PassThrough } from 'node:stream'
import {
  UnsupportedCapabilityError,
  createExecBackedGit,
} from '@tanstack/ai-sandbox'
import { Sandbox } from 'microsandbox'
import type { ExecHandle } from 'microsandbox'
import type {
  ExecResult,
  ProcessOptions,
  SandboxCapabilities,
  SandboxFsStat,
  SandboxHandle,
  SnapshotRef,
  SpawnHandle,
} from '@tanstack/ai-sandbox'

export const MICROSANDBOX_CAPS: SandboxCapabilities = {
  fs: true,
  exec: true,
  env: true,
  ports: true,
  backgroundProcesses: true,
  writableStdin: true,
  // MEASURED against a real microVM: `ExecHandle.kill()` stopped a
  // `( … ) & wait` ticker, so the backgrounded child dies too.
  // `tests/journal.conformance.test.ts` re-measures this when live tests run.
  killableProcesses: true,
  snapshots: true,
  networkPolicy: true,
  // The sandbox disk persists across stop/start until it is destroyed.
  durableFilesystem: true,
  // Per handle: a live fork fails when the source has a network policy
  // (`allowHostAccess` or a `deny` policy). See `MicrosandboxHandleDeps.fork`.
  fork: true,
}

export const DEFAULT_WORKDIR = '/workspace'

/** Guest port → host port published on 127.0.0.1. */
export type PortMap = ReadonlyMap<number, number>

export interface MicrosandboxHandleDeps {
  /** The live microsandbox sandbox. Its name is the handle id. */
  sandbox: Sandbox
  /** Working directory inside the guest (the `/workspace` virtual root maps here). */
  workdir: string
  /** Published ports. A port missing here cannot be connected to. */
  ports: PortMap
  /** Builds a new handle for a forked sandbox. Absent when a fork is not possible. */
  fork?: (parent: Sandbox, name: string) => Promise<SandboxHandle>
}

/** Linux numbers, because the guest is Linux. `os.constants` has the host's. */
const GUEST_SIGNALS: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGABRT: 6,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGUSR2: 12,
  SIGTERM: 15,
  SIGCONT: 18,
  SIGSTOP: 19,
}

function guestSignal(signal: NodeJS.Signals | number): number {
  const n = typeof signal === 'number' ? signal : GUEST_SIGNALS[signal]
  if (n === undefined)
    throw new Error(`microsandbox: unsupported signal ${signal}`)
  return n
}

function isNotFound(error: unknown): boolean {
  // ponytail: the SDK reports guest errno only in the message.
  return error instanceof Error && /\(os error 2\)/.test(error.message)
}

export class MicrosandboxHandle implements SandboxHandle {
  readonly id: string
  readonly provider = 'microsandbox'
  readonly workspaceRoot: string
  readonly capabilities: SandboxCapabilities
  readonly fs: SandboxHandle['fs']
  readonly git: SandboxHandle['git']
  readonly process: SandboxHandle['process']
  readonly ports: SandboxHandle['ports']
  readonly env: SandboxHandle['env']

  private readonly sandbox: Sandbox
  private readonly workdir: string
  private readonly envVars: Record<string, string> = {}
  private readonly forkWith: MicrosandboxHandleDeps['fork']

  constructor(deps: MicrosandboxHandleDeps) {
    this.sandbox = deps.sandbox
    this.workdir = deps.workdir
    this.workspaceRoot = deps.workdir
    this.id = deps.sandbox.name
    this.forkWith = deps.fork
    this.capabilities = { ...MICROSANDBOX_CAPS, fork: deps.fork !== undefined }
    const gfs = deps.sandbox.fs()

    this.process = {
      exec: (command, opts) => this.exec(command, opts),
      spawn: (command, opts) => this.spawnProcess(command, opts),
    }

    this.fs = {
      read: (p) => gfs.readToString(this.abs(p)),
      readBytes: (p) => gfs.read(this.abs(p)),
      write: async (p, data) => {
        const abs = this.abs(p)
        // The guest agent does not create missing parents on write.
        await gfs.mkdir(posix.dirname(abs))
        await gfs.write(abs, data)
      },
      list: async (p) => {
        const entries = await gfs.list(this.abs(p))
        const base = p.replace(/\/$/, '')
        return entries.map((entry) => {
          const name = posix.basename(entry.path)
          return {
            name,
            path: `${base}/${name}`,
            type:
              entry.kind === 'directory' ? ('dir' as const) : ('file' as const),
          }
        })
      },
      lstat: (p) => this.lstat(this.abs(p)),
      // Recursive and idempotent in the guest agent.
      mkdir: (p) => gfs.mkdir(this.abs(p)),
      remove: async (p) => {
        const abs = this.abs(p)
        const stat = await this.lstat(abs)
        if (stat === undefined) return
        // `remove` refuses directories; `removeDir` is recursive.
        if (stat.type === 'dir') await gfs.removeDir(abs)
        else await gfs.remove(abs)
      },
      rename: (from, to) => gfs.rename(this.abs(from), this.abs(to)),
      exists: (p) => gfs.exists(this.abs(p)),
    }

    this.git = createExecBackedGit(this.process, this.workspaceRoot)

    this.ports = {
      connect: (port) => {
        const host = deps.ports.get(port)
        if (host === undefined) {
          return Promise.reject(
            new Error(
              `microsandbox: port ${port} is not published. Only the \`ports\` on microsandboxSandbox() are published, at create or restore. A fork has none.`,
            ),
          )
        }
        return Promise.resolve({ url: `http://127.0.0.1:${host}` })
      },
    }

    this.env = {
      set: (vars) => {
        Object.assign(this.envVars, vars)
        return Promise.resolve()
      },
    }
  }

  /** Map the conventional `/workspace` virtual root to the guest workdir. */
  private abs(p: string): string {
    if (this.workdir === '/workspace') return p
    if (p === '/workspace') return this.workdir
    if (p.startsWith('/workspace/'))
      return `${this.workdir}/${p.slice('/workspace/'.length)}`
    return p
  }

  /**
   * `fs.stat` follows symlinks, but `fs.list` reports each entry without
   * following it, so the entry is looked up in its parent's listing.
   */
  private async lstat(path: string): Promise<SandboxFsStat | undefined> {
    const abs = posix.resolve('/', path)
    if (abs === '/') {
      const root = await this.sandbox.fs().stat('/')
      return { type: 'dir', mode: root.mode }
    }
    const parent = posix.dirname(abs)
    let entries
    try {
      // ponytail: lists the whole parent; fine until directories get huge.
      entries = await this.sandbox.fs().list(parent)
    } catch (error) {
      // Missing only when an ancestor is confirmed missing, not e.g. a file.
      if (isNotFound(error) && (await this.lstat(parent)) === undefined)
        return undefined
      throw error
    }
    const entry = entries.find(
      (e) => posix.basename(e.path) === posix.basename(abs),
    )
    if (entry === undefined) return undefined
    switch (entry.kind) {
      case 'file':
        return { type: 'file', mode: entry.mode, size: entry.size }
      case 'directory':
        return { type: 'dir', mode: entry.mode }
      case 'symlink':
        return { type: 'symlink', mode: entry.mode }
      case 'other':
        return { type: 'other', mode: entry.mode }
    }
  }

  private start(
    command: string,
    opts: ProcessOptions | undefined,
    stdin: boolean,
  ): Promise<ExecHandle> {
    opts?.signal?.throwIfAborted()
    const env = { ...this.envVars, ...opts?.env }
    return this.sandbox.execStreamWith('sh', (b) => {
      b.args(['-c', command]).cwd(opts?.cwd ? this.abs(opts.cwd) : this.workdir)
      if (Object.keys(env).length > 0) b.envs(env)
      return stdin ? b.stdinPipe() : b.stdinNull()
    })
  }

  /** Drain events until exit. A killed command reports exit code `-1`. */
  private async pump(
    handle: ExecHandle,
    onStdout: (data: Uint8Array) => void,
    onStderr: (data: Uint8Array) => void,
  ): Promise<number> {
    for await (const event of handle) {
      if (event.kind === 'stdout') onStdout(event.data)
      else if (event.kind === 'stderr') onStderr(event.data)
      else if (event.kind === 'exited') return event.code
    }
    throw new Error('microsandbox: exec session ended without an exit event')
  }

  private async exec(
    command: string,
    opts?: ProcessOptions,
  ): Promise<ExecResult> {
    const handle = await this.start(command, opts, false)
    const onAbort = (): void => {
      void handle.kill().catch(() => undefined)
    }
    opts?.signal?.addEventListener('abort', onAbort, { once: true })
    // An abort that landed during the start round trip has no listener yet.
    if (opts?.signal?.aborted === true) onAbort()
    const stdout: Array<Uint8Array> = []
    const stderr: Array<Uint8Array> = []
    try {
      const exitCode = await this.pump(
        handle,
        (d) => stdout.push(d),
        (d) => stderr.push(d),
      )
      return {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode,
      }
    } finally {
      opts?.signal?.removeEventListener('abort', onAbort)
    }
  }

  private async spawnProcess(
    command: string,
    opts?: ProcessOptions,
  ): Promise<SpawnHandle> {
    const handle = await this.start(command, opts, true)
    // The SDK kill is a SIGKILL that also stops backgrounded children. Other
    // signals go to the `sh` process only.
    const kill = async (signal?: NodeJS.Signals | number): Promise<void> => {
      const n = signal === undefined ? 9 : guestSignal(signal)
      // A process that already exited makes the SDK reject; that is a no-op.
      await (n === 9 ? handle.kill() : handle.signal(n)).catch(() => undefined)
    }
    const onAbort = (): void => {
      void kill()
    }
    opts?.signal?.addEventListener('abort', onAbort, { once: true })
    if (opts?.signal?.aborted === true) {
      onAbort()
      opts.signal.throwIfAborted()
    }

    const first = await handle.recv()
    const pid = first?.kind === 'started' ? first.pid : -1
    const stdin = await handle.takeStdin()
    // PassThrough with an encoding yields whole UTF-8 strings across chunk splits.
    const stdout = new PassThrough({ encoding: 'utf8' })
    const stderr = new PassThrough({ encoding: 'utf8' })

    const exit = this.pump(
      handle,
      (d) => stdout.write(d),
      (d) => stderr.write(d),
    ).finally(() => {
      opts?.signal?.removeEventListener('abort', onAbort)
      stdout.end()
      stderr.end()
    })
    exit.catch(() => undefined)

    return {
      pid,
      stdout,
      stderr,
      stdin: {
        write: async (data) => {
          await stdin?.write(data)
        },
        end: async () => {
          await stdin?.close()
        },
      },
      wait: () => exit,
      kill,
    }
  }

  snapshot = async (label?: string): Promise<SnapshotRef> => {
    // A disk snapshot of a running sandbox. It lives in the local snapshot
    // store and survives deletion of this sandbox.
    const record = await Sandbox.get(this.id)
    const snap = await record.snapshot(randomUUID())
    return { id: snap.id, ...(label !== undefined ? { label } : {}) }
  }

  fork = async (): Promise<SandboxHandle> => {
    if (this.forkWith === undefined)
      throw new UnsupportedCapabilityError(
        'microsandbox',
        'fork',
        'A live fork fails when the sandbox has a network policy (`allowHostAccess` or `network: deny`).',
      )
    const handle = await this.forkWith(
      this.sandbox,
      `${this.id}-fork-${randomUUID().slice(0, 8)}`,
    )
    // Per-command env lives on the handle, so mirror the overlay.
    await handle.env.set(this.envVars)
    return handle
  }

  async destroy(): Promise<void> {
    await this.sandbox.destroy({ force: true })
  }
}
