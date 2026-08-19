# PROFI24KST CRM MVP

Рабочий MVP CRM для сервисного центра PROFI24KST.

## Что уже есть

- авторизация и роли: Owner / Manager / Engineer;
- клиенты и оборудование;
- заявки и статусы;
- назначение инженера;
- принятие заявки инженером;
- диагностика;
- работы и стоимость;
- платежи;
- SLA и просрочки;
- dashboard;
- история статусов;
- PostgreSQL;
- Docker Compose;
- адаптивный web-интерфейс.

## Быстрый запуск

1. Установить Docker Desktop.
2. Скопировать `.env.example` в `.env`.
3. Выполнить:

```bash
docker compose up --build
```

4. Открыть `http://localhost:5173`.

## Тестовые пользователи

- Директор: `owner@profi24.kz` / `profi24`
- Менеджер: `manager@profi24.kz` / `profi24`
- Инженер: `engineer@profi24.kz` / `profi24`

## API

Backend доступен на `http://localhost:8080/api/v1`.

Health check: `GET /health`.

## Следующие модули

Склад, запчасти с поставщиками, рекламации/гарантии, KPI/зарплата, B2B, маркетинг и AI добавляются поверх уже заложенной архитектуры.
