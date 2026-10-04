# Локальная проверка CRM в Windows / PowerShell

Нужны Git и запущенный Docker Desktop с Linux containers. Этот стенд использует отдельный Compose project `profi24-local`, отдельные тома и порт, доступный только на локальном компьютере. Не копируйте production `.env`, резервные копии или реальные данные клиентов.

## Первый запуск

```powershell
git clone --branch feat/cash-flow-categories-20261003 https://github.com/profi24kst-sys/profi24-app.git profi24-local
cd profi24-local
$dbPassword = [guid]::NewGuid().ToString("N")
$jwtSecretValue = [guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
$approvalSecretValue = [guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
@"
POSTGRES_DB=profi24_local
POSTGRES_USER=profi24_local
POSTGRES_PASSWORD=$dbPassword
JWT_SECRET=$jwtSecretValue
APPROVAL_TOKEN_SECRET=$approvalSecretValue
NODE_ENV=development
CORS_ORIGIN=http://localhost:5173
PUBLIC_BASE_URL=http://localhost:5173
WEB_PORT=127.0.0.1:5173
AUTH_COOKIE_SECURE=false
TELEGRAM_BOT_TOKEN=
WHATSAPP_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WEBSITE_INTAKE_SECRET=
"@ | Set-Content -Encoding ascii .env.local
docker compose -p profi24-local --env-file .env.local up -d db
if ($LASTEXITCODE -ne 0) { throw "Database startup failed" }
docker compose -p profi24-local --env-file .env.local build api
if ($LASTEXITCODE -ne 0) { throw "API build failed" }
$ownerPassword = Read-Host "Пароль локального владельца: минимум 10 символов, буквы и цифры"
docker compose -p profi24-local --env-file .env.local run --rm api npm run bootstrap-owner -- local-owner@test.invalid "$ownerPassword" "Local owner"
$bootstrapExit = $LASTEXITCODE
Remove-Variable ownerPassword
if ($bootstrapExit -ne 0) { throw "Owner bootstrap failed; read the output above" }
docker compose -p profi24-local --env-file .env.local up -d --build
docker compose -p profi24-local --env-file .env.local ps
```

Откройте http://localhost:5173. Логин: `local-owner@test.invalid`, пароль — заданный при запуске. Bootstrap выполняется один раз: повторный запуск не меняет существующего владельца.

## Обновление уже созданного локального стенда

Если клонировали ветку сохранённых представлений, выполните из каталога `profi24-local`:

```powershell
git fetch origin
git switch --track origin/feat/cash-flow-categories-20261003
docker compose -p profi24-local --env-file .env.local up -d --build
docker compose -p profi24-local --env-file .env.local ps
```

Если эта ветка уже есть локально: `git switch feat/cash-flow-categories-20261003`, затем `git pull --ff-only`. При локальных изменениях сначала сохраните их обычным commit; не используйте reset или принудительное переключение.

Не создавайте `.env.local` заново при обновлении: пароль базы должен соответствовать существующему тому.

## Что проверить

1. «Денежные счета» → «Статьи ДДС»: создайте статью расходов, разрешите только наличную кассу.
2. Создайте тестовый счёт с небольшим начальным остатком. В «Движение денег» → «Операция» выберите счёт и свою статью. На банковском счёте эта статья не должна появляться.
3. «ДДС»: выберите даты, счёт и способ оплаты; проверьте сумму статьи. Обе даты включены. Переводы и корректировки показаны отдельно от доходов и расходов.
4. Отключите статью: она должна исчезнуть из новых операций, но остаться в отчёте. Сторно выполняйте только для своих тестовых записей.

Способ оплаты новых движений сохраняется при проведении. Для старых записей с методом `ACCOUNT`, созданных до этой миграции, отчёт использует текущий тип счёта; исходные записи не переписываются. Неизвестные исторические статьи сохраняются под исходным кодом.

## Диагностика и остановка

```powershell
docker compose -p profi24-local --env-file .env.local logs --tail=100 api auth finance web
docker compose -p profi24-local --env-file .env.local stop
```

Остановка сохраняет тестовые данные. Не используйте `down -v`: эта команда удаляет тома базы и файлы стенда.
