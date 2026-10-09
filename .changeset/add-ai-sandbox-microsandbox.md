---
'@tanstack/ai-sandbox-microsandbox': minor
'@tanstack/ai-sandbox': patch
---

Add `@tanstack/ai-sandbox-microsandbox`, a sandbox provider that runs
[microsandbox](https://github.com/superradcompany/microsandbox) microVMs on the
local host. It implements the full `SandboxProvider` / `SandboxHandle` contract,
including snapshots, fork, and resume-by-id. Set `allowHostAccess: true` so
bridged tools can reach the host. Needs Linux with KVM, macOS on Apple Silicon,
or Windows with WHP.
