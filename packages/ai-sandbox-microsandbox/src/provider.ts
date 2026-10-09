import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { MiB, NetworkPolicy, Sandbox, SandboxNotFoundError } from 'microsandbox'
import {
  DEFAULT_WORKDIR,
  MICROSANDBOX_CAPS,
  MicrosandboxHandle,
} from './handle'
import type {
  SandboxCapabilities,
  SandboxCreateInput,
  SandboxDestroyInput,
  SandboxHandle,
  SandboxPolicy,
  SandboxProvider,
  SandboxRestoreInput,
  SandboxResumeInput,
} from '@tanstack/ai-sandbox'

export interface MicrosandboxSandboxConfig {
  /** OCI image the guest boots from. Defaults to `node:24`. */
  image?: string
  /** Guest vCPUs. Defaults to the microsandbox default. */
  cpus?: number
  /** Guest memory in MiB. Defaults to the microsandbox default. */
  memoryMiB?: number
  /**
   * Working directory inside the guest. The `/workspace` virtual root maps
   * here. Defaults to `/workspace`.
   */
  workdir?: string
  /**
   * Guest TCP ports to publish. Each one gets a free host port on
   * `127.0.0.1`, and `ports.connect(port)` returns its URL. microsandbox
   * publishes ports at create time only.
   */
  ports?: Array<number>
  /**
   * Let the guest reach services on this host's loopback at
   * `host.microsandbox.internal`. Bridged tools need this. Off by default,
   * because the guest can then reach every loopback service on the host.
   */
  allowHostAccess?: boolean
}

const DEFAULT_IMAGE = 'node:24'

/** The default public egress, plus the host's loopback. */
const HOST_ACCESS = NetworkPolicy.fromProfiles(['public', 'host'])

/** A free TCP port on 127.0.0.1. */
function freePort(): Promise<number> {
  // ponytail: the port could be taken between close and VM boot; retry create if that ever bites.
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address !== null && typeof address === 'object')
          resolve(address.port)
        else reject(new Error('microsandbox: no free host port'))
      })
    })
  })
}

/**
 * Read a sandbox's stored config back: its published TCP ports, and whether a
 * live fork works. A fork does not inherit published ports.
 */
async function inspect(
  sandbox: Sandbox,
): Promise<{ ports: Map<number, number>; forkable: boolean }> {
  const config = await sandbox.config()
  const network: unknown = config.network
  const map = new Map<number, number>()
  if (typeof network !== 'object' || network === null)
    return { ports: map, forkable: true }
  // ponytail: measured on 0.7.7, a fork rejects every source whose config has
  // a network policy (`disableNetwork()` and the host profile both write one).
  // Revisit if `fork()` gains resource bindings.
  const forkable = !('policy' in network) || network.policy == null
  const ports = 'ports' in network ? network.ports : undefined
  if (!Array.isArray(ports)) return { ports: map, forkable }
  for (const port of ports) {
    if (
      typeof port === 'object' &&
      port !== null &&
      'guestPort' in port &&
      'hostPort' in port &&
      typeof port.guestPort === 'number' &&
      typeof port.hostPort === 'number'
    )
      map.set(port.guestPort, port.hostPort)
  }
  return { ports: map, forkable }
}

class MicrosandboxProvider implements SandboxProvider {
  readonly name = 'microsandbox'

  constructor(private readonly config: MicrosandboxSandboxConfig) {}

  capabilities(): SandboxCapabilities {
    // A `deny` policy also rules out fork, but it is known only per create.
    return { ...MICROSANDBOX_CAPS, fork: this.config.allowHostAccess !== true }
  }

  private get workdir(): string {
    return this.config.workdir ?? DEFAULT_WORKDIR
  }

  private async allocatePorts(): Promise<Map<number, number>> {
    const map = new Map<number, number>()
    for (const guest of this.config.ports ?? [])
      map.set(guest, await freePort())
    return map
  }

  /**
   * `env` goes on the handle overlay, not into the sandbox config, so secrets
   * are never written to `~/.microsandbox`. `ensure()` sets them again after
   * resume.
   */
  private async handle(
    sandbox: Sandbox,
    env?: Record<string, string>,
  ): Promise<SandboxHandle> {
    const { ports, forkable } = await inspect(sandbox)
    const handle = new MicrosandboxHandle({
      sandbox,
      workdir: this.workdir,
      ports,
      ...(forkable
        ? {
            fork: async (parent: Sandbox, name: string) =>
              this.handle(await parent.fork(name)),
          }
        : {}),
    })
    if (env !== undefined) await handle.env.set(env)
    return handle
  }

  /**
   * A fresh guest has no workdir yet, and every command runs in it. Any
   * failure, or an abort that landed meanwhile, destroys the sandbox.
   */
  private async prepare(
    sandbox: Sandbox,
    signal: AbortSignal | undefined,
    env?: Record<string, string>,
  ): Promise<SandboxHandle> {
    try {
      signal?.throwIfAborted()
      await sandbox.fs().mkdir(this.workdir)
      const handle = await this.handle(sandbox, env)
      signal?.throwIfAborted()
      return handle
    } catch (error) {
      await sandbox.destroy({ force: true }).catch(() => undefined)
      throw error
    }
  }

  async create(input: SandboxCreateInput): Promise<SandboxHandle> {
    input.signal?.throwIfAborted()
    const ports = await this.allocatePorts()
    const builder = Sandbox.builder(input.id ?? `tsai-${randomUUID()}`)
      .image(this.config.image ?? DEFAULT_IMAGE)
      // Detached so the VM outlives this process and `resume` can find it.
      .detached(true)
      // `ensure()` creates under a deterministic id when it has no live record
      // (empty store after a restart, `snapshotMaxAge`, a crash mid-bootstrap).
      // A detached VM with that name can still exist, so replace it.
      .replace()
    if (this.config.cpus !== undefined) builder.cpus(this.config.cpus)
    if (this.config.memoryMiB !== undefined)
      builder.memory(MiB(this.config.memoryMiB))
    if (denyNetwork(input.policy)) builder.disableNetwork()
    else if (this.config.allowHostAccess === true)
      builder.network((n) => n.policy(HOST_ACCESS))
    for (const [guest, host] of ports) builder.port(host, guest)
    return this.prepare(await builder.create(), input.signal, input.env)
  }

  async restoreSnapshot(input: SandboxRestoreInput): Promise<SandboxHandle> {
    input.signal?.throwIfAborted()
    const ports = await this.allocatePorts()
    const builder = Sandbox.restore(input.snapshotId).name(
      `tsai-${randomUUID()}`,
    )
    if (this.config.cpus !== undefined) builder.cpus(this.config.cpus)
    if (this.config.memoryMiB !== undefined)
      builder.memory(MiB(this.config.memoryMiB))
    // A restore keeps neither the port bindings nor the network setting of the
    // source, so they are applied again here.
    if (denyNetwork(input.policy)) builder.disableNetwork()
    else if (this.config.allowHostAccess === true)
      builder.networkPolicy(HOST_ACCESS)
    for (const [guest, host] of ports) builder.port(host, guest)
    return this.prepare(await builder.restore(), input.signal, input.env)
  }

  async resume(input: SandboxResumeInput): Promise<SandboxHandle | null> {
    input.signal?.throwIfAborted()
    let record
    try {
      record = await Sandbox.get(input.id)
    } catch (error) {
      // Anything else (runtime missing, database error) must surface so
      // `ensure()` does not silently create a duplicate.
      if (error instanceof SandboxNotFoundError) return null
      throw error
    }
    // Starts a stopped sandbox; its disk is intact.
    const sandbox = await record.connectOrStart({ detached: true })
    return this.handle(sandbox)
  }

  async destroy(input: SandboxDestroyInput): Promise<void> {
    input.signal?.throwIfAborted()
    try {
      const record = await Sandbox.get(input.id)
      await record.destroy({ force: true })
    } catch (error) {
      // Already gone is success.
      if (!(error instanceof SandboxNotFoundError)) throw error
    }
  }
}

/** The contract's network gate is coarse: only an explicit deny maps. */
function denyNetwork(policy: SandboxPolicy | undefined): boolean {
  return policy?.capabilities?.network === 'deny'
}

/**
 * microsandbox provider — runs harness adapters inside libkrun microVMs on
 * this host through the uniform `SandboxHandle`. Needs Linux with KVM, macOS
 * on Apple Silicon, or Windows with WHP.
 */
export function microsandboxSandbox(
  config: MicrosandboxSandboxConfig = {},
): SandboxProvider {
  return new MicrosandboxProvider(config)
}
