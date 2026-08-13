param([Parameter(Mandatory=$true)][string]$NodePath,[Parameter(Mandatory=$true)][string]$RunnerRoot,[Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
if ($env:SSH_ORIGINAL_COMMAND) { throw 'Remote commands are not accepted' }
$allowed = @('BROKER_PROJECT_KEY','BROKER_REPO_ROOT','BROKER_WORKTREE_ROOT','BROKER_EXPECTED_REMOTE_URL','BROKER_GITHUB_REPO','BROKER_GIT_REMOTE','BROKER_BASE_REF','BROKER_BASE_BRANCH','BROKER_PROFILES','BROKER_STATE_ROOT','BROKER_AGENT_KIND')
foreach ($line in Get-Content -LiteralPath $ConfigPath -ErrorAction Stop) {
  $trimmed=$line.Trim(); if(!$trimmed -or $trimmed.StartsWith('#')){continue}; $separator=$trimmed.IndexOf('='); if($separator -lt 1){throw 'Invalid broker configuration line'}; $name=$trimmed.Substring(0,$separator).Trim(); if($allowed -notcontains $name){throw 'Unsupported broker configuration key'}; [Environment]::SetEnvironmentVariable($name,$trimmed.Substring($separator+1).Trim(),'Process')
}
Set-Location -LiteralPath $RunnerRoot
& $NodePath (Join-Path $RunnerRoot 'dist/brokerCommandMain.js')
exit $LASTEXITCODE
