/**
 * Journal conformance for the microsandbox provider.
 *
 * NO `followUnsupported`: `killableProcesses` is `true`, so the follow cases RUN
 * when live tests are on and name-skip otherwise.
 */
import { runJournalConformance } from '@tanstack/ai-sandbox/testkit'

// Opt-in: these cases boot real microVMs on this host.
const live = process.env.MICROSANDBOX_LIVE === '1'

runJournalConformance({
  name: 'microsandbox',
  createHandle: async () => {
    // Lazy: the SDK loads a native binding at import, which fails on a host without one.
    const { microsandboxSandbox } = await import('../src/index')
    const handle = await microsandboxSandbox().create({})
    return { handle, dispose: () => handle.destroy() }
  },
  ...(live
    ? {}
    : {
        unsupported: {
          reason:
            'MICROSANDBOX_LIVE=1 is not set (needs KVM, Apple Silicon, or WHP)',
        },
      }),
})
