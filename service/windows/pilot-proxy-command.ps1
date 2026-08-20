# Inert pilot source: route owners may use only in a separately approved test ForceCommand route.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$RunnerRoot,
    [Parameter(Mandatory = $true)][string]$PilotDescriptor
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

try {
    if (-not [string]::IsNullOrEmpty($env:SSH_ORIGINAL_COMMAND)) { throw 'original_command_denied' }
    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'node_unavailable' }
    if (-not (Test-Path -LiteralPath $RunnerRoot -PathType Container)) { throw 'runner_unavailable' }
    if (-not (Test-Path -LiteralPath $PilotDescriptor -PathType Leaf)) { throw 'pilot_unavailable' }
    $client = Join-Path $RunnerRoot 'dist/pilotBrokerClientMain.js'
    if (-not (Test-Path -LiteralPath $client -PathType Leaf)) { throw 'client_unavailable' }
    & $NodePath $client $PilotDescriptor
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine('pilot_proxy_unavailable')
    exit 2
}
