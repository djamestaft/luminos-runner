param([Parameter(Mandatory=$true)][string]$NodePath,[Parameter(Mandatory=$true)][string]$RunnerRoot,[Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$allowed = @('BROKER_PROJECTS_FILE','BROKER_PROJECT_KEY','BROKER_REPO_ROOT','BROKER_WORKTREE_ROOT','BROKER_EXPECTED_REMOTE_URL','BROKER_GITHUB_REPO','BROKER_GITHUB_TOKEN_FILE','BROKER_GIT_REMOTE','BROKER_BASE_REF','BROKER_BASE_BRANCH','BROKER_PROFILES','BROKER_STATE_ROOT','BROKER_AGENT_KIND','BROKER_SHELL_ZDOTDIR')
foreach ($line in Get-Content -LiteralPath $ConfigPath -ErrorAction Stop) {
  $trimmed = $line.Trim()
  if (!$trimmed -or $trimmed.StartsWith('#')) { continue }
  $separator = $trimmed.IndexOf('=')
  if ($separator -lt 1) { throw 'Invalid broker configuration line' }
  $name = $trimmed.Substring(0, $separator).Trim()
  if ($allowed -notcontains $name) { throw 'Unsupported broker configuration key' }
  [Environment]::SetEnvironmentVariable($name, $trimmed.Substring($separator + 1).Trim(), 'Process')
}
$tokenPath = $env:BROKER_GITHUB_TOKEN_FILE
if (!$tokenPath -or ![System.IO.Path]::IsPathFullyQualified($tokenPath) -or !(Test-Path -LiteralPath $tokenPath -PathType Leaf)) { throw 'BROKER_GITHUB_TOKEN_FILE must be an existing absolute file' }
$tokenAcl = Get-Acl -LiteralPath $tokenPath
$broadTokenAccess = $tokenAcl.Access | Where-Object { $_.IdentityReference -match '(Everyone|BUILTIN\\Users|Authenticated Users)$' -and $_.FileSystemRights -match '(Read|Write|Modify|FullControl)' }
if ($broadTokenAccess) { throw 'GitHub token file is accessible by a broad Windows principal' }
$projectsPath = $env:BROKER_PROJECTS_FILE
if ($projectsPath) {
  if (![System.IO.Path]::IsPathFullyQualified($projectsPath) -or !(Test-Path -LiteralPath $projectsPath -PathType Leaf)) { throw 'BROKER_PROJECTS_FILE must be an existing absolute file' }
  $projectsAcl = Get-Acl -LiteralPath $projectsPath
  $broadProjectsAccess = $projectsAcl.Access | Where-Object { $_.IdentityReference -match '(Everyone|BUILTIN\\Users|Authenticated Users)$' -and $_.FileSystemRights -match '(Read|Write|Modify|FullControl)' }
  if ($broadProjectsAccess) { throw 'Project policy file is accessible by a broad Windows principal' }
}
Set-Location -LiteralPath $RunnerRoot
& $NodePath (Join-Path $RunnerRoot 'dist/hostBrokerMain.js')
exit $LASTEXITCODE
