param(
  [Parameter(Mandatory=$true)][string]$NodePath,
  [Parameter(Mandatory=$true)][string]$SourceRoot,
  [Parameter(Mandatory=$true)][string]$InstallRoot,
  [Parameter(Mandatory=$true)][string]$ConfigPath,
  [string]$BrokerUser = 'luminos-broker',
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
if (!(Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'NodePath must be an existing file' }
if (!(Test-Path -LiteralPath $SourceRoot -PathType Container)) { throw 'SourceRoot must be an existing directory' }
if (!(Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw 'ConfigPath must be an existing protected file' }
if ($InstallRoot -notmatch '^[A-Za-z]:\\Program Files\\Luminos\\releases\\[A-Za-z0-9._-]+$') { throw 'InstallRoot must be a versioned directory below C:\Program Files\Luminos\releases' }
if (!(Get-LocalUser -Name $BrokerUser -ErrorAction SilentlyContinue)) { throw 'BrokerUser does not exist' }
if (Get-LocalGroupMember -Group 'Administrators' | Where-Object Name -Match "\\$([regex]::Escape($BrokerUser))$") { throw 'BrokerUser must not be an administrator' }
foreach ($relative in @('dist/hostBrokerMain.js','dist/brokerCommandMain.js','dist/broker.js','dist/herdrCliAdapter.js','dist/gitWorkspaceAdapter.js','node_modules/@djamestaft/hermes-herdr-contracts/index.js','service/windows/forced-command.ps1')) {
  if (!(Test-Path -LiteralPath (Join-Path $SourceRoot $relative) -PathType Leaf)) { throw "Runner release is incomplete: $relative" }
}
foreach ($command in @('git.exe','gh.exe','herdr.exe')) { if (!(Get-Command $command -ErrorAction SilentlyContinue)) { throw "Required command is unavailable: $command" } }
$forbidden = Get-Acl -LiteralPath $ConfigPath | Select-Object -ExpandProperty Access | Where-Object { $_.IdentityReference -match '(Everyone|BUILTIN\\Users|Authenticated Users)$' -and $_.FileSystemRights -match '(Write|Modify|FullControl)' }
if ($forbidden) { throw 'Broker configuration is writable by a broad Windows principal' }
$tokenLine = Get-Content -LiteralPath $ConfigPath | Where-Object { $_.Trim().StartsWith('BROKER_GITHUB_TOKEN_FILE=') } | Select-Object -Last 1
if (!$tokenLine) { throw 'Broker configuration must declare BROKER_GITHUB_TOKEN_FILE' }
$tokenPath = $tokenLine.Substring($tokenLine.IndexOf('=') + 1).Trim()
if (!$tokenPath -or ![System.IO.Path]::IsPathFullyQualified($tokenPath) -or !(Test-Path -LiteralPath $tokenPath -PathType Leaf)) { throw 'BROKER_GITHUB_TOKEN_FILE must be an existing absolute file' }
$broadTokenAccess = Get-Acl -LiteralPath $tokenPath | Select-Object -ExpandProperty Access | Where-Object { $_.IdentityReference -match '(Everyone|BUILTIN\\Users|Authenticated Users)$' -and $_.FileSystemRights -match '(Read|Write|Modify|FullControl)' }
if ($broadTokenAccess) { throw 'GitHub token file is accessible by a broad Windows principal' }
if (!$Apply) { Write-Host "Validation passed. Re-run with -Apply to install the immutable release at $InstallRoot."; exit 0 }
if (Test-Path -LiteralPath $InstallRoot) { throw 'InstallRoot already exists; use a new versioned release directory' }
New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
foreach ($directory in @('dist','service/windows','node_modules/@djamestaft/hermes-herdr-contracts')) { New-Item -ItemType Directory -Path (Join-Path $InstallRoot $directory) -Force | Out-Null }
Copy-Item -Path (Join-Path $SourceRoot 'dist/*') -Destination (Join-Path $InstallRoot 'dist') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $SourceRoot 'service/windows/forced-command.ps1') -Destination (Join-Path $InstallRoot 'service/windows/forced-command.ps1')
Copy-Item -Path (Join-Path $SourceRoot 'node_modules/@djamestaft/hermes-herdr-contracts/*') -Destination (Join-Path $InstallRoot 'node_modules/@djamestaft/hermes-herdr-contracts') -Recurse -Force
icacls $InstallRoot /inheritance:r | Out-Null
icacls $InstallRoot /grant:r 'Administrators:(OI)(CI)F' 'SYSTEM:(OI)(CI)F' "${BrokerUser}:(OI)(CI)RX" | Out-Null
$writable = Get-Acl -LiteralPath $InstallRoot | Select-Object -ExpandProperty Access | Where-Object { $_.IdentityReference -match "\\$([regex]::Escape($BrokerUser))$" -and $_.FileSystemRights -match '(Write|Modify|FullControl)' }
if ($writable) { throw 'Installed runner is writable by BrokerUser' }
Write-Host "Immutable runner release installed at $InstallRoot. Configure OpenSSH ForceCommand to this exact path."
