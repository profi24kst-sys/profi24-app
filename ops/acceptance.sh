#!/bin/sh
set -eu

BASE_URL=${BASE_URL:-${PUBLIC_BASE_URL:-http://localhost:5173}}
BASE_URL=${BASE_URL%/}
CURL_TIMEOUT=${CURL_TIMEOUT:-5}

failures=0
check(){
  name=$1; path=$2
  if curl -fsS --max-time "$CURL_TIMEOUT" "$BASE_URL$path" >/dev/null 2>&1; then
    echo "acceptance_ok service=$name path=$path"
  else
    echo "acceptance_fail service=$name path=$path" >&2
    failures=$((failures+1))
  fi
}

check api /health
check warehouse /warehouse-health
check procurement /procurement-health
check payroll /payroll-health
check analytics /analytics-health
check finance /finance-health
check documents /documents-health
check notifications /notifications-health
check communications /communications-health
check approvals /approvals-health
check workflow /workflow-health
check operations /operations-health
check performance /performance-health
check kpi /kpi-health
check profitability /profitability-health
check pricing /pricing-health
check pricebook /pricebook-health
check diagnostic /diagnostic-health
check parts /parts-health
check completion /completion-health
check reliability /reliability-health
check warranty /warranty-health
check discipline /discipline-health
check ownercontrol /owner-health
check directoryadmin /directory-health
check ordertasks /order-tasks-health
check branchadmin /branch-health
check cashregister /cash-health
check lifecycle /lifecycle-health

if [ -n "${ACCEPTANCE_TOKEN:-}" ]; then
  if curl -fsS --max-time "$CURL_TIMEOUT" "$BASE_URL/api/v1/me" -H "Authorization: Bearer $ACCEPTANCE_TOKEN" | grep -q '"data"'; then
    echo "acceptance_ok authenticated=/api/v1/me"
  else
    echo "acceptance_fail authenticated=/api/v1/me" >&2
    failures=$((failures+1))
  fi
  if curl -fsS --max-time "$CURL_TIMEOUT" "$BASE_URL/api/v1/requests" -H "Authorization: Bearer $ACCEPTANCE_TOKEN" | grep -q '"data"'; then
    echo "acceptance_ok authenticated=/api/v1/requests"
  else
    echo "acceptance_fail authenticated=/api/v1/requests" >&2
    failures=$((failures+1))
  fi
fi

[ "$failures" -eq 0 ] || { echo "acceptance_error failures=$failures" >&2; exit 1; }
echo "acceptance_pass base_url=$BASE_URL"
