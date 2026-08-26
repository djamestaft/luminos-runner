# Greg Windows foreground pilot

This guide installs the quickest Windows pilot under Greg's normal Windows
account. It is deliberately temporary: it does not create a broker account,
service, scheduled task, or immutable Program Files release. Use the separate
[Windows validation runner guide](windows-validation-runner-setup.md) for a
hardened validation host.

## Architecture and prerequisites

The pilot route is:

```text
VPS dispatcher
  -> Windows OpenSSH forced command
  -> protected pilot-proxy-command.ps1
  -> protected Windows named pipe
  -> foreground pilot broker in Greg's Herdr context
```

Required software is Node.js, Git, GitHub CLI, Herdr, Tailscale, and Windows
OpenSSH Server. Tailscale must be connected; `sshd` must be automatic and
running; TCP 22 must be restricted to the approved tailnet source. Clone the
runner into the fixed pilot path and fast-forward the approved branch:

```powershell
New-Item -ItemType Directory -Force C:\src | Out-Null
git clone https://github.com/djamestaft/luminos-runner C:\src\luminos-runner
git -C C:\src\luminos-runner fetch origin
git -C C:\src\luminos-runner switch feature/hermes-herdr-runner-pool
git -C C:\src\luminos-runner pull --ff-only
git -C C:\src\luminos-runner status --short --branch
```

Never discard local changes to make these commands succeed.

## Build and validation

From `C:\src\luminos-runner`, run:

```powershell
npm ci
npm run typecheck
npm test
npm run services:check
npm audit --omit=dev
```

Stop on any failed check or unresolved production vulnerability. Confirm the
terminal has Greg's real Herdr context by listing variable names only:

```powershell
(Get-ChildItem Env: | Where-Object Name -Like 'HERDR_*').Name
herdr --version
```

If no Herdr names are present, do not copy or invent values. Open Greg's normal
Herdr-managed pane and continue there.

## Protected pilot paths and policy

Generate a new correlation for every launch and create a new root. Never reuse
an existing descriptor, ready file, state root, worktree root, or ambiguous
pilot directory.

```powershell
$Bytes = New-Object byte[] 16
$Rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $Rng.GetBytes($Bytes) } finally { $Rng.Dispose() }
$Correlation = ([BitConverter]::ToString($Bytes)).Replace('-', '').ToLowerInvariant()
$PilotRoot = "C:\ProgramData\Luminos\greg-pilot-$Correlation"
$PilotUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name

New-Item -ItemType Directory -Path $PilotRoot | Out-Null
icacls $PilotRoot /inheritance:r /grant:r `
  "${PilotUser}:(OI)(CI)F" `
  'BUILTIN\Administrators:(OI)(CI)F' `
  'NT AUTHORITY\SYSTEM:(OI)(CI)F'
New-Item -ItemType Directory -Path "$PilotRoot\state", "$PilotRoot\worktrees" | Out-Null
```

The root and every child must grant access only to Greg, Administrators, and
SYSTEM. Reject inherited or explicit access for Users, Authenticated Users, or
Everyone.

Use one approved project/profile only. Verify the LMNS origin and default/base
branch from an authoritative existing checkout or GitHub before creating a
dedicated clean clone; do not use an active personal checkout:

```powershell
git clone --branch <verified-base-branch> --single-branch `
  <verified-lmns-origin-url> "$PilotRoot\lmns-repo"
git -C "$PilotRoot\lmns-repo" remote get-url origin
git -C "$PilotRoot\lmns-repo" branch --show-current
git -C "$PilotRoot\lmns-repo" status --porcelain
```

Create `$PilotRoot\broker.env` from `.env.example`. Set exactly one project,
one profile, the verified repository URL/name/base branch, the dedicated clone,
`$PilotRoot\worktrees`, `$PilotRoot\state`, and
`$PilotRoot\github-token`. Obtain the GitHub token without placing it in chat or
shell history, for example from the authenticated GitHub CLI credential store:

```powershell
gh auth token | Set-Content -NoNewline -Encoding ascii -LiteralPath "$PilotRoot\github-token"
icacls "$PilotRoot\broker.env" /inheritance:r /grant:r `
  "${PilotUser}:F" 'BUILTIN\Administrators:F' 'NT AUTHORITY\SYSTEM:F'
icacls "$PilotRoot\github-token" /inheritance:r /grant:r `
  "${PilotUser}:F" 'BUILTIN\Administrators:F' 'NT AUTHORITY\SYSTEM:F'
```

Do not print the token, complete broker environment, or raw Herdr values.

Every job worktree must be freshly created and clean from that verified,
protected LMNS origin and base. This is also the security precondition for
unattended Codex startup: the runner passes both
`--dangerously-bypass-approvals-and-sandbox` and
`--dangerously-bypass-hook-trust` through Herdr. The latter suppresses only the
Codex hook/workspace trust confirmation for the invocation; it must never be
used for an arbitrary or active personal checkout. It does not bypass Codex
authentication or login failures.

Before sending task text, the runner requires two bounded live-agent and pane
process checks separated by a short stability interval. On Windows, Herdr may
legitimately keep Codex behind a `cmd.exe` wrapper, but a pane whose foreground
process has returned to PowerShell is rejected even when PowerShell's argv or
command line still mentions Codex. This check fails closed before constructing
or sending the task prompt.

## Start the foreground broker

In Greg's Herdr-managed normal-account pane, use direct argv execution and keep
the process in the foreground:

```powershell
$NodePath = 'C:\Program Files\nodejs\node.exe'
$RunnerRoot = 'C:\src\luminos-runner'
$PipeName = "\\.\pipe\luminos-greg-pilot-$Correlation"
$Descriptor = "$PilotRoot\pilot-descriptor.json"
$Ready = "$PilotRoot\pilot-ready"

& $NodePath "$RunnerRoot\dist\pilotBrokerServerMain.js" `
  --config "$PilotRoot\broker.env" `
  --pipe $PipeName `
  --descriptor $Descriptor `
  --ready $Ready
```

Success is a `pilot_ready` event and newly created, protected descriptor and
ready files. Do not print their contents. Leave this pane and process running.

The pipe uses separate bounded phases. Receiving and framing exactly one JSON
request has a 30-second timeout. After parsing, only an authoritative valid
`prompt_job` receives the command's `timeoutMs` plus 10 seconds of transport
grace, bounded between 30 seconds and the contract maximum plus that grace.
Invalid requests and every non-prompt command remain limited to 30 seconds.
The server resets the socket timer before broker execution; no phase is
unbounded.

## OpenSSH forced proxy

Determine Greg's exact lowercase Windows username and inspect the effective
configuration before editing. A later `Match Group administrators` commonly
redirects administrator keys to
`C:\ProgramData\ssh\administrators_authorized_keys`; an earlier specific
`Match User` can select a dedicated key file instead. Confirm with:

```powershell
$PilotName = $env:USERNAME.ToLowerInvariant()
& C:\Windows\System32\OpenSSH\sshd.exe -T `
  -C "user=$PilotName,host=localhost,addr=127.0.0.1"
```

Install the repository's `service\windows\pilot-proxy-command.ps1` as the sole
protected forced proxy. Its installed copy and the effective authorized-key
file must be writable only by Greg, Administrators, and SYSTEM. Add only the
VPS dispatcher public key; never request or transfer a private key.

Before editing `C:\ProgramData\ssh\sshd_config`, keep local console access and
make a timestamped backup. Add one marked `Match User` block using the actual
lowercase username and fresh descriptor path:

```text
Match User <greg-lowercase-windows-username>
    AuthorizedKeysFile C:/ProgramData/ssh/luminos-greg-pilot/authorized_keys
    AuthenticationMethods publickey
    PubkeyAuthentication yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    ForceCommand C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:/ProgramData/ssh/luminos-greg-pilot/pilot-proxy-command.ps1 -NodePath "C:/Program Files/nodejs/node.exe" -RunnerRoot C:/src/luminos-runner -PilotDescriptor C:/ProgramData/Luminos/greg-pilot-<correlation>/pilot-descriptor.json
    PermitOpen none
    PermitListen none
    DisableForwarding yes
    AllowTcpForwarding no
    AllowStreamLocalForwarding no
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    PermitTunnel no
```

Set `PermitUserEnvironment no` globally because Win32 OpenSSH does not accept it
inside a `Match` block. Validate the complete file before restarting only
`sshd`:

```powershell
$Stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')
$Backup = "C:\ProgramData\ssh\sshd_config.backup.$Stamp"
Copy-Item C:\ProgramData\ssh\sshd_config $Backup
& C:\Windows\System32\OpenSSH\sshd.exe -t -f C:\ProgramData\ssh\sshd_config
Restart-Service sshd
Get-Service sshd
```

If validation or restart fails, restore immediately using the rollback below.

## Read-only activation gate

Do not change `GREG_SSH_TARGET` yet. From the VPS dispatcher environment, run
this exact multiline command; every continuation backslash is required:

```sh
GREG_PILOT_JOB_ID="job_$(openssl rand -hex 16)"
printf '{"contractVersion":"2026-08-13","verb":"job_status","jobId":"%s"}\n' \
  "$GREG_PILOT_JOB_ID" | \
  timeout 40s ssh \
    -T \
    -o BatchMode=yes \
    -o ClearAllForwardings=yes \
    -o ForwardAgent=no \
    -o RequestTTY=no \
    -o ExitOnForwardFailure=yes \
    -o ConnectTimeout=10 \
    "$GREG_SSH_TARGET"
```

The expected unknown-job response is structured with the same contract version
and fresh job ID, `state` set to `refused`, and `category` set to `refused`.
Until that passes, do not run `create_job`, `prompt_job`, `recover_job`,
`handoff_job`, `close_job`, or a Discord task. After it passes, activate only
one fresh Discord pilot task and never reuse a preserved job ID.

If Discord reports `dispatcher_unknown` while Codex later finishes or commits,
the dispatcher probably lost the pipe response. Do not repeat the mutation or
reuse the job ID. Preserve the worktree, inspect only bounded sanitized broker
and Herdr status, and use the broker's recovery lifecycle. A missing/stale
descriptor, missing ready file, or stopped foreground process instead requires
a clean pilot restart and a new read-only gate before any further task.

## Stop and rollback

Press Ctrl+C in the foreground broker pane. The broker closes the pipe and
removes the descriptor and ready files it created. Verify no broker process
remains before removing any session-specific pilot directory.

For a safe upgrade or restart, stop the foreground broker first and confirm its
descriptor and ready files disappear. Rebuild the intended revision, create a
fresh correlation and protected pilot root, then relaunch with fresh pipe,
descriptor, and ready paths. If the descriptor path changes, back up
`sshd_config`, change only the forced-command descriptor argument, validate the
complete file with `sshd.exe -t`, and restart only `sshd`. Require a fresh
read-only `job_status` refusal before reopening the Discord activation gate.

To roll back SSH configuration from elevated PowerShell, use the exact backup
created immediately before activation:

```powershell
Copy-Item -LiteralPath '<exact-sshd-config-backup>' `
  -Destination C:\ProgramData\ssh\sshd_config -Force
& C:\Windows\System32\OpenSSH\sshd.exe -t -f C:\ProgramData\ssh\sshd_config
Restart-Service sshd
Get-Service sshd
```

If the pilot must be disabled without restoring unrelated later SSH edits,
remove only the marked Greg pilot `Match User` block, validate the complete
file, and restart only `sshd`. This procedure is a foreground pilot, not a
permanent Windows service deployment.
