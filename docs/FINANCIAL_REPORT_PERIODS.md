# Financial summary periods

The Finance and Reports summary screens use calendar dates in `Asia/Qostanay`,
including historical IANA timezone rules. `from` and `to` are inclusive local
calendar dates; SQL compares exact timestamptz instants with an exclusive end.
Browser presets use the same timezone regardless of the user's device timezone.

Comparison rules:

- A complete calendar month compares with the complete previous month.
- A complete calendar quarter compares with the complete previous quarter.
- Other ranges, including periods ending today, compare with the preceding
  equal number of calendar days.

The API exposes both displayed date ranges and the comparison rule in `period`.
The UI displays the dates so that differing month lengths remain explicit.
Manager summaries apply the same boundaries inside the manager's branch scope.
Without explicit dates, the existing current-month mode uses Kostanay midnight.

This change covers `/api/v1/dashboard/finance`. Account ledger and P&L screens
retain their existing monthly filters. Date-range report exports are handled
separately by PR #100; their SQL already uses `Asia/Qostanay`.

Regression coverage includes exact midnight boundaries under multiple database
session timezones, full-month/quarter comparisons, leap years, year rollover,
the 2024 timezone change, device timezones, cancelled orders and branch scope.


## Денежные счета и P&L

`GET /finance-api/v1/transactions` и `/finance-api/v1/pnl` поддерживают либо `month=ГГГГ-ММ`, либо `from=ГГГГ-ММ-ДД&to=ГГГГ-ММ-ДД`. Обе даты включены, максимум 366 дней. Смешивать месяц и диапазон нельзя. Без параметров используется текущий месяц Костаная. Ответ содержит `data.period` с фактическими датами и часовым поясом.

Проводки хранят календарную дату (`DATE`); закрытие заказов — момент времени (`TIMESTAMPTZ`). Для заказов используются местные полуночи Asia/Qostanay. Начальный остаток — все доступные проводки раньше первой даты; конечный — все проводки по последнюю дату включительно. Фильтр переводов ограничивает строки, но не итоговые остатки. «Остаток после проведения» в строке остаётся остатком в порядке проведения, а не по дате документа. Фильтры счёта и права доступа применяются также к итогам.

ФОТ учитывается за полные календарные месяцы. Для каждого месяца и филиала утверждённый, оплаченный или закрытый снимок имеет приоритет; остальные филиалы рассчитываются по правилам, KPI и корректировкам этого месяца. В `payroll_months` возвращается состав расчёта; общие счётчики филиалов суммируются по месяцам. Для живого расчёта границы закрытия заказов местные, ключи правил и начислений остаются календарными датами.

За диапазон с неполным месяцем P&L возвращает выручку, себестоимость и дополнительные расходы; `payroll` и `net_profit` равны `null`, причина — `INCOMPLETE_PAYROLL_MONTH`. Дневное распределение месячного ФОТ в ТЗ не определено, а снимки не содержат такого распределения. Нулевой ФОТ или пропорциональная оценка не подставляются. Для полной чистой прибыли выберите месяц или диапазон целых месяцев. Если зарплатный модуль недоступен, причина — `PAYROLL_UNAVAILABLE`.

Проверки: HTTP-тест журнала покрывает обе границы, остатки, фильтр чужого счёта, пагинацию, переводы и отклонение некорректных периодов без записей. P&L проверен на локальных границах при часовом поясе БД Pacific/Honolulu, утверждённом снимке, живом расчёте следующего месяца, кассовых расходах и неполном месяце. Браузерная проверка переключает период и проверяет запросы, пояснение неполного месяца и ошибку неверных дат.
