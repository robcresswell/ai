import { describe, expect, it, vi } from 'vitest'
import { MicrosandboxHandle } from '../src/handle'
import type { ExecEvent, FsEntry, Sandbox } from 'microsandbox'

const entry = (path: string, kind: FsEntry['kind'], mode: number): FsEntry => ({
  path,
  kind,
  mode,
  size: 3,
  modified: null,
})

const notFound = () =>
  new Error('sandbox fs error: list: No such file (os error 2)')

/** A fake guest with `/workspace/{a.txt, link, sub/}`. */
function fakeSandbox(events: Array<ExecEvent> = []) {
  const dirs: Record<string, Array<FsEntry>> = {
    '/': [entry('/workspace', 'directory', 0o40755)],
    '/workspace': [
      entry('/workspace/a.txt', 'file', 0o100644),
      entry('/workspace/link', 'symlink', 0o120777),
      entry('/workspace/sub', 'directory', 0o40755),
    ],
  }
  const fs = {
    list: vi.fn(async (p: string) => {
      const found = dirs[p]
      if (found === undefined) {
        if (p === '/workspace/a.txt')
          throw new Error(
            'sandbox fs error: list: Not a directory (os error 20)',
          )
        throw notFound()
      }
      return found
    }),
    mkdir: vi.fn(async () => undefined),
    write: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    removeDir: vi.fn(async () => undefined),
  }
  const kill = vi.fn(async () => undefined)
  const signal = vi.fn(async (_n: number) => undefined)
  const execStreamWith = vi.fn(async () => {
    const queue = [...events]
    return {
      kill,
      signal,
      recv: async () => queue.shift() ?? null,
      takeStdin: async () => null,
      async *[Symbol.asyncIterator]() {
        for (let e = queue.shift(); e; e = queue.shift()) yield e
      },
    }
  })
  // ponytail: only the members the handle touches are faked.
  const sandbox = { name: 'sbx', fs: () => fs, execStreamWith }
  return {
    sandbox: sandbox as unknown as Sandbox,
    fs,
    execStreamWith,
    kill,
    signal,
  }
}

function handle(fake: ReturnType<typeof fakeSandbox>) {
  return new MicrosandboxHandle({
    sandbox: fake.sandbox,
    workdir: '/workspace',
    ports: new Map([[8080, 41234]]),
  })
}

const text = (s: string) => new TextEncoder().encode(s)

describe('MicrosandboxHandle', () => {
  it('lstat reads the parent listing and never follows symlinks', async () => {
    const h = handle(fakeSandbox())
    expect(await h.fs.lstat!('/workspace/a.txt')).toEqual({
      type: 'file',
      mode: 0o100644,
      size: 3,
    })
    expect(await h.fs.lstat!('/workspace/link')).toEqual({
      type: 'symlink',
      mode: 0o120777,
    })
    expect(await h.fs.lstat!('/workspace/sub/')).toEqual({
      type: 'dir',
      mode: 0o40755,
    })
    expect(await h.fs.lstat!('/workspace/absent')).toBeUndefined()
    // The missing ancestor is confirmed by walking up.
    expect(await h.fs.lstat!('/workspace/absent/deeper')).toBeUndefined()
    // Below a file is an error, not "missing".
    await expect(h.fs.lstat!('/workspace/a.txt/below')).rejects.toThrow(
      /Not a directory/,
    )
  })

  it('write creates parents and remove picks file or directory', async () => {
    const fake = fakeSandbox()
    const h = handle(fake)
    await h.fs.write('/workspace/new/deep.txt', 'x')
    expect(fake.fs.mkdir).toHaveBeenCalledWith('/workspace/new')
    expect(fake.fs.write).toHaveBeenCalledWith('/workspace/new/deep.txt', 'x')

    await h.fs.remove('/workspace/sub')
    expect(fake.fs.removeDir).toHaveBeenCalledWith('/workspace/sub')
    await h.fs.remove('/workspace/a.txt')
    expect(fake.fs.remove).toHaveBeenCalledWith('/workspace/a.txt')
    await h.fs.remove('/workspace/absent')
    expect(fake.fs.remove).toHaveBeenCalledTimes(1)
  })

  it('connects published ports only', async () => {
    const h = handle(fakeSandbox())
    expect(await h.ports.connect(8080)).toEqual({
      url: 'http://127.0.0.1:41234',
    })
    await expect(h.ports.connect(3000)).rejects.toThrow(/not published/)
  })

  it('sends kill() as an SDK kill and other signals by Linux number', async () => {
    const fake = fakeSandbox([{ kind: 'started', pid: 7 }])
    const proc = await handle(fake).process.spawn('sleep 9')
    expect(proc.pid).toBe(7)
    await proc.kill()
    await proc.kill('SIGKILL')
    expect(fake.kill).toHaveBeenCalledTimes(2)
    await proc.kill('SIGTERM')
    await proc.kill('SIGUSR1')
    await proc.kill(2)
    expect(fake.signal.mock.calls).toEqual([[15], [10], [2]])
    await expect(proc.kill('SIGWINCH')).rejects.toThrow(/unsupported signal/)
  })

  it('reports fork as unsupported without a fork builder', async () => {
    const h = handle(fakeSandbox())
    expect(h.capabilities.fork).toBe(false)
    await expect(h.fork!()).rejects.toThrow(/does not support the "fork"/)
  })

  it('exec collects split streams and the exit code', async () => {
    const fake = fakeSandbox([
      { kind: 'started', pid: 7 },
      { kind: 'stdout', data: text('he') },
      { kind: 'stdout', data: text('llo\n') },
      { kind: 'stderr', data: text('oops\n') },
      { kind: 'exited', code: 3 },
    ])
    expect(await handle(fake).process.exec('x')).toEqual({
      stdout: 'hello\n',
      stderr: 'oops\n',
      exitCode: 3,
    })
  })

  it('exec rejects when the session ends without an exit event', async () => {
    const fake = fakeSandbox([{ kind: 'started', pid: 7 }])
    await expect(handle(fake).process.exec('x')).rejects.toThrow(
      /without an exit event/,
    )
  })
})
