# Windows validation runner setup

This guide installs a **validation-only** LUMINOS broker route on a Windows 11
machine. It keeps the validation host separate from Greg's runner and does not
change the gateway's `GREG_SSH_TARGET`.

The safe stopping point is a read-only `job_status` request through the forced
SSH route. Do not create a broker job until the Windows Herdr launch-context
investigation, reviewed runner validation, and deployment approval gates pass.

## Security model

The validation route must preserve these boundaries:

- Tailscale is the private network layer. Do not expose TCP 22 to the public
  internet or configure router port forwarding.
- Windows uses its native OpenSSH Server. Tailscale's built-in SSH server does
  not currently run on Windows destinations.
- SSH authenticates with a dedicated key stored on the VPS dispatcher. The
  private key never leaves the VPS.
- A dedicated local `luminos-broker` user owns the SSH session and is not an
  administrator.
- OpenSSH always invokes the reviewed forced-command script. It never provides
  an interactive shell, caller-selected command, TTY, forwarding, tunnel, or
  agent forwarding.
- The installed runner is an immutable versioned directory below
  `C:\Program Files\Luminos\releases` and is not writable by the broker user.
- Broker policy, registry, worktrees, and GitHub token use separate protected
  paths. Do not place secrets in this repository, Plane, Discord, shell history,
  or screenshots.
- The protected project mapping points to a dedicated validation clone, never a
  personal active checkout.

Current upstream references:

- [Get started with OpenSSH for Windows](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse)
- [OpenSSH Server configuration for Windows](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration)
- [OpenSSH key management for Windows](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement)
- [Tailscale SSH limitations](https://tailscale.com/docs/features/tailscale-ssh#limitations)

## Required access and software

You need:

1. Local console access to the Windows machine.
2. An elevated PowerShell window for installation and ACL work.
3. Tailnet administrator access or an operator who can approve the gateway to
   validation-host TCP 22 policy.
4. `Tailscale`, `OpenSSH Server`, Node.js 20 or newer, Git, GitHub CLI, Herdr,
   and the agent selected by `BROKER_AGENT_KIND`.
5. Access to the VPS as an administrator for creating a dedicated SSH key and
   client alias.
6. A dedicated LMNS validation clone and an approved GitHub credential. Do not
   reuse a personal working tree or copy Greg's token, key, configuration, or
   registry.

## Phase 1: record exact machine facts

Run these commands in **elevated PowerShell**. They are read-only.

```powershell
$PSVersionTable.PSVersion
Get-ComputerInfo | Select-Object WindowsProductName, WindowsVersion, OsBuildNumber
Get-Command node.exe, git.exe, gh.exe, herdr.exe -ErrorAction SilentlyContinue |
  Select-Object Name, Source
tailscale version
tailscale status
tailscale ip -4
```

Record the Windows Tailscale machine name and IP without putting credentials or
unredacted configuration in the issue. The gateway Tailscale IP must be taken
from the live gateway or tailnet console; do not infer it from this document.

Set session variables only after confirming their values:

```powershell
$BrokerUser = 'luminos-broker'
$GatewayTailscaleIp = Read-Host 'Exact VPS gateway Tailscale IPv4'
$WindowsTailscaleIp = (tailscale ip -4).Trim()

if (!$GatewayTailscaleIp -or !$WindowsTailscaleIp) {
  throw 'Both exact Tailscale addresses are required'
}
```

Do not enable `tailscale up --ssh` or `tailscale set --ssh` on Windows. Use
Windows OpenSSH over the tailnet instead.

## Phase 2: install Windows OpenSSH Server

Check the optional feature and install it if needed:

```powershell
Get-WindowsCapability -Online | Where-Object Name -Like 'OpenSSH*'

$Server = Get-WindowsCapability -Online |
  Where-Object Name -Like 'OpenSSH.Server*'

if ($Server.State -ne 'Installed') {
  Add-WindowsCapability -Online -Name $Server.Name
}

Set-Service -Name sshd -StartupType Automatic
Start-Service -Name sshd
Get-Service -Name sshd
```

Installing OpenSSH can create a broad inbound firewall rule. Disable that rule
and replace it with one scoped to the exact gateway Tailscale address and the
actual Tailscale adapter. First inspect the adapter instead of guessing its
name:

```powershell
Get-NetAdapter | Sort-Object Name | Format-Table Name, InterfaceDescription, Status
$TailscaleInterface = Read-Host 'Exact Tailscale interface name from Get-NetAdapter'

$DefaultRule = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' `
  -ErrorAction SilentlyContinue
if ($DefaultRule) {
  Disable-NetFirewallRule -Name $DefaultRule.Name
}

if (Get-NetFirewallRule -Name 'Luminos-OpenSSH-From-Gateway' `
    -ErrorAction SilentlyContinue) {
  throw 'Luminos firewall rule already exists; inspect it instead of replacing it'
}

New-NetFirewallRule `
  -Name 'Luminos-OpenSSH-From-Gateway' `
  -DisplayName 'LUMINOS OpenSSH from gateway over Tailscale' `
  -Enabled True `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort 22 `
  -RemoteAddress $GatewayTailscaleIp `
  -InterfaceAlias $TailscaleInterface

Get-NetFirewallRule -Name 'Luminos-OpenSSH-From-Gateway' |
  Get-NetFirewallAddressFilter
```

The tailnet access policy must independently allow only the approved gateway
identity to reach this validation host on TCP 22. Treat that as a separate
operator-owned gate.

## Phase 3: create the non-administrator broker account

Create a unique local account with a password entered interactively. Do not
reuse your Windows administrator account.

```powershell
if (Get-LocalUser -Name $BrokerUser -ErrorAction SilentlyContinue) {
  throw "$BrokerUser already exists; inspect it instead of replacing it"
}

$BrokerPassword = Read-Host "Local password for $BrokerUser" -AsSecureString
New-LocalUser `
  -Name $BrokerUser `
  -Password $BrokerPassword `
  -AccountNeverExpires `
  -PasswordNeverExpires:$false `
  -UserMayNotChangePassword:$false `
  -Description 'LUMINOS constrained validation broker'

$AdminMember = Get-LocalGroupMember -Group 'Administrators' |
  Where-Object Name -Match "\\$([regex]::Escape($BrokerUser))$"
if ($AdminMember) {
  throw 'The broker user must not be an administrator'
}
```

Sign into Windows locally as `luminos-broker` once so Windows creates its user
profile. Install or expose the required user-level Herdr and agent tooling in
that account, start Herdr normally, and keep one Herdr-managed pane open for the
read-only launch-context A/B. Do not copy Herdr environment values from another
user or machine.

After returning to the administrator account, confirm the profile exists:

```powershell
$BrokerHome = "C:\Users\$BrokerUser"
if (!(Test-Path -LiteralPath $BrokerHome -PathType Container)) {
  throw 'Broker profile is missing; sign in locally as the broker user once'
}
```

## Phase 4: create a dedicated VPS SSH key

On the VPS, create a new Ed25519 key exclusively for this Windows validation
route. Use an explicit versioned/key-specific path under the dispatcher's
protected SSH directory. Do not overwrite an existing key and do not reuse the
Mac or Greg key.

Before generating anything, inspect the dispatcher account, SSH directory, and
existing aliases. Then create the key under administrator control, grant the
dispatcher read access to the private key, and copy **only** the `.pub` content
to the Windows console. Never print or transfer the private key.

Create a separate SSH client alias such as
`devon-windows-validation-broker`. It should pin:

- the exact Windows Tailscale hostname or IP;
- user `luminos-broker`;
- the new dedicated identity file;
- a dedicated known-hosts file;
- `IdentitiesOnly yes`;
- `BatchMode yes`;
- forwarding disabled; and
- a bounded connection timeout.

Do not change `GREG_SSH_TARGET`, `DEVON_SSH_TARGET`, or the running dispatcher
environment during validation-host setup.

## Phase 5: install the public key on Windows

Paste the single approved VPS **public** key line into the non-admin user's
authorized-keys file. Do not put a private key on Windows.

```powershell
$BrokerIdentity = "$env:COMPUTERNAME\$BrokerUser"
$SshDirectory = Join-Path $BrokerHome '.ssh'
$AuthorizedKeys = Join-Path $SshDirectory 'authorized_keys'

New-Item -ItemType Directory -Path $SshDirectory -Force | Out-Null
New-Item -ItemType File -Path $AuthorizedKeys -Force | Out-Null

notepad.exe $AuthorizedKeys
```

After saving exactly one approved public key line, remove inherited permissions
and grant only the broker identity, local Administrators, and SYSTEM:

```powershell
icacls.exe $SshDirectory /inheritance:r |
  Out-Null
icacls.exe $SshDirectory /grant:r `
  "${BrokerIdentity}:(OI)(CI)F" `
  'BUILTIN\Administrators:(OI)(CI)F' `
  'NT AUTHORITY\SYSTEM:(OI)(CI)F' |
  Out-Null

icacls.exe $AuthorizedKeys /inheritance:r |
  Out-Null
icacls.exe $AuthorizedKeys /grant:r `
  "${BrokerIdentity}:R" `
  'BUILTIN\Administrators:F' `
  'NT AUTHORITY\SYSTEM:F' |
  Out-Null

icacls.exe $AuthorizedKeys
```

The broker user must remain outside the Administrators group so OpenSSH uses
`C:\Users\luminos-broker\.ssh\authorized_keys`, not the shared
`administrators_authorized_keys` file.

## Phase 6: prepare a dedicated validation clone and protected paths

Choose fresh, explicit paths. The following names are examples; inspect before
creating and do not reuse an existing directory:

```powershell
$SourceRoot = 'C:\src\luminos-runner'
$RepoRoot = 'C:\LuminosData\repos\lmns-validation'
$WorktreeRoot = 'C:\LuminosData\worktrees'
$StateRoot = 'C:\ProgramData\Luminos\state'
$ProtectedRoot = 'C:\ProgramData\Luminos\protected'
$ConfigPath = Join-Path $ProtectedRoot 'luminos-broker.env'
$TokenPath = Join-Path $ProtectedRoot 'github-token'
```

Requirements:

- `$SourceRoot` is this runner repository on
  `feature/hermes-herdr-runner-pool`.
- `$RepoRoot` is a dedicated clean LMNS clone with the approved `origin` and
  base branch. Do not point it at a personal checkout.
- `$WorktreeRoot` and `$StateRoot` are dedicated to this validation route.
- `$ProtectedRoot`, `$ConfigPath`, and `$TokenPath` are outside all Git repos.
- The broker user needs modify access to the dedicated repository, worktree,
  and state roots, but only read access to config and token files.

Create the runner source clone only if `$SourceRoot` is unused. Run this as the
Windows administrator account after `gh auth status` succeeds:

```powershell
if (Test-Path -LiteralPath $SourceRoot) {
  throw "Source path already exists; inspect it instead of overwriting it: $SourceRoot"
}

gh repo clone djamestaft/luminos-runner $SourceRoot -- `
  --branch feature/hermes-herdr-runner-pool `
  --single-branch

git -C $SourceRoot status --short
git -C $SourceRoot branch --show-current
git -C $SourceRoot remote -v
```

Stop if the branch or remote differs from the reviewed values. Provision the
separate LMNS validation clone through its own reviewed clone command; do not
use `$SourceRoot` as the broker project repository.

Create directories only after checking they do not already contain data. Apply
ACLs deliberately; do not use recursive broad grants on an existing tree.

```powershell
foreach ($Path in @($WorktreeRoot, $StateRoot)) {
  if (Test-Path -LiteralPath $Path) {
    throw "Path already exists; inspect before changing ACLs: $Path"
  }
  New-Item -ItemType Directory -Path $Path -Force | Out-Null
  icacls.exe $Path /inheritance:r | Out-Null
  icacls.exe $Path /grant:r `
    "${BrokerIdentity}:(OI)(CI)M" `
    'BUILTIN\Administrators:(OI)(CI)F' `
    'NT AUTHORITY\SYSTEM:(OI)(CI)F' |
    Out-Null
}
```

Provision the GitHub token through an approved secret-handling method. The file
must contain one token only, with no whitespace, and must be readable but not
writable by the broker user. Never paste the token into a command shown in
terminal history.

```powershell
icacls.exe $ProtectedRoot /inheritance:r | Out-Null
icacls.exe $ProtectedRoot /grant:r `
  "${BrokerIdentity}:(OI)(CI)RX" `
  'BUILTIN\Administrators:(OI)(CI)F' `
  'NT AUTHORITY\SYSTEM:(OI)(CI)F' |
  Out-Null

icacls.exe $ConfigPath /inheritance:r | Out-Null
icacls.exe $ConfigPath /grant:r `
  "${BrokerIdentity}:R" `
  'BUILTIN\Administrators:F' `
  'NT AUTHORITY\SYSTEM:F' |
  Out-Null

icacls.exe $TokenPath /inheritance:r | Out-Null
icacls.exe $TokenPath /grant:r `
  "${BrokerIdentity}:R" `
  'BUILTIN\Administrators:F' `
  'NT AUTHORITY\SYSTEM:F' |
  Out-Null
```

Build the protected configuration from `.env.example`. Use the exact result of
`git -C $RepoRoot remote get-url origin` for
`BROKER_EXPECTED_REMOTE_URL`; do not normalize or guess it. Windows paths may
use backslashes. Omit `BROKER_SHELL_ZDOTDIR` unless a reviewed Windows design
requires it.

Never print the complete protected configuration after it contains real paths
or credential locations.

## Phase 7: validate and install an immutable runner release

In elevated PowerShell, verify the runner source before building:

```powershell
Set-Location -LiteralPath $SourceRoot
git status --short
git branch --show-current
git rev-parse HEAD
git fetch --prune origin
git rev-parse '@{upstream}'

npm ci
npm run typecheck
npm test
npm run services:check
npm audit --omit=dev
```

Stop if tracked files are dirty, the branch or revision is unexpected, tests
fail, or audit reports unresolved production vulnerabilities.

Resolve the exact executable and versioned install path:

```powershell
$NodePath = (Get-Command node.exe -ErrorAction Stop).Source
$Revision = (git rev-parse --short=7 HEAD).Trim()
$InstallRoot = "C:\Program Files\Luminos\releases\$Revision"
```

Run the repository validation wrapper first. It is validation-only unless the
separate installer receives `-Apply`:

```powershell
& (Join-Path $SourceRoot 'service/windows/test-runner.ps1') `
  -NodePath $NodePath `
  -SourceRoot $SourceRoot `
  -InstallRoot $InstallRoot `
  -ConfigPath $ConfigPath `
  -BrokerUser $BrokerUser
```

Review the source revision and output. Then install only after explicit approval:

```powershell
& (Join-Path $SourceRoot 'service/windows/install-runner.ps1') `
  -NodePath $NodePath `
  -SourceRoot $SourceRoot `
  -InstallRoot $InstallRoot `
  -ConfigPath $ConfigPath `
  -BrokerUser $BrokerUser `
  -Apply
```

The installer refuses an existing version directory and verifies that the
broker user cannot write the installed release. Retain the prior versioned
release for rollback.

## Phase 8: configure the forced OpenSSH route

Back up `C:\ProgramData\ssh\sshd_config` before editing. Do not activate a
template with symbolic paths. The `ForceCommand` must reference the exact
versioned installed release, Node executable, and protected config.

Start with [`service/windows/sshd_config.snippet.example`](../service/windows/sshd_config.snippet.example)
and replace every symbolic path. Keep quotes around every path containing a
space. Add explicit public-key-only authentication for the broker match. Keep
the broker user name lowercase.

The completed match must have this shape, with `<REVISION>` replaced by the
installed revision and all paths verified locally. Preserve the forwarding and
environment restrictions from the repository template:

```text
Match User luminos-broker
    AuthorizedKeysFile C:/Users/luminos-broker/.ssh/authorized_keys
    PubkeyAuthentication yes
    AuthenticationMethods publickey
    PasswordAuthentication no
    ForceCommand powershell.exe -NoProfile -NonInteractive -File "C:/Program Files/Luminos/releases/<REVISION>/service/windows/forced-command.ps1" -NodePath "C:/Program Files/nodejs/node.exe" -RunnerRoot "C:/Program Files/Luminos/releases/<REVISION>" -ConfigPath "C:/ProgramData/Luminos/protected/luminos-broker.env"
    DisableForwarding yes
    AllowTcpForwarding no
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    PermitTunnel no
    PermitUserEnvironment no
```

`ForceCommand` on Windows must be paired with `PermitTTY no`; do not test this
route with an interactive shell. If Node or the protected config is installed
elsewhere, use its exact absolute path rather than copying the example.

Windows OpenSSH builds differ in supported directives. Do not delete a security
constraint merely to make parsing pass. Validate the complete configuration
using the installed daemon:

```powershell
$Sshd = Join-Path $env:WINDIR 'System32\OpenSSH\sshd.exe'
& $Sshd -t -f 'C:\ProgramData\ssh\sshd_config'
if ($LASTEXITCODE -ne 0) {
  throw 'sshd_config validation failed; restore the backup and review the exact directive'
}
```

Only after validation succeeds and the local console remains available:

```powershell
Restart-Service -Name sshd
Get-Service -Name sshd
Get-NetTCPConnection -State Listen -LocalPort 22
```

## Phase 9: connectivity and forced-command checks

From the VPS, keep the dispatcher and its configured routes unchanged. Verify
the separate validation alias:

1. `ssh -G devon-windows-validation-broker` resolves the expected user,
   Tailscale host, key, and known-hosts file.
2. Tailscale reaches the validation host.
3. TCP 22 is reachable from the gateway and not from unapproved tailnet nodes.
4. A normal remote command and TTY request are refused.
5. A single broker JSON request reaches the forced command.

The first broker request must be a fresh, read-only `job_status` using an ID
that has never been used. The expected result is bounded `refused` because the
registry has no such job. Do not reuse any preserved incident job ID.

Use an actual multiline shell command on the VPS; each trailing backslash is
required. This prevents terminal visual wrapping from turning `-o` options or
the destination into separate commands:

```sh
VALIDATION_JOB_ID="job_$(openssl rand -hex 16)"
printf '{"contractVersion":"2026-08-13","verb":"job_status","jobId":"%s"}\n' \
  "$VALIDATION_JOB_ID" | \
  sudo -u luminos-dispatcher -H ssh \
    -T \
    -o BatchMode=yes \
    -o ClearAllForwardings=yes \
    -o ForwardAgent=no \
    -o RequestTTY=no \
    -o ExitOnForwardFailure=yes \
    -o ConnectTimeout=10 \
    devon-windows-validation-broker
```

Before using that request, verify `2026-08-13` still matches the installed
runner's `@djamestaft/hermes-herdr-contracts` `CONTRACT_VERSION`. A mismatch is
a stop condition, not a reason to guess a version.

Do not run `create_job`, `prompt_job`, `handoff_job`, `recover_job`, or
`close_job` during this phase.

## Phase 10: Windows Herdr launch-context A/B

Before any workspace-create smoke test, run the approved read-only A/B inside
the `luminos-broker` account's already-authorized Herdr-managed environment:

- A: invoke `herdr workspace list` through Node `spawn` with `shell:false` and
  the managed environment unchanged.
- B: invoke the same command with only these categories removed:
  `HERDR_ENV`, `HERDR_SOCKET_PATH`, `HERDR_CONFIG_PATH`, `HERDR_SESSION`,
  `HERDR_PANE_ID`, and `HERDR_WORKSPACE_ID`.

Record only:

- exit code;
- signal;
- spawn-result category;
- valid JSON yes/no; and
- bounded structural stdout/stderr category.

Do not retain raw output, environment values, paths, workspace names, or
transcripts. Do not create a workspace or restart the broker. Never use the
preserved Greg incident job as a test fixture.

The result determines the next reviewed change:

- Managed succeeds and stripped fails: design a deterministic launch/session
  bridge; do not inject copied or guessed environment values.
- Both succeed: improve allowlisted structural diagnostics or request separate
  approval for one disposable create probe.
- Inconclusive: stop and preserve evidence.

## Activation gate

The validation host is not a live runner merely because SSH and read-only
status work. Activation requires all of the following:

- reviewed A/B result and any required fix;
- common Node and Windows-specific tests;
- current immutable Windows package and checksum/provenance;
- protected config/ACL review;
- gateway route approval with retained prior values;
- one fresh uniquely named smoke job; and
- verified rollback.

Until then, leave `GREG_SSH_TARGET` and `DEVON_SSH_TARGET` unchanged.

## Rollback

Keep the local console available throughout initial setup. If SSH validation
fails:

1. Restore the backed-up `sshd_config`.
2. Validate it with `sshd.exe -t`.
3. Restart only `sshd`.
4. Disable the `Luminos-OpenSSH-From-Gateway` firewall rule if remote access
   must be removed.
5. Keep the versioned runner release, protected evidence, registry, and
   worktrees intact until reviewed; do not delete or reuse uncertain state.

Do not uninstall Tailscale, remove host keys, delete a registry, or clean a job
worktree as an automatic rollback step.
