<div align="center">
  <picture>
    <source
      media="(prefers-color-scheme: dark)"
      srcset="https://tanstack.com/api/readme/ai.png?theme=dark"
    />
    <source
      media="(prefers-color-scheme: light)"
      srcset="https://tanstack.com/api/readme/ai.png"
    />
    <img
      src="https://tanstack.com/api/readme/ai.png"
      alt="TanStack AI"
      width="900"
    />
  </picture>
</div>

<br />

# @tanstack/ai-sandbox-microsandbox

microsandbox provider for [TanStack AI](https://tanstack.com/ai). Runs harness
adapters inside [microsandbox](https://github.com/superradcompany/microsandbox)
microVMs on your own machine, through the uniform `SandboxHandle`. Each guest
has its own kernel. You do not need a cloud account or a Docker daemon.

## Requirements

- Node.js 22 or later.
- Linux with KVM, macOS on Apple Silicon, or Windows 11 with WHP (preview).
- Optional dependencies turned on. The `microsandbox` package installs the
  runtime for your platform as an optional dependency.

## Installation

```bash
npm install @tanstack/ai @tanstack/ai-sandbox @tanstack/ai-sandbox-microsandbox
```

## Usage

```ts
import {
  defineSandbox,
  defineWorkspace,
  githubRepo,
  withSandbox,
} from '@tanstack/ai-sandbox'
import { microsandboxSandbox } from '@tanstack/ai-sandbox-microsandbox'

const sandbox = defineSandbox({
  id: 'agent',
  provider: microsandboxSandbox({ image: 'node:24' }),
  workspace: defineWorkspace({
    source: githubRepo({ repo: 'owner/app' }),
    setup: ['npm install'],
  }),
})

// Then pass `withSandbox(sandbox)` as chat() middleware.
```

You can also use the provider directly:

```ts
import { microsandboxSandbox } from '@tanstack/ai-sandbox-microsandbox'

const provider = microsandboxSandbox({ ports: [3000] })
const sbx = await provider.create({})
try {
  await sbx.fs.write('/workspace/hello.txt', 'hello from microsandbox')
  console.log(await sbx.fs.read('/workspace/hello.txt'))

  const run = await sbx.process.exec('node --version')
  console.log('node', run.stdout.trim())

  const channel = await sbx.ports.connect(3000)
  console.log('preview url:', channel.url)
} finally {
  await sbx.destroy()
}
```

## Options

| Option            | Default      | Meaning                                                                                                            |
| ----------------- | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `image`           | `node:24`    | The OCI image that the guest boots from.                                                                           |
| `cpus`            | SDK default  | Guest vCPUs.                                                                                                       |
| `memoryMiB`       | SDK default  | Guest memory in MiB.                                                                                               |
| `workdir`         | `/workspace` | The guest directory that the `/workspace` root maps to.                                                            |
| `ports`           | none         | Guest TCP ports to publish. Each one gets a free port on `127.0.0.1`.                                              |
| `allowHostAccess` | `false`      | Lets the guest reach the host's loopback at `host.microsandbox.internal`. Bridged tools need it. Turns off `fork`. |

## Capabilities

| Capability          | Value  | Notes                                                                                                                           |
| ------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `fs`, `exec`, `env` | `true` | Native guest filesystem and exec. `env` is a handle overlay.                                                                    |
| `ports`             | `true` | Only the ports in `ports`. They are published at create.                                                                        |
| `writableStdin`     | `true` | `spawn()` gets a stdin pipe.                                                                                                    |
| `killableProcesses` | `true` | Measured. `kill()` sends `SIGKILL` and stops backgrounded children too. Other signals go to the command's shell only.           |
| `snapshots`         | `true` | Disk snapshots in the local store. They survive deletion of the source.                                                         |
| `networkPolicy`     | `true` | `network: 'deny'` turns the guest network off.                                                                                  |
| `durableFilesystem` | `true` | The disk is kept across stop and start, until `destroy()`.                                                                      |
| `fork`              | `true` | Native live fork with copy-on-write memory. A fork has no published ports. `false` with `allowHostAccess` or `network: 'deny'`. |

Sandboxes keep running after your process exits. Their state and snapshots
live in `~/.microsandbox` (or `MSB_HOME`). The `env` you pass at create stays
in memory on the handle and is not written there. The contract has no snapshot delete
hook, so remove old snapshots with `Snapshot.remove()` from the `microsandbox`
SDK.

## Tests

The live tests boot real microVMs, so they run only when you opt in:

```bash
MICROSANDBOX_LIVE=1 pnpm test:lib
```

See the [providers guide](https://tanstack.com/ai/latest/docs/sandbox/providers)
for how this provider compares with the others.
