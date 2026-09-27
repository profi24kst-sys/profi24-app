param()
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$server = Join-Path $root 'server'
if (-not (Test-Path (Join-Path $server 'test/staff-day-acceptance.test.js'))) { throw 'PROFI24 server tests were not found. Run this script from the repository ops folder.' }
& docker info --format '{{.ServerVersion}}'
if ($LASTEXITCODE -ne 0) { throw 'Start Docker Desktop before running the isolated test.' }
Write-Host 'Starting isolated six-role CRM acceptance in a temporary Node container.' -ForegroundColor Cyan
Write-Host 'The local PostgreSQL container, real orders, Docker volumes and .env are not used or modified.'
# PowerShell on Windows uses CRLF for multiline here-strings. Alpine /bin/sh sees
# the stray carriage return as an invalid option in "set -eu". Build the shell
# payload from individual strings with an explicit LF separator instead.
$commands = @(
  'set -eu',
  'mkdir -p /work',
  'tar -C /source --exclude=node_modules --exclude=.env --exclude=.env.production --exclude=.env.local -cf - . | tar -C /work -xf -',
  'cd /work',
  'npm ci --include=dev --no-audit --no-fund',
  'node --import ./test/test-env.js --test test/staff-day-acceptance.test.js'
) -join "`n"
& docker run --rm --mount "type=bind,source=$server,target=/source,readonly" --workdir /work --env NODE_ENV=test --env CI=1 node:22-alpine sh -ec $commands
if ($LASTEXITCODE -ne 0) { throw 'Isolated acceptance FAILED. Capture output and do not proceed with real financial test.' }
Write-Host 'ISOLATED_STAFF_DAY_ACCEPTANCE_PASSED' -ForegroundColor Green
