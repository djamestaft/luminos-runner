param(
  [Parameter(Mandatory=$true)][string]$NodePath,
  [Parameter(Mandatory=$true)][string]$SourceRoot,
  [Parameter(Mandatory=$true)][string]$InstallRoot,
  [Parameter(Mandatory=$true)][string]$ConfigPath,
  [string]$BrokerUser = 'luminos-broker'
)
$ErrorActionPreference = 'Stop'
& (Join-Path $SourceRoot 'service/windows/install-runner.ps1') -NodePath $NodePath -SourceRoot $SourceRoot -InstallRoot $InstallRoot -ConfigPath $ConfigPath -BrokerUser $BrokerUser
Push-Location $SourceRoot
try {
  & $NodePath --version
  & npm.cmd run typecheck
  & npm.cmd test
  & npm.cmd run services:check
  & herdr.exe --version
  & herdr.exe agent list
  & git.exe --version
  & gh.exe auth status
  Get-Service sshd -ErrorAction Stop | Format-Table Name,Status,StartType
} finally { Pop-Location }
if (Test-Path -LiteralPath $InstallRoot -PathType Container) {
  foreach ($relative in @('dist/brokerCommandMain.js','service/windows/forced-command.ps1','node_modules/@djamestaft/hermes-herdr-contracts/index.js')) { if (!(Test-Path -LiteralPath (Join-Path $InstallRoot $relative) -PathType Leaf)) { throw "Installed release is incomplete: $relative" } }
  $writable = Get-Acl -LiteralPath $InstallRoot | Select-Object -ExpandProperty Access | Where-Object { $_.IdentityReference -match "\\$([regex]::Escape($BrokerUser))$" -and $_.FileSystemRights -match '(Write|Modify|FullControl)' }
  if ($writable) { throw 'Installed runner is writable by BrokerUser' }
  Write-Host "Installed immutable release verified: $InstallRoot"
} else { Write-Host 'Immutable release is not installed yet.' }
