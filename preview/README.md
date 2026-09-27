# Render: ограниченный тестовый стенд PROFI24KST

Ветка `deploy/render-core-preview-20260927` предназначена только для отдельного ознакомительного стенда, **не для production**. Render free Postgres имеет срок действия; не переносите сюда клиентов и реальные оплаты.

## Состав
Один бесплатный Node Web Service запускает под HTTP-шлюзом основной CRM API и службу входа. UI в `preview/index.html` покрывает вход, список клиентов/техники/заказов и создание тестовой заявки. Склад, финансы, выдача/подписи, вложения и дополнительные сервисы в этом экономичном предпросмотре намеренно недоступны. Не называйте его полноценной CRM.

## Render Web Service
- Source repository: `https://github.com/profi24kst-sys/profi24-app`; branch `deploy/render-core-preview-20260927`;
- Runtime: Node 22, region Frankfurt; build: `node --check preview/serve.mjs && node --check preview/app.js && npm --prefix server ci --omit=dev`;
- Start: `node preview/serve.mjs`;
- Configure `DATABASE_URL` from the **Internal Database URL** of the isolated preview Postgres, via Render dashboard **Environment**. Never paste this URL into GitHub, chat, README or public logs.
- Other environment keys: `JWT_SECRET` (32+ random chars), `APPROVAL_TOKEN_SECRET` (different 32+ random chars), `DEMO_OWNER_EMAIL`, `DEMO_OWNER_PASSWORD` (strong random 10+ chars), `NODE_ENV=production`, `AUTH_COOKIE_SECURE=true`, `CORS_ORIGIN` and `PUBLIC_BASE_URL` (exact Render HTTPS hostname).
- `/preview-health` returns 200 only when core and auth services are both reachable. The home page responding with HTTP 200 is **not** proof of readiness.
- Postgres must be empty: the first boot creates one demo OWNER. Reruns accept the documented exit code when an OWNER already exists; changing the password environment variable later does not reset the existing account.
- Explicitly disable public account/data sharing outside the test group; use only fictitious demonstration data.

## Checks
Verify `GET /preview-health` returns `ready:true`, then open the HTTPS home page, log in with preview credentials, create a fictitious client/equipment/request and confirm each appears after reload. Check Render deploy and runtime logs on failure. To run *full* CRM acceptance, use the separate complete Docker deployment described in `docs/PRODUCTION_RUNBOOK.md`.

**Important:** Render free instances may sleep and the test database may expire. This is not suitable for live business or data retention.
