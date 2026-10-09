import { beforeEach, describe, expect, it, vi } from 'vitest'
import { microsandboxSandbox } from '../src/index'

/**
 * A fake `microsandbox` SDK. Builders record their calls, and the sandbox they
 * produce stores a config the way the real runtime does: published ports, and
 * a network `policy` when the network was disabled or given a policy.
 */
const sdk = vi.hoisted(() => {
  class SandboxNotFoundError extends Error {}
  type Call = [string, ...Array<unknown>]

  const fakeSandbox = (name: string, calls: Array<Call> = []) => {
    const ports = calls
      .filter(([k]) => k === 'port')
      .map(([, hostPort, guestPort]) => ({ hostPort, guestPort }))
    const policy = calls.some(
      ([k]) => k === 'disableNetwork' || k === 'network',
    )
    const commandEnvs: Array<unknown> = []
    return {
      name,
      calls,
      commandEnvs,
      config: async () => ({
        network: { ports, ...(policy ? { policy: {} } : {}) },
      }),
      fs: () => ({ mkdir: async () => undefined }),
      destroy: vi.fn(async () => undefined),
      fork: vi.fn(async (child: string) => fakeSandbox(child)),
      execStreamWith: async (
        _cmd: string,
        configure: (
          b: Record<string, (...a: Array<unknown>) => unknown>,
        ) => unknown,
      ) => {
        const b = new Proxy(
          {} as Record<string, (...a: Array<unknown>) => unknown>,
          {
            get:
              (_t, k: string) =>
              (...args: Array<unknown>) => {
                if (k === 'envs') commandEnvs.push(args[0])
                return b
              },
          },
        )
        configure(b)
        const events = [{ kind: 'exited', code: 0 }]
        return {
          async *[Symbol.asyncIterator]() {
            yield* events
          },
        }
      },
    }
  }

  /** A builder that records every setter and ends in `terminal`. */
  const builder = (name: string, terminal: string) => {
    const calls: Array<Call> = []
    let made: ReturnType<typeof fakeSandbox> | undefined
    const b: Record<string, unknown> = new Proxy(
      {},
      {
        get: (_t, k: string) =>
          k === terminal
            ? async () => (made ??= fakeSandbox(name, calls))
            : (...args: Array<unknown>) => {
                calls.push([k, ...args])
                if (k === 'name') name = String(args[0])
                return b
              },
      },
    )
    return b
  }

  return {
    SandboxNotFoundError,
    fakeSandbox,
    get: vi.fn(),
    Sandbox: {
      builder: vi.fn((name: string) => builder(name, 'create')),
      restore: vi.fn(() => builder('', 'restore')),
      get: (name: string) => sdk.get(name),
    },
  }
})

vi.mock('microsandbox', () => ({
  Sandbox: sdk.Sandbox,
  SandboxNotFoundError: sdk.SandboxNotFoundError,
  NetworkPolicy: { fromProfiles: (profiles: Array<string>) => ({ profiles }) },
  MiB: (n: number) => n,
}))

type Fake = ReturnType<typeof sdk.fakeSandbox>
const created = async (index = 0): Promise<Fake> =>
  (await sdk.Sandbox.builder.mock.results[index]!.value.create()) as Fake
const deny = { default: 'allow', capabilities: { network: 'deny' } } as const

beforeEach(() => {
  vi.clearAllMocks()
})

describe('microsandboxSandbox', () => {
  it('replaces a same-name sandbox and keeps env off the sandbox config', async () => {
    const sbx = await microsandboxSandbox({ ports: [3000] }).create({
      id: 'key-1',
      env: { SECRET: 's' },
    })
    expect(sbx.id).toBe('key-1')
    const calls = (await created()).calls.map(([k]) => k)
    expect(calls).toContain('replace')
    expect(calls).not.toContain('envs')

    const channel = await sbx.ports.connect(3000)
    expect(channel.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(sbx.capabilities.fork).toBe(true)
  })

  it('passes the env overlay to every command', async () => {
    const sbx = await microsandboxSandbox().create({ env: { SECRET: 's' } })
    await sbx.process.exec('true', { env: { EXTRA: 'e' } })
    expect((await created()).commandEnvs).toEqual([{ SECRET: 's', EXTRA: 'e' }])
  })

  it('disables the network and fork under a deny policy', async () => {
    const sbx = await microsandboxSandbox().create({ policy: deny })
    expect((await created()).calls.map(([k]) => k)).toContain('disableNetwork')
    expect(sbx.capabilities.fork).toBe(false)
    await expect(sbx.fork!()).rejects.toThrow(/does not support the "fork"/)
  })

  it('reports no fork with allowHostAccess', async () => {
    const provider = microsandboxSandbox({ allowHostAccess: true })
    expect(provider.capabilities().fork).toBe(false)
    const sbx = await provider.create({})
    expect((await created()).calls.map(([k]) => k)).toContain('network')
    expect(sbx.capabilities.fork).toBe(false)
  })

  it('forks without published ports and mirrors the env overlay', async () => {
    const sbx = await microsandboxSandbox({ ports: [3000] }).create({
      env: { SECRET: 's' },
    })
    const child = await sbx.fork!()
    expect(child.id).toMatch(/-fork-/)
    await expect(child.ports.connect(3000)).rejects.toThrow(/A fork has none/)
  })

  it('restores with new port bindings, the policy, and the env', async () => {
    const sbx = await microsandboxSandbox({ ports: [3000] }).restoreSnapshot!({
      snapshotId: 'snap-1',
      policy: deny,
      env: { SECRET: 's' },
    })
    const restore = sdk.Sandbox.restore.mock.results[0]!.value as {
      restore: () => Promise<Fake>
    }
    const calls = (await restore.restore()).calls.map(([k]) => k)
    expect(calls).toEqual(
      expect.arrayContaining(['name', 'disableNetwork', 'port']),
    )
    expect(sdk.Sandbox.restore).toHaveBeenCalledWith('snap-1')
    expect((await sbx.ports.connect(3000)).url).toMatch(/127\.0\.0\.1/)
    expect(sbx.capabilities.fork).toBe(false)
  })

  it('resumes to null only for a missing sandbox', async () => {
    const provider = microsandboxSandbox()
    sdk.get.mockRejectedValueOnce(new sdk.SandboxNotFoundError('gone'))
    expect(await provider.resume({ id: 'x' })).toBeNull()

    sdk.get.mockRejectedValueOnce(new Error('database locked'))
    await expect(provider.resume({ id: 'x' })).rejects.toThrow(/database/)

    const live = sdk.fakeSandbox('x', [['port', 41000, 3000]])
    sdk.get.mockResolvedValueOnce({ connectOrStart: async () => live })
    const resumed = await provider.resume({ id: 'x' })
    expect((await resumed!.ports.connect(3000)).url).toBe(
      'http://127.0.0.1:41000',
    )
  })

  it('treats destroying a missing sandbox as success', async () => {
    const provider = microsandboxSandbox()
    sdk.get.mockRejectedValueOnce(new sdk.SandboxNotFoundError('gone'))
    await expect(provider.destroy({ id: 'x' })).resolves.toBeUndefined()

    sdk.get.mockRejectedValueOnce(new Error('database locked'))
    await expect(provider.destroy({ id: 'x' })).rejects.toThrow(/database/)
  })
})
