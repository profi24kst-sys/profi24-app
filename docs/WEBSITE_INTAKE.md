# PROFI24 website → CRM intake

This integration creates normal CRM requests from `profi24.kz` without exposing OWNER/MANAGER credentials or the core `/api/v1/requests` endpoint.

## CRM endpoint

Send a server-to-server request to:

```text
POST https://<crm-host>/communications-api/v1/website-intake
```

Required headers:

```text
Content-Type: application/json
X-Profi24-Intake-Secret: <WEBSITE_INTAKE_SECRET>
X-Idempotency-Key: <unique form submission id>
```

`WEBSITE_INTAKE_SECRET` must be a separate random secret of at least 32 characters. Keep it only on the website backend/server and CRM server. Never embed it in HTML, browser JavaScript, GTM, analytics, mobile app assets, or a public repository.

## Request body

```json
{
  "name": "Иван Иванов",
  "phone": "+7 701 123 45 67",
  "email": "ivan@example.kz",
  "address": "Костанай, ул. ...",
  "category": "Холодильник",
  "brand": "LG",
  "model": "GA-B509",
  "complaint": "Не охлаждает холодильное отделение",
  "visit_type": "FIELD",
  "branch_code": "KST",
  "page_url": "https://profi24.kz/...",
  "utm_source": "google",
  "utm_medium": "cpc",
  "utm_campaign": "repair_fridge_kostanay"
}
```

Required fields are `name`, `phone`, and `complaint`. `visit_type` is `FIELD` or `WORKSHOP`; unknown values fall back to `FIELD`. `branch_code` defaults to `KST`.

## CRM behavior

A valid submission:

1. verifies the integration secret and rate limit;
2. claims the `X-Idempotency-Key` atomically;
3. resolves the active CRM branch;
4. reuses an existing active customer by normalized phone when possible;
5. creates equipment when `category` is present;
6. creates a normal CRM request with `source=SITE`, `status=NEW`, `priority=NORMAL`, and one-hour intake SLA;
7. records `REQUEST_CREATED` and `WEBSITE_INTAKE_ACCEPTED` in request history;
8. stores page/UTM attribution in the audit history;
9. records the intake event in `website_intake_events`.

The normal communications worker then sees `REQUEST_CREATED`, so existing customer-notification rules remain the single messaging flow.

## Idempotency

The website must generate one stable unique key per form submission, for example a UUID. Retrying the same payload with the same key returns the already-created request and does not create duplicate customer/equipment/request records.

Reusing the same key with different payload returns HTTP `409 IDENTITY_CONFLICT` / `IDEMPOTENCY_CONFLICT` and must be treated as an integration error.

## Responses

New request:

```json
{
  "data": {
    "id": 123,
    "request_id": 123,
    "number": "KST-2026-0001234",
    "status": "NEW",
    "customer_id": 45,
    "equipment_id": 67,
    "duplicate": false
  }
}
```

Idempotent retry returns HTTP 200 and `duplicate: true`.

Important errors:

- `401 UNAUTHORIZED` — wrong integration secret;
- `422 IDEMPOTENCY_REQUIRED` — missing/invalid idempotency key;
- `422 VALIDATION` — invalid form data;
- `422 BRANCH_NOT_FOUND` — unknown/disabled branch;
- `409 IDEMPOTENCY_CONFLICT` — same key with different payload;
- `503 WEBSITE_INTAKE_DISABLED` — CRM has no configured integration secret.

## PHP server-side example

Use this on the server that processes the website form. The secret must come from the server environment, not from the browser request.

```php
<?php
$crmUrl = getenv('PROFI24_CRM_INTAKE_URL');
$secret = getenv('PROFI24_CRM_INTAKE_SECRET');

$payload = [
  'name' => trim($_POST['name'] ?? ''),
  'phone' => trim($_POST['phone'] ?? ''),
  'email' => trim($_POST['email'] ?? ''),
  'address' => trim($_POST['address'] ?? ''),
  'category' => trim($_POST['category'] ?? ''),
  'brand' => trim($_POST['brand'] ?? ''),
  'model' => trim($_POST['model'] ?? ''),
  'complaint' => trim($_POST['complaint'] ?? ''),
  'visit_type' => 'FIELD',
  'branch_code' => 'KST',
  'page_url' => $_POST['page_url'] ?? null,
  'utm_source' => $_POST['utm_source'] ?? null,
  'utm_medium' => $_POST['utm_medium'] ?? null,
  'utm_campaign' => $_POST['utm_campaign'] ?? null,
];

$idempotencyKey = $_POST['submission_id'] ?? bin2hex(random_bytes(16));

$ch = curl_init($crmUrl);
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_CONNECTTIMEOUT => 5,
  CURLOPT_TIMEOUT => 10,
  CURLOPT_HTTPHEADER => [
    'Content-Type: application/json',
    'X-Profi24-Intake-Secret: '.$secret,
    'X-Idempotency-Key: '.$idempotencyKey,
  ],
  CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE),
]);
$response = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($status !== 200 && $status !== 201) {
  error_log('PROFI24 CRM intake failed: HTTP '.$status.' '.$response);
}
```

For reliable delivery, keep the generated `submission_id` with the website lead and retry transient `5xx`/network failures using the same idempotency key. Do not retry validation/authorization errors blindly.

## Production enablement

1. Generate a random secret, e.g. with your operating system password/secret generator.
2. Put the same value in CRM `.env.production` as `WEBSITE_INTAKE_SECRET` and in the website server secret store as `PROFI24_CRM_INTAKE_SECRET`.
3. Set the website server `PROFI24_CRM_INTAKE_URL` to the HTTPS CRM endpoint above.
4. Run `sh ops/preflight.sh` and deploy through the normal production procedure.
5. Submit one controlled website test lead and verify the resulting CRM request has `source=SITE` and `WEBSITE_INTAKE_ACCEPTED` history.
6. Verify a retry with the same submission id does not create a second request.
