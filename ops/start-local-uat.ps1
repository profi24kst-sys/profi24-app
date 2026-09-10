param(
  [switch]$ResetData,
  [switch]$NoBuild,
  [switch]$OpenBrowser,
  [int]$TimeoutSeconds = 600
)

$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$EnvFile='.env.uat'
$BaseUrl='http://127.0.0.1:5173'

function Fail([string]$Message){Write-Host "ERROR: $Message" -ForegroundColor Red;exit 1}
function Step([string]$Message){Write-Host "`n==> $Message" -ForegroundColor Cyan}
function Require([string]$Name){if(-not(Get-Command $Name -ErrorAction SilentlyContinue)){Fail "Не найдена команда '$Name'."}}
function Random-Hex([int]$Bytes){$b=New-Object byte[] $Bytes;$r=[Security.Cryptography.RandomNumberGenerator]::Create();try{$r.GetBytes($b)}finally{$r.Dispose()};return([BitConverter]::ToString($b)).Replace('-','').ToLowerInvariant()}
function Compose([Parameter(ValueFromRemainingArguments=$true)][string[]]$Args){& docker compose --env-file $EnvFile @Args;if($LASTEXITCODE-ne 0){throw "docker compose $($Args -join ' ') завершился с кодом $LASTEXITCODE"}}
function Compose-NoEnv([Parameter(ValueFromRemainingArguments=$true)][string[]]$Args){& docker compose @Args;if($LASTEXITCODE-ne 0){throw "docker compose $($Args -join ' ') завершился с кодом $LASTEXITCODE"}}
function Show-Diagnostics(){Write-Host "`nDocker Compose:" -ForegroundColor Yellow;try{& docker compose --env-file $EnvFile ps -a}catch{};try{& docker compose --env-file $EnvFile logs --tail 180}catch{}}

Require git
Require docker
if(-not(Test-Path 'docker-compose.yml')){Fail 'Запустите скрипт из корня репозитория PROFI24 CRM.'}
& docker info *> $null
if($LASTEXITCODE-ne 0){Fail 'Docker Desktop не запущен. Запустите Docker Desktop и повторите.'}

$dirty=& git status --porcelain
if($dirty){Fail 'В репозитории есть локальные изменения. Сохраните или отмените их перед UAT-запуском.'}
$current=(& git rev-parse --short HEAD).Trim()
Write-Host "PROFI24 Local UAT · commit $current" -ForegroundColor White

if(-not(Test-Path $EnvFile)-and-not $ResetData){Fail "Это первый изолированный UAT-запуск. Используйте: .\ops\start-local-uat.ps1 -ResetData. Без этого volumes не будут изменены."}

if($ResetData){
 Step 'Удаление только локальных Docker volumes UAT по явному -ResetData'
 if(Test-Path $EnvFile){Compose down '-v' '--remove-orphans'}else{Compose-NoEnv down '-v' '--remove-orphans'}
 $dbPassword="DbUat!9$(Random-Hex 18)"
 $jwt=Random-Hex 48
 @"
POSTGRES_DB=profi24_uat
POSTGRES_USER=profi24
POSTGRES_PASSWORD=$dbPassword
JWT_SECRET=$jwt
NODE_ENV=development
CORS_ORIGIN=http://127.0.0.1:5173
PUBLIC_BASE_URL=http://127.0.0.1:5173
DB_POOL_MAX=10
WEB_PORT=5173
BACKUP_RETENTION_DAYS=14
AUTH_RATE_LIMIT_PER_MINUTE=60
AUTH_TOKEN_TTL=12h
AUTH_FAILURE_LIMIT=20
AUTH_FAILURE_WINDOW_MINUTES=10
AUTH_LOCK_MINUTES=15
TELEGRAM_BOT_TOKEN=
WHATSAPP_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_API_VERSION=v23.0
"@ | Set-Content -Path $EnvFile -Encoding ASCII
 Write-Host 'Создан новый .env.uat со случайными локальными секретами.' -ForegroundColor Green
}

Step 'Проверка Docker Compose'
Compose config '--quiet'

Step 'Запуск полного CRM-стека'
$services=@(& docker compose --env-file $EnvFile config --services | Where-Object{$_ -and $_ -ne 'backup'})
if($LASTEXITCODE-ne 0-or $services.Count-eq 0){Fail 'Не удалось получить список сервисов Docker Compose.'}
$args=@('up','-d');if(-not $NoBuild){$args+='--build'};$args+=$services
try{Compose @args}catch{Show-Diagnostics;Fail $_.Exception.Message}

Step 'Ожидание всех сервисов через web gateway'
$health=@(
 '/health','/auth-health','/warehouse-health','/procurement-health','/supplier-catalog-health','/knowledge-health','/payroll-health','/analytics-health','/finance-health',
 '/documents-health','/notifications-health','/communications-health','/approvals-health','/workflow-health','/operations-health','/performance-health','/kpi-health','/profitability-health',
 '/pricing-health','/pricebook-health','/diagnostic-health','/parts-health','/completion-health','/reliability-health','/warranty-health','/discipline-health','/owner-health',
 '/directory-health','/order-tasks-health','/branch-health','/cash-health','/lifecycle-health','/custody-health'
)
$deadline=(Get-Date).AddSeconds($TimeoutSeconds);$pending=@($health)
while((Get-Date)-lt $deadline-and $pending.Count-gt 0){$next=@();foreach($path in $pending){try{$r=Invoke-WebRequest -UseBasicParsing -Uri($BaseUrl+$path)-TimeoutSec 3;if($r.StatusCode-lt 200-or $r.StatusCode-ge 300){$next+=$path}}catch{$next+=$path}};$pending=@($next);if($pending.Count-gt 0){Start-Sleep -Seconds 3}}
if($pending.Count-gt 0){Write-Host "Не готовы: $($pending -join ', ')" -ForegroundColor Yellow;Show-Diagnostics;Fail 'CRM не прошла локальный health-check.'}

Step 'Создание/обновление шести UAT-ролей'
$uatPassword="Uat!9$(Random-Hex 14)Aa"
& docker compose --env-file $EnvFile exec -T -e LOCAL_UAT=1 api node src/bootstrap-local-uat.js $uatPassword
if($LASTEXITCODE-ne 0){Show-Diagnostics;Fail 'Не удалось подготовить UAT-пользователей. Если база содержит другого OWNER, используйте -ResetData только если эти локальные данные можно удалить.'}

Step 'Проверка реальной авторизации UAT OWNER'
$loginBody=@{email='uat.owner@local.test';password=$uatPassword}|ConvertTo-Json
try{$login=Invoke-RestMethod -Method Post -Uri "$BaseUrl/auth-api/v1/login" -ContentType 'application/json' -Body $loginBody -TimeoutSec 10}catch{Show-Diagnostics;Fail "UAT OWNER создан, но login через gateway не прошёл: $($_.Exception.Message)"}
if(-not $login.data.access_token){Fail 'Login API не вернул access token.'}

Step 'Финальная проверка защищённых API'
$headers=@{Authorization="Bearer $($login.data.access_token)"}
try{$null=Invoke-RestMethod -Uri "$BaseUrl/api/v1/dashboard" -Headers $headers -TimeoutSec 10;$null=Invoke-RestMethod -Uri "$BaseUrl/operations-api/v1/operations/live" -Headers $headers -TimeoutSec 10;$null=Invoke-RestMethod -Uri "$BaseUrl/branch-api/v1/branches" -Headers $headers -TimeoutSec 10}catch{Show-Diagnostics;Fail "Защищённый UAT smoke-check не прошёл: $($_.Exception.Message)"}

Write-Host "`nLOCAL UAT READY" -ForegroundColor Green
Write-Host "URL: $BaseUrl" -ForegroundColor Green
Write-Host "Пароль всех UAT-ролей: $uatPassword" -ForegroundColor Yellow
Write-Host 'OWNER       uat.owner@local.test'
Write-Host 'SUPERVISOR  uat.supervisor@local.test'
Write-Host 'ACCOUNTANT  uat.accountant@local.test'
Write-Host 'MANAGER     uat.manager@local.test'
Write-Host 'ENGINEER    uat.engineer@local.test'
Write-Host 'TRAINEE     uat.trainee@local.test'
Write-Host 'WhatsApp/Telegram в UAT не настроены: очередь и тексты работают, реальные сообщения не отправляются.' -ForegroundColor DarkGray
if($OpenBrowser){Start-Process $BaseUrl}
