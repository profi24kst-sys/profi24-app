\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM branches WHERE code='KST' AND active=true) THEN
    RAISE EXCEPTION 'Active KST branch is required for performance acceptance';
  END IF;
END $$;

INSERT INTO customers(name,phone,phone_norm,address,notes)
SELECT
  'Performance Client '||g,
  '+7 701 '||substr(lpad(g::text,7,'0'),1,3)||' '||substr(lpad(g::text,7,'0'),4,2)||' '||substr(lpad(g::text,7,'0'),6,2),
  '7701'||lpad(g::text,7,'0'),
  'Костанай, нагрузочный стенд '||g,
  'PERFORMANCE_ACCEPTANCE_FIXTURE'
FROM generate_series(1,500) AS g;

WITH perf_customers AS (
  SELECT id,row_number() OVER(ORDER BY id) AS rn
  FROM customers
  WHERE notes='PERFORMANCE_ACCEPTANCE_FIXTURE'
), branch AS (
  SELECT id FROM branches WHERE code='KST' AND active=true LIMIT 1
)
INSERT INTO requests(number,customer_id,branch_id,status,priority,source,complaint,sla_deadline,visit_type,created_at,updated_at)
SELECT
  'PERF-'||lpad(pc.rn::text,7,'0'),
  pc.id,
  branch.id,
  'NEW',
  CASE WHEN pc.rn%25=0 THEN 'HIGH' ELSE 'NORMAL' END,
  'OTHER',
  'Нагрузочный заказ №'||pc.rn||': диагностика бытовой техники',
  now()+interval '1 hour',
  CASE WHEN pc.rn%5=0 THEN 'WORKSHOP' ELSE 'FIELD' END,
  now()-(pc.rn*interval '1 minute'),
  now()
FROM perf_customers pc CROSS JOIN branch;

DO $$
DECLARE active_count int;
BEGIN
  SELECT count(*) INTO active_count FROM requests WHERE status NOT IN ('CLOSED','CANCELLED') AND deleted_at IS NULL;
  IF active_count < 500 THEN
    RAISE EXCEPTION 'Performance fixture expected >=500 active requests, got %',active_count;
  END IF;
  RAISE NOTICE 'performance_seed_ok active_requests=%',active_count;
END $$;
