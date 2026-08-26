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

Copy `.env.example` and `broker-projects.example.json` to separate
out-of-repository protected locations. `BROKER_PROJECTS_FILE` names the absolute
JSON registry containing every allowlisted project/profile mapping. Each entry
binds a logical project key to fixed absolute repository and worktree roots, an
exact GitHub repository/remote, one base branch, and an explicit profile list.
Unknown projects and profiles fail closed; protocol input can never provide a
path, remote, repository, branch, or executable.

The registry accepts at most 16 uniquely named projects. Repository and
worktree roots may not overlap. The expected remote URL must match the declared
GitHub repository, and the protected base ref is derived from the configured
remote and base branch. Do not place credentials in this registry.

On POSIX, the broker refuses a config, project registry, or GitHub token file
accessible to group/other users. On Windows, the install and forced-command
scripts reject token and project registry files accessible to broad principals
such as `Users`, `Authenticated Users`, or `Everyone`. Only documented
`BROKER_*` keys are accepted. `BROKER_GITHUB_TOKEN_FILE` names an absolute,
host-local file containing the GitHub CLI token; the runner loads it once and
exposes it only to `gh` subprocesses. GitHub and SSH credentials are never
protocol fields.

Existing one-project installations may continue using the legacy
`BROKER_PROJECT_KEY`, `BROKER_REPO_ROOT`, `BROKER_WORKTREE_ROOT`,
`BROKER_EXPECTED_REMOTE_URL`, `BROKER_GITHUB_REPO`, `BROKER_GIT_REMOTE`,
`BROKER_BASE_REF`, `BROKER_BASE_BRANCH`, and `BROKER_PROFILES` keys. A broker
configuration that mixes any legacy project key with `BROKER_PROJECTS_FILE` is
rejected as ambiguous.

## Read-only repository consultation

`queryCommandMain.js` is a separate, one-request consultation endpoint. It
accepts an opaque query id, one or two logical project keys, and a bounded
question. A separate protected source registry maps each key to a fixed local
directory and display label. It refuses unknown projects and invokes Codex directly in
the mapped directory with
`exec --sandbox read-only --ephemeral --dangerously-bypass-hook-trust --json`
and a minimal environment. The consultation path does not invoke Git, inspect a
remote, resolve a revision, create a worktree, branch, commit, push, PR, Herdr
agent, broker registry entry, or GitHub-token path. Its response identifies the
local source label and observation time.

Codex's filesystem read-only policy prevents writes but is not a per-directory
confidentiality boundary. `QUERY_EXPECTED_USERNAME` therefore binds the route
to the intended personal runner account, but the process retains that account's
normal file-read permissions. Consultation deliberately observes the current
local working copy, including any current local edits. The query child receives a minimal environment
and no broker GitHub token, but this is not OS-level directory confinement. Its
prompt also forbids reading `.git`, environment or credential files, user-profile
data, and paths outside the configured source roots.

Example protected query config:

```text
QUERY_SOURCES_FILE=C:\ProgramData\Luminos\query-sources.json
QUERY_EXPECTED_USERNAME=gregj
QUERY_CODEX_JS=C:\Users\gregj\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js
QUERY_TIMEOUT_MS=600000
```

The protected source file follows `query-sources.example.json`. It contains
only logical project keys, fixed absolute local roots, and display labels; it
has no Git remote, branch, revision, or worktree settings.

Greg's normal-account foreground pilot can serve implementation and query
requests over the same protected named-pipe proxy. The request shape selects
the fixed broker or query handler; it never selects an executable. SSH
commands, TTYs, forwarding, agent forwarding, tunnels, and user environment
remain refused.

One-request constrained entry point:

```sh
node dist/brokerCommandMain.js --config /path/to/protected/broker.env
```

Persistent local stdin mode (not a network listener):

```sh
node dist/hostBrokerMain.js --config /path/to/protected/broker.env
```

`service/macos/forced-command.sh.example` plus `authorized_keys.example` is the Devon equivalent of the Windows `forced-command.ps1`/`sshd_config` model. Both reject `SSH_ORIGINAL_COMMAND`, TTYs, forwarding, tunnels, agent forwarding, user environment, and arbitrary executables. The macOS launchd template has `RunAtLoad=false` and `KeepAlive=false`; templates are not activation.

On Windows, first run `service/windows/test-runner.ps1` from elevated PowerShell. `install-runner.ps1` is validation-only unless `-Apply` is supplied; it then copies a versioned release below `C:\Program Files\Luminos\releases` and makes it read-only to the broker account. OpenSSH invokes one forced-command request at a time—there is no persistent scheduled broker task. The dedicated non-administrator account, authorized key, tailnet policy, and VPS `GREG_SSH_TARGET` remain separate explicit gates.

For a validation machine that must remain separate from Greg's route, follow
[`docs/windows-validation-runner-setup.md`](docs/windows-validation-runner-setup.md).
The guide covers Tailscale plus Windows OpenSSH, the constrained broker user,
ACLs, immutable installation, forced-command validation, the read-only Herdr
launch-context A/B, and the explicit activation/rollback gates.

For Greg's temporary normal-account foreground pilot, follow
[`docs/windows-greg-pilot-setup.md`](docs/windows-greg-pilot-setup.md). It uses
a protected named pipe and OpenSSH forced proxy without creating a broker
account, Windows service, scheduled task, or immutable Program Files release.

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
