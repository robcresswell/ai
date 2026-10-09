import { spawnSync } from 'node:child_process'
import { expect, test } from '@playwright/test'

test('microsandbox create cleans up an aborted startup in the built package', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import assert from 'node:assert/strict'
        import { createRequire } from 'node:module'
        import { microsandboxSandbox } from './packages/ai-sandbox-microsandbox/dist/esm/index.js'

        // The same ESM module the built provider imports, so patching it reaches the provider.
        const require = createRequire(new URL('./packages/ai-sandbox-microsandbox/package.json', import.meta.url))
        const { Sandbox } = await import(require.resolve('microsandbox'))

        const controller = new AbortController()
        const reason = new Error('startup cancelled')
        const destroyed = []
        const builder = {
          image: () => builder,
          detached: () => builder,
          replace: () => builder,
          create: async () => {
            controller.abort(reason)
            return {
              name: 'sbx-1',
              fs: () => ({ mkdir: async () => undefined }),
              destroy: async () => { destroyed.push('sbx-1') },
            }
          },
        }
        Sandbox.builder = () => builder
        const result = microsandboxSandbox().create({ signal: controller.signal })
        await assert.rejects(result, (error) => error === reason)
        assert.deepEqual(destroyed, ['sbx-1'])
        console.log('create cancelled; sandbox destroyed')
      `,
    ],
    {
      cwd: new URL('../../../', import.meta.url),
      encoding: 'utf8',
      timeout: 20_000,
    },
  )

  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('create cancelled; sandbox destroyed')
})
