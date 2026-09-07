param(
  [switch]$DiagnoseOnly,
  [int]$TimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Fail([string]$Message) {
  Write-Host "ERROR: $Message" -ForegroundColor Red
  exit 1
}

function Step([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Fail "Required command '$Name' was not found."
  }
}

function Compose([Parameter(ValueFromRemainingArguments=$true)][string[]]$Args) {
  & docker compose @Args
  if ($LASTEXITCODE -ne 0) {
    throw "docker compose $($Args -join ' ') failed with exit code $LASTEXITCODE"
  }
}

function Read-DotEnv([string]$Path) {
  $values = @{}
  if (-not (Test-Path $Path)) { return $values }
  foreach ($line in Get-Content $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $parts = $trimmed -split '=', 2
    if ($parts.Count -ne 2) { continue }
    $values[$parts[0].Trim()] = $parts[1].Trim().Trim('"').Trim("'")
  }
  return $values
}

function Show-ComposeState {
  Write-Host "`nDocker Compose state:" -ForegroundColor Yellow
  & docker compose ps -a
}

function Show-FailedLogs {
  try {
    $rows = & docker compose ps -a --format json 2>$null
    if (-not $rows) {
      & docker compose logs --tail 120
      return
    }
    $failed = @()
    foreach ($line in $rows) {
      try {
        $obj = $line | ConvertFrom-Json
        $state = [string]$obj.State
        $health = [string]$obj.Health
        if ($state -notin @('running','created') -or $health -eq 'unhealthy') {
          if ($obj.Service) { $failed += [string]$obj.Service }
        }
      } catch { }
    }
    $failed = $failed | Sort-Object -Unique
    if ($failed.Count -eq 0) {
      & docker compose logs --tail 120
    } else {
      Write-Host "`nLogs for failed/unhealthy services: $($failed -join ', ')" -ForegroundColor Yellow
      & docker compose logs --tail 180 @failed
    }
  } catch {
    & docker compose logs --tail 120
  }
}

Require-Command git
Require-Command docker

Step 'Checking Docker Desktop / Docker Engine'
& docker info *> $null
if ($LASTEXITCODE -ne 0) { Fail 'Docker Engine is not available. Start Docker Desktop and run this script again.' }

Step 'Checking repository state'
& git rev-parse --is-inside-work-tree *> $null
if ($LASTEXITCODE -ne 0) { Fail 'Run this script from the PROFI24 CRM repository.' }

$dirty = (& git status --porcelain)
$currentBranch = (& git branch --show-current).Trim()
$currentSha = (& git rev-parse HEAD).Trim()
Write-Host "Branch: $currentBranch"
Write-Host "Commit: $currentSha"

if ($DiagnoseOnly) {
  Show-ComposeState
  Show-FailedLogs
  exit 0
}

if ($dirty) {
  Fail 'Local Git changes are present. Commit or stash them before automatic repair; no local work was modified.'
}

Step 'Synchronizing canonical main branch'
& git fetch origin
if ($LASTEXITCODE -ne 0) { Fail 'git fetch origin failed.' }
& git switch main
if ($LASTEXITCODE -ne 0) { Fail 'Cannot switch to main.' }
& git pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { Fail 'main cannot be fast-forwarded. Resolve the local Git state first.' }

Step 'Reading the existing local environment without replacing secrets'
if (-not (Test-Path '.env')) {
  Fail '.env is missing. Recovery will not create credentials automatically. Restore your existing local .env before continuing.'
}
$envValues = Read-DotEnv '.env'
$dbName = if ($envValues['POSTGRES_DB']) { $envValues['POSTGRES_DB'] } else { 'profi24' }
$dbUser = if ($envValues['POSTGRES_USER']) { $envValues['POSTGRES_USER'] } else { 'profi24' }
$dbPassword = $envValues['POSTGRES_PASSWORD']
if (-not $dbPassword) { Fail 'POSTGRES_PASSWORD is missing from .env. Recovery stopped before touching containers.' }
$webPort = if ($envValues['WEB_PORT']) { [int]$envValues['WEB_PORT'] } else { 5173 }

Step 'Validating Docker Compose configuration'
Compose config '--quiet'

Step 'Removing stale containers and orphans without deleting volumes'
Compose down '--remove-orphans'

Step 'Starting PostgreSQL first'
Compose up '-d' 'db'
$deadline = (Get-Date).AddSeconds([Math]::Min($TimeoutSeconds, 120))
$dbReady = $false
while ((Get-Date) -lt $deadline) {
  & docker compose exec -T db pg_isready -U $dbUser -d $dbName *> $null
  if ($LASTEXITCODE -eq 0) { $dbReady = $true; break }
  Start-Sleep -Seconds 2
}
if (-not $dbReady) {
  Show-ComposeState
  & docker compose logs --tail 200 db
  Fail 'PostgreSQL did not become ready. The database volume was NOT deleted.'
}

Step 'Verifying the existing PostgreSQL volume accepts the configured password'
$tcpTest = & docker compose run --rm --no-deps -e "PGPASSWORD=$dbPassword" backup psql -h db -U $dbUser -d $dbName -Atqc 'SELECT 1' 2>&1
if ($LASTEXITCODE -ne 0 -or ($tcpTest -join '').Trim() -ne '1') {
  Show-ComposeState
  Write-Host ($tcpTest -join "`n") -ForegroundColor Yellow
  Fail 'The existing PostgreSQL volume does not accept POSTGRES_PASSWORD from .env. No volume was changed. Restore the password used when this volume was first created, or recover from backup into a new volume.'
}

Step 'Rebuilding and starting the core API'
Compose up '-d' '--build' 'api'
$coreDeadline = (Get-Date).AddSeconds([Math]::Min($TimeoutSeconds, 180))
$coreReady = $false
while ((Get-Date) -lt $coreDeadline) {
  & docker compose exec -T api node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" *> $null
  if ($LASTEXITCODE -eq 0) { $coreReady = $true; break }
  Start-Sleep -Seconds 3
}
if (-not $coreReady) {
  Show-ComposeState
  & docker compose logs --tail 220 api db
  Fail 'Core API did not become healthy. Database and volumes were left intact.'
}

Step 'Starting the complete CRM stack except the backup worker'
$services = @(& docker compose config --services | Where-Object { $_ -and $_ -ne 'backup' })
if ($LASTEXITCODE -ne 0 -or $services.Count -eq 0) { Fail 'Could not enumerate Docker Compose services.' }
& docker compose up -d --build @services
if ($LASTEXITCODE -ne 0) {
  Show-ComposeState
  Show-FailedLogs
  Fail 'Full-stack start failed. Volumes were not removed.'
}

Step 'Waiting for all CRM services through the web gateway'
$healthPaths = @(
  '/health','/auth-health','/warehouse-health','/procurement-health','/payroll-health','/analytics-health','/finance-health',
  '/documents-health','/notifications-health','/communications-health','/approvals-health','/workflow-health','/operations-health',
  '/performance-health','/kpi-health','/profitability-health','/pricing-health','/pricebook-health','/diagnostic-health','/parts-health',
  '/completion-health','/reliability-health','/warranty-health','/discipline-health','/owner-health','/directory-health','/order-tasks-health',
  '/branch-health','/cash-health','/lifecycle-health'
)
$baseUrl = "http://127.0.0.1:$webPort"
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$pending = @($healthPaths)
while ((Get-Date) -lt $deadline -and $pending.Count -gt 0) {
  $next = @()
  foreach ($path in $pending) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri ($baseUrl + $path) -TimeoutSec 2
      if ($r.StatusCode -lt 200 -or $r.StatusCode -ge 300) { $next += $path }
    } catch { $next += $path }
  }
  $pending = @($next)
  if ($pending.Count -gt 0) { Start-Sleep -Seconds 3 }
}

if ($pending.Count -gt 0) {
  Show-ComposeState
  Write-Host "Health endpoints still failing: $($pending -join ', ')" -ForegroundColor Yellow
  Show-FailedLogs
  Fail 'CRM did not pass local full-stack health acceptance. The database volume was NOT deleted.'
}

Step 'Starting backup worker after the application is healthy'
Compose up '-d' 'backup'

Show-ComposeState
Write-Host "`nPROFI24 CRM local recovery completed successfully." -ForegroundColor Green
Write-Host "Open: $baseUrl" -ForegroundColor Green
Write-Host 'No Docker volumes were deleted by this script.' -ForegroundColor Green
