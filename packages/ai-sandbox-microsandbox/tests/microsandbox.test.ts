import { createServer } from 'node:http'
import { Snapshot } from 'microsandbox'
import { describe, expect, it } from 'vitest'
import { microsandboxSandbox } from '../src/index'
import type { SandboxCreateInput, SandboxHandle } from '@tanstack/ai-sandbox'

// Opt-in: these tests boot real microVMs on this host. They need Linux with
// KVM, macOS on Apple Silicon, or Windows with WHP.
const live = process.env.MICROSANDBOX_LIVE === '1'

async function withSandbox(
  fn: (sbx: SandboxHandle) => Promise<void>,
  input: SandboxCreateInput = {},
): Promise<void> {
  const sbx = await microsandboxSandbox({ image: 'node:22-slim' }).create(input)
  try {
    await fn(sbx)
  } finally {
    await sbx.destroy()
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!live)('microsandbox provider (MICROSANDBOX_LIVE=1)', () => {
  it(
    'runs exec and round-trips the filesystem',
    () =>
      withSandbox(async (sbx) => {
        const echo = await sbx.process.exec('echo hello-msb; pwd')
        expect(echo).toEqual({
          stdout: 'hello-msb\n/workspace\n',
          stderr: '',
          exitCode: 0,
        })

        const failed = await sbx.process.exec('echo nope >&2; exit 7')
        expect(failed.exitCode).toBe(7)
        expect(failed.stderr).toBe('nope\n')

        await sbx.env.set({ BASE_VAR: 'base' })
        const env = await sbx.process.exec('echo "$BASE_VAR:$EXTRA_VAR"', {
          env: { EXTRA_VAR: 'extra' },
        })
        expect(env.stdout).toBe('base:extra\n')

        await sbx.fs.write('/workspace/nested/note.txt', 'inside msb')
        expect(await sbx.fs.read('/workspace/nested/note.txt')).toBe(
          'inside msb',
        )
        expect(await sbx.fs.lstat!('/workspace/nested/note.txt')).toMatchObject(
          {
            type: 'file',
            size: 10,
          },
        )
        expect(await sbx.fs.lstat!('/workspace/nested')).toMatchObject({
          type: 'dir',
        })
        expect(await sbx.fs.lstat!('/workspace/absent')).toBeUndefined()
        expect(await sbx.fs.lstat!('/workspace/absent/deeper')).toBeUndefined()
        await expect(
          sbx.fs.lstat!('/workspace/nested/note.txt/below'),
        ).rejects.toThrow()

        await sbx.process.exec('ln -s /nope /workspace/dangling')
        expect(await sbx.fs.lstat!('/workspace/dangling')).toMatchObject({
          type: 'symlink',
        })

        const bytes = new Uint8Array([0, 1, 2, 250])
        await sbx.fs.write('/workspace/bin', bytes)
        expect(Array.from(await sbx.fs.readBytes('/workspace/bin'))).toEqual([
          0, 1, 2, 250,
        ])

        expect(await sbx.fs.list('/workspace')).toEqual(
          expect.arrayContaining([
            { name: 'nested', path: '/workspace/nested', type: 'dir' },
            { name: 'bin', path: '/workspace/bin', type: 'file' },
          ]),
        )
        await sbx.fs.rename('/workspace/bin', '/workspace/bin2')
        expect(await sbx.fs.exists('/workspace/bin')).toBe(false)
        await sbx.fs.remove('/workspace/nested')
        expect(await sbx.fs.exists('/workspace/nested')).toBe(false)
        await sbx.fs.remove('/workspace/nested')

        const split = await sbx.process.spawn('echo to-out; echo to-err >&2')
        expect(split.pid).toBeGreaterThan(0)
        let out = ''
        let err = ''
        await Promise.all([
          (async () => {
            for await (const c of split.stdout) out += c
          })(),
          (async () => {
            for await (const c of split.stderr) err += c
          })(),
        ])
        expect(await split.wait()).toBe(0)
        expect(out).toBe('to-out\n')
        expect(err).toBe('to-err\n')
      }),
    120_000,
  )

  // MEASURES writableStdin: `cat` only exits if stdin really closes.
  it(
    'feeds a spawned process over stdin and closes it',
    () =>
      withSandbox(async (sbx) => {
        const proc = await sbx.process.spawn('cat')
        await proc.stdin.write('fed-over-stdin\n')
        await proc.stdin.end()
        let out = ''
        for await (const chunk of proc.stdout) out += chunk
        expect(out).toBe('fed-over-stdin\n')
        expect(await proc.wait()).toBe(0)
      }),
    120_000,
  )

  // MEASURES killableProcesses, including a backgrounded child.
  it(
    'kill() and abort terminate the process inside the guest',
    () =>
      withSandbox(async (sbx) => {
        const proc = await sbx.process.spawn(
          '(sleep 3 && touch /workspace/survived) & wait',
        )
        await proc.kill()
        expect(await proc.wait()).not.toBe(0)

        const controller = new AbortController()
        const pending = sbx.process.exec(
          'sleep 3 && touch /workspace/survived-abort',
          { signal: controller.signal },
        )
        await sleep(300)
        controller.abort()
        expect((await pending).exitCode).not.toBe(0)

        await sleep(4000)
        expect(await sbx.fs.exists('/workspace/survived')).toBe(false)
        expect(await sbx.fs.exists('/workspace/survived-abort')).toBe(false)

        const trapped = await sbx.process.spawn(
          "trap 'exit 3' TERM; while :; do sleep 0.1; done",
        )
        await sleep(300)
        await trapped.kill('SIGTERM')
        expect(await trapped.wait()).toBe(3)
      }),
    120_000,
  )

  it('resumes by id, snapshots, restores, forks, and destroys', async () => {
    const provider = microsandboxSandbox({
      image: 'node:22-slim',
      ports: [8080],
    })
    const created: Array<SandboxHandle> = []
    let snapshotId: string | undefined
    try {
      const sbx = await provider.create({ env: { FROM_CREATE: 'yes' } })
      created.push(sbx)
      await sbx.fs.write('/workspace/state.txt', 'kept')
      expect((await sbx.process.exec('echo $FROM_CREATE')).stdout).toBe('yes\n')

      await sbx.process.exec(
        `nohup node -e "require('http').createServer((q,s)=>s.end('pong')).listen(8080)" >/dev/null 2>&1 &`,
      )
      await sleep(1000)
      const channel = await sbx.ports.connect(8080)
      expect(await fetch(channel.url).then((r) => r.text())).toBe('pong')
      await expect(sbx.ports.connect(9999)).rejects.toThrow(/not published/)

      const resumed = await provider.resume({ id: sbx.id })
      expect(resumed).not.toBeNull()
      expect(await resumed!.fs.read('/workspace/state.txt')).toBe('kept')
      expect((await resumed!.ports.connect(8080)).url).toBe(channel.url)

      const forked = await sbx.fork!()
      created.push(forked)
      expect(forked.id).not.toBe(sbx.id)
      expect(await forked.fs.read('/workspace/state.txt')).toBe('kept')
      // The env overlay is mirrored; a fork has no published ports.
      expect((await forked.process.exec('echo $FROM_CREATE')).stdout).toBe(
        'yes\n',
      )
      await expect(forked.ports.connect(8080)).rejects.toThrow(
        /A fork has none/,
      )

      const snap = await sbx.snapshot!('after-setup')
      snapshotId = snap.id
      expect(snap.label).toBe('after-setup')
      await sbx.destroy()
      expect(await provider.resume({ id: sbx.id })).toBeNull()
      await provider.destroy({ id: sbx.id })

      const restored = await provider.restoreSnapshot!({
        snapshotId: snap.id,
        env: { FROM_RESTORE: 'yes' },
      })
      created.push(restored)
      expect(await restored.fs.read('/workspace/state.txt')).toBe('kept')
      expect((await restored.process.exec('echo $FROM_RESTORE')).stdout).toBe(
        'yes\n',
      )
      expect((await restored.ports.connect(8080)).url).not.toBe(channel.url)
    } finally {
      for (const h of created) await h.destroy().catch(() => undefined)
      // The contract has no snapshot delete hook.
      if (snapshotId !== undefined)
        await Snapshot.remove(snapshotId, { force: true })
    }
  }, 180_000)

  it('replaces a leftover sandbox with the same id', async () => {
    const provider = microsandboxSandbox({ image: 'node:22-slim' })
    const id = `tsai-replace-${Date.now()}`
    const first = await provider.create({ id })
    try {
      await first.fs.write('/workspace/old.txt', 'old')
      // An empty instance store after a restart creates under the same id.
      const second = await provider.create({ id })
      expect(second.id).toBe(id)
      expect(await second.fs.exists('/workspace/old.txt')).toBe(false)
    } finally {
      await provider.destroy({ id })
    }
  }, 120_000)

  it(
    'blocks outbound network under a deny policy',
    () =>
      withSandbox(
        async (sbx) => {
          const r = await sbx.process.exec(
            `node -e "fetch('https://example.com').then(()=>console.log('open'),()=>console.log('blocked'))"`,
          )
          expect(r.stdout).toBe('blocked\n')
          expect(sbx.capabilities.fork).toBe(false)
          await expect(sbx.fork!()).rejects.toThrow(
            /does not support the "fork"/,
          )
        },
        { policy: { default: 'allow', capabilities: { network: 'deny' } } },
      ),
    120_000,
  )

  it('reaches host loopback with allowHostAccess', async () => {
    const server = createServer((_req, res) => res.end('host-pong'))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const address = server.address()
    const port =
      typeof address === 'object' && address !== null ? address.port : 0
    const sbx = await microsandboxSandbox({
      image: 'node:22-slim',
      allowHostAccess: true,
    }).create({})
    try {
      const r = await sbx.process.exec(
        `node -e "fetch('http://host.microsandbox.internal:${port}').then(r=>r.text()).then(console.log)"`,
      )
      expect(r.stdout).toBe('host-pong\n')
      expect(sbx.capabilities.fork).toBe(false)
    } finally {
      await sbx.destroy()
      server.close()
    }
  }, 120_000)
})
