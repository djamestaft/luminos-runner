param(
  [Parameter(Mandatory=$true)][string]$NodePath,
  [Parameter(Mandatory=$true)][string]$RunnerRoot,
  [Parameter(Mandatory=$true)][string]$ConfigPath
)
$ErrorActionPreference = 'Stop'
& (Join-Path $RunnerRoot 'service/windows/install-runner.ps1') -NodePath $NodePath -RunnerRoot $RunnerRoot -ConfigPath $ConfigPath
Push-Location $RunnerRoot
try {
  & $NodePath --version
  & npm.cmd run typecheck
  & npm.cmd test
  & npm.cmd run services:check
  & herdr.exe --version
  & herdr.exe agent list
  & git.exe --version
  & gh.exe auth status
  $task = Get-ScheduledTask -TaskName 'LuminosHerdrBroker' -ErrorAction SilentlyContinue
  if ($task) { Write-Host "Scheduled task state: $($task.State)" } else { Write-Host 'Scheduled task is not installed yet.' }
  Get-Service sshd -ErrorAction Stop | Format-Table Name,Status,StartType
} finally {
  Pop-Location
}
