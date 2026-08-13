param([Parameter(Mandatory=$true)][string]$NodePath,[Parameter(Mandatory=$true)][string]$RunnerRoot,[Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
foreach ($line in Get-Content -LiteralPath $ConfigPath -ErrorAction Stop) {
  $trimmed = $line.Trim()
  if (!$trimmed -or $trimmed.StartsWith('#')) { continue }
  $separator = $trimmed.IndexOf('=')
  if ($separator -lt 1) { throw 'Invalid broker configuration line' }
  $name = $trimmed.Substring(0, $separator).Trim()
  if ($name -notmatch '^[A-Z][A-Z0-9_]*$') { throw 'Invalid broker configuration key' }
  [Environment]::SetEnvironmentVariable($name, $trimmed.Substring($separator + 1).Trim(), 'Process')
}
Set-Location -LiteralPath $RunnerRoot
& $NodePath (Join-Path $RunnerRoot 'dist/hostBrokerMain.js')
exit $LASTEXITCODE
