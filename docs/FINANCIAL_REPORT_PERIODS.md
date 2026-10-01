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
