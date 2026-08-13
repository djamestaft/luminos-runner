param([Parameter(Mandatory=$true)][string]$NodePath,[Parameter(Mandatory=$true)][string]$RunnerRoot,[Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
if (!(Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'NodePath must be an existing file' }
if (!(Test-Path -LiteralPath $RunnerRoot -PathType Container)) { throw 'RunnerRoot must be an existing directory' }
if (!(Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw 'ConfigPath must be an existing protected file' }
$launcher = Join-Path $RunnerRoot 'service/windows/start-broker.ps1'
if (!(Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'Broker launcher is missing' }
$argument = '-NoProfile -NonInteractive -File "' + $launcher + '" -NodePath "' + $NodePath + '" -RunnerRoot "' + $RunnerRoot + '" -ConfigPath "' + $ConfigPath + '"'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument -WorkingDirectory $RunnerRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 0)
Register-ScheduledTask -TaskName 'LuminosHerdrBroker' -Action $action -Trigger $trigger -Settings $settings -Description 'Restricted Luminos Herdr host broker' -WhatIf
