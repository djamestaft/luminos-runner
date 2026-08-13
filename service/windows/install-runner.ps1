param(
  [Parameter(Mandatory=$true)][string]$NodePath,
  [Parameter(Mandatory=$true)][string]$RunnerRoot,
  [Parameter(Mandatory=$true)][string]$ConfigPath,
  [string]$BrokerUser = $env:USERNAME,
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
if (!(Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'NodePath must be an existing file' }
if (!(Test-Path -LiteralPath $RunnerRoot -PathType Container)) { throw 'RunnerRoot must be an existing directory' }
if (!(Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw 'ConfigPath must be an existing protected file' }
$launcher = Join-Path $RunnerRoot 'service/windows/start-broker.ps1'
if (!(Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'Broker launcher is missing' }
foreach ($relative in @('dist/hostBrokerMain.js','dist/brokerCommandMain.js','service/windows/forced-command.ps1')) {
  if (!(Test-Path -LiteralPath (Join-Path $RunnerRoot $relative) -PathType Leaf)) { throw "Runner release is incomplete: $relative" }
}
foreach ($command in @('git.exe','gh.exe','herdr.exe')) {
  if (!(Get-Command $command -ErrorAction SilentlyContinue)) { throw "Required command is unavailable: $command" }
}
$forbidden = Get-Acl -LiteralPath $ConfigPath | Select-Object -ExpandProperty Access | Where-Object {
  $_.IdentityReference -match '(Everyone|BUILTIN\\Users|Authenticated Users)$' -and $_.FileSystemRights -match '(Write|Modify|FullControl)'
}
if ($forbidden) { throw 'Broker configuration is writable by a broad Windows principal' }
$argument = '-NoProfile -NonInteractive -File "' + $launcher + '" -NodePath "' + $NodePath + '" -RunnerRoot "' + $RunnerRoot + '" -ConfigPath "' + $ConfigPath + '"'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument -WorkingDirectory $RunnerRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 0)
if (!$Apply) {
  Write-Host 'Validation passed. Re-run with -Apply to register the broker task.'
  Register-ScheduledTask -TaskName 'LuminosHerdrBroker' -Action $action -Trigger $trigger -Settings $settings -Description 'Restricted Luminos Herdr host broker' -User $BrokerUser -WhatIf
  exit 0
}
Register-ScheduledTask -TaskName 'LuminosHerdrBroker' -Action $action -Trigger $trigger -Settings $settings -Description 'Restricted Luminos Herdr host broker' -User $BrokerUser -Force | Out-Null
Write-Host 'LuminosHerdrBroker registered. The restricted OpenSSH ForceCommand and VPS route must still be verified separately.'
