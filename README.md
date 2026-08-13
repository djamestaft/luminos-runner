# LUMINOS Herdr host broker

This package is the only machine-side executor for the Hermes-native runner pool. It is not a Discord bot and has no inbound Discord, command-registration, slash-command, or static-pane route. The VPS coordinator sends the same versioned no-shell broker protocol to a constrained macOS or Windows SSH account; job content cannot choose a host, path, executable, credential, pane, or existing agent.

## Broker guarantees

- Loads logical project/profile mappings from a protected host-local file passed with `--config`.
- Checks the configured Git remote and base ref, serializes project/job mutations with persistent lock directories, and atomically writes a mode-0600 local registry.
- Creates a fresh `jobs/<opaque-id>` worktree and named Herdr agent with argv spawning and `shell: false`.
- Bounds process and protocol output and redacts secrets, credential URLs, and local paths.
- Never automatically repeats an uncertain mutation. Partial create, prompt, or handoff failures return `unknown` for operator reconciliation.
- Requires a clean worktree and at least one job commit before pushing exactly the job branch and opening a GitHub PR. It never merges.
- Supports read-only status/read, explicit recovery of `unknown`, idempotent handoff evidence, and closure only after coordinator policy permits it.
- Names new task workspaces `discord-<task-slug>-<short-id>` and, after authenticated PR closure, verifies the exact clean commit and remote branch before closing that workspace and removing only its registered worktree.

## Protected configuration

Copy `.env.example` to an out-of-repository protected location. On POSIX, the broker refuses a file accessible to group/other users. Only documented `BROKER_*` keys are accepted. GitHub and SSH credentials remain in the owning account's protected credential stores and are not protocol fields.

One-request constrained entry point:

```sh
node dist/brokerCommandMain.js --config /path/to/protected/broker.env
```

Persistent local stdin mode (not a network listener):

```sh
node dist/hostBrokerMain.js --config /path/to/protected/broker.env
```

`service/macos/forced-command.sh.example` plus `authorized_keys.example` is the Devon equivalent of the Windows `forced-command.ps1`/`sshd_config` model. Both reject `SSH_ORIGINAL_COMMAND`, TTYs, forwarding, tunnels, agent forwarding, user environment, and arbitrary executables. The macOS launchd template has `RunAtLoad=false` and `KeepAlive=false`; templates are not activation.

On Windows, first run `service/windows/test-runner.ps1` from elevated PowerShell. `install-runner.ps1` is validation-only unless `-Apply` is supplied; it checks the built broker files, required executables, and broad-write ACLs before registering `LuminosHerdrBroker`. The OpenSSH `ForceCommand`, dedicated non-administrator account, authorized key, tailnet policy, and VPS `GREG_SSH_TARGET` remain separate explicit gates.

## Validation

```sh
npm install
npm run typecheck
npm test
npm run services:check
npm audit --omit=dev
```

Live prerequisites remain operator-owned: dedicated restricted accounts/keys and host-key pinning; private-tailnet/firewall policy; admin-owned forced-command files; protected broker config and registry roots; approved project/profile maps; expected remotes/base refs; Herdr/Git/GitHub authentication; isolated worktree capacity; service dry run; and explicit activation/rollback approval. Do not start services, deploy, push, merge, or alter the preserved Herdr processes as part of local release-candidate validation.

The older Convex polling implementation remains in source as migration evidence behind `npm run legacy:start`; it is not a production route or fallback and must not be activated.
