// No backfill: pre-existing requests retain their original SLA semantics.
export const slaStatements=[
`CREATE TABLE IF NOT EXISTS sla_policies(order_type TEXT NOT NULL,priority TEXT NOT NULL CHECK(priority IN ('NORMAL','CRITICAL')),reaction_minutes INT NOT NULL CHECK(reaction_minutes BETWEEN 1 AND 525600),execution_minutes INT NOT NULL CHECK(execution_minutes BETWEEN 1 AND 525600),updated_by INT REFERENCES users(id),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(order_type,priority))`,
`INSERT INTO sla_policies(order_type,priority,reaction_minutes,execution_minutes) SELECT t,p,CASE WHEN p='CRITICAL' THEN 15 ELSE 60 END,CASE WHEN p='CRITICAL' THEN 1440 ELSE 4320 END FROM unnest(ARRAY['REPAIR','FIELD','PAID_WORKSHOP']) t CROSS JOIN unnest(ARRAY['NORMAL','CRITICAL']) p ON CONFLICT DO NOTHING`,
`ALTER TABLE requests ADD COLUMN IF NOT EXISTS sla_reaction_minutes INT,
 ADD COLUMN IF NOT EXISTS sla_execution_minutes INT,
 ADD COLUMN IF NOT EXISTS sla_reaction_deadline TIMESTAMPTZ,
 ADD COLUMN IF NOT EXISTS sla_execution_deadline TIMESTAMPTZ,
 ADD COLUMN IF NOT EXISTS sla_reacted_at TIMESTAMPTZ,
 ADD COLUMN IF NOT EXISTS sla_paused_at TIMESTAMPTZ`,
`CREATE OR REPLACE FUNCTION request_sla_clock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy sla_policies%ROWTYPE; pause_start TIMESTAMPTZ; elapsed INTERVAL; requested_deadline TIMESTAMPTZ;
BEGIN
 requested_deadline=NEW.sla_deadline;
 IF TG_OP='INSERT' THEN
  IF NEW.status NOT IN ('NEW','ASSIGNED') THEN RETURN NEW; END IF;
  SELECT * INTO policy FROM sla_policies WHERE order_type=NEW.order_type AND priority=NEW.priority;
  IF NOT FOUND THEN RETURN NEW; END IF;
  NEW.sla_reaction_minutes=policy.reaction_minutes;
  NEW.sla_execution_minutes=policy.execution_minutes;
  NEW.sla_reaction_deadline=COALESCE(NEW.created_at,now())+make_interval(mins=>policy.reaction_minutes);
  NEW.sla_execution_deadline=NULL; NEW.sla_reacted_at=NULL; NEW.sla_paused_at=NULL;
 ELSE
  IF OLD.sla_reaction_minutes IS NULL THEN RETURN NEW; END IF;
  -- Snapshots and elapsed clocks cannot be reset by unrelated order edits.
  NEW.sla_reaction_minutes=OLD.sla_reaction_minutes;
  NEW.sla_execution_minutes=OLD.sla_execution_minutes;
  NEW.sla_reaction_deadline=OLD.sla_reaction_deadline;
  NEW.sla_execution_deadline=OLD.sla_execution_deadline;
  NEW.sla_reacted_at=OLD.sla_reacted_at; NEW.sla_paused_at=OLD.sla_paused_at;
  IF OLD.sla_deadline IS NOT NULL AND NEW.sla_deadline IS NULL THEN
   SELECT started_at INTO pause_start FROM request_holds WHERE request_id=NEW.id AND resumed_at IS NULL AND pause_sla ORDER BY started_at DESC LIMIT 1;
   IF pause_start IS NOT NULL THEN NEW.sla_paused_at=pause_start; END IF;
  ELSIF OLD.sla_paused_at IS NOT NULL AND NEW.sla_deadline IS NOT NULL THEN
   elapsed=GREATEST(now()-OLD.sla_paused_at,interval '0 seconds');
   IF OLD.sla_reacted_at IS NULL THEN NEW.sla_reaction_deadline=OLD.sla_reaction_deadline+elapsed; END IF;
   NEW.sla_execution_deadline=OLD.sla_execution_deadline+elapsed;
   NEW.sla_paused_at=NULL;
  END IF;
 END IF;
 IF NEW.status NOT IN ('NEW','ASSIGNED','CANCELLED') AND NEW.sla_reacted_at IS NULL THEN
  NEW.sla_reacted_at=now(); NEW.sla_execution_deadline=now()+make_interval(mins=>NEW.sla_execution_minutes);
 END IF;
 -- Explicit, audited OWNER correction; ordinary order edits cannot change clocks.
 IF TG_OP='UPDATE' AND COALESCE(current_setting('app.sla_override_request',true),'')=NEW.id::text THEN
  IF NEW.sla_paused_at IS NOT NULL THEN RAISE EXCEPTION 'Сначала возобновите SLA после ожидания'; END IF;
  IF NEW.sla_reacted_at IS NULL THEN NEW.sla_reaction_deadline=requested_deadline;
  ELSE NEW.sla_execution_deadline=requested_deadline; END IF;
 END IF;
 NEW.sla_deadline=CASE
  WHEN NEW.status IN ('PAYMENT_REQUIRED','CLOSED','CANCELLED') OR NEW.sla_paused_at IS NOT NULL THEN NULL
  WHEN NEW.sla_reacted_at IS NULL THEN NEW.sla_reaction_deadline
  ELSE NEW.sla_execution_deadline END;
 RETURN NEW;
END $$`,
`DROP TRIGGER IF EXISTS request_sla_clock ON requests`,
`CREATE TRIGGER request_sla_clock BEFORE INSERT OR UPDATE ON requests FOR EACH ROW EXECUTE FUNCTION request_sla_clock()`,
`CREATE TABLE IF NOT EXISTS dispatch_controls(request_id INT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,reason TEXT,owner_id INT REFERENCES users(id),control_due_at TIMESTAMPTZ,status TEXT NOT NULL DEFAULT 'OPEN',resolution TEXT,created_by INT REFERENCES users(id),updated_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now(),resolved_at TIMESTAMPTZ)`,
`CREATE INDEX IF NOT EXISTS idx_requests_sla_active ON requests(sla_deadline) WHERE sla_reaction_minutes IS NOT NULL AND deleted_at IS NULL`
];
