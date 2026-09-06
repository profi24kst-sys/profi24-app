export const branchStatements=[
  `CREATE TABLE IF NOT EXISTS branches(
    id SERIAL PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    address TEXT,
    timezone TEXT NOT NULL DEFAULT 'Asia/Qostanay',
    active BOOLEAN NOT NULL DEFAULT true,
    created_by INT REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `INSERT INTO branches(code,name,address,timezone,active)
   VALUES('KST','Костанай','ул. Орджоникидзе 25','Asia/Qostanay',true)
   ON CONFLICT(code) DO NOTHING`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS primary_branch_id INT REFERENCES branches(id)`,
  `UPDATE users SET primary_branch_id=(SELECT id FROM branches WHERE code='KST') WHERE primary_branch_id IS NULL`,
  `CREATE TABLE IF NOT EXISTS user_branches(
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    branch_id INT NOT NULL REFERENCES branches(id),
    is_primary BOOLEAN NOT NULL DEFAULT false,
    assigned_by INT REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(user_id,branch_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_user_branches_primary ON user_branches(user_id) WHERE is_primary=true`,
  `INSERT INTO user_branches(user_id,branch_id,is_primary)
   SELECT u.id,u.primary_branch_id,true FROM users u
   WHERE u.primary_branch_id IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM user_branches ub WHERE ub.user_id=u.id)
   ON CONFLICT(user_id,branch_id) DO NOTHING`,
  `CREATE OR REPLACE FUNCTION branch_default_user() RETURNS trigger AS $$
   BEGIN
     IF NEW.primary_branch_id IS NULL THEN
       SELECT id INTO NEW.primary_branch_id FROM branches WHERE code='KST' AND active=true LIMIT 1;
     END IF;
     IF NOT EXISTS(SELECT 1 FROM branches WHERE id=NEW.primary_branch_id AND active=true) THEN
       RAISE EXCEPTION 'Основной филиал сотрудника не найден или отключён' USING ERRCODE='P2403';
     END IF;
     RETURN NEW;
   END $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_branch_default_user ON users`,
  `CREATE TRIGGER trg_branch_default_user BEFORE INSERT OR UPDATE OF primary_branch_id ON users FOR EACH ROW EXECUTE FUNCTION branch_default_user()`,
  `CREATE OR REPLACE FUNCTION branch_sync_primary_membership() RETURNS trigger AS $$
   BEGIN
     UPDATE user_branches SET is_primary=false WHERE user_id=NEW.id AND branch_id<>NEW.primary_branch_id AND is_primary=true;
     INSERT INTO user_branches(user_id,branch_id,is_primary,assigned_by)
       VALUES(NEW.id,NEW.primary_branch_id,true,NULL)
       ON CONFLICT(user_id,branch_id) DO UPDATE SET is_primary=true;
     RETURN NEW;
   END $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_branch_sync_primary_membership ON users`,
  `CREATE TRIGGER trg_branch_sync_primary_membership AFTER INSERT OR UPDATE OF primary_branch_id ON users FOR EACH ROW EXECUTE FUNCTION branch_sync_primary_membership()`,
  `ALTER TABLE requests ADD COLUMN IF NOT EXISTS branch_id INT REFERENCES branches(id)`,
  `UPDATE requests SET branch_id=(SELECT id FROM branches WHERE code='KST') WHERE branch_id IS NULL`,
  `CREATE OR REPLACE FUNCTION branch_guard_request() RETURNS trigger AS $$
   DECLARE resolved_branch INT;
   BEGIN
     resolved_branch:=NEW.branch_id;
     IF resolved_branch IS NULL AND NEW.manager_id IS NOT NULL THEN
       SELECT primary_branch_id INTO resolved_branch FROM users WHERE id=NEW.manager_id AND active=true;
     END IF;
     IF resolved_branch IS NULL THEN
       SELECT id INTO resolved_branch FROM branches WHERE code='KST' AND active=true LIMIT 1;
     END IF;
     IF NOT EXISTS(SELECT 1 FROM branches WHERE id=resolved_branch AND active=true) THEN
       RAISE EXCEPTION 'Филиал заказа не найден или отключён' USING ERRCODE='P2403';
     END IF;
     NEW.branch_id:=resolved_branch;
     IF NEW.engineer_id IS NOT NULL AND NOT EXISTS(
       SELECT 1 FROM users u JOIN user_branches ub ON ub.user_id=u.id
       WHERE u.id=NEW.engineer_id AND u.active=true AND u.role='ENGINEER' AND ub.branch_id=resolved_branch
     ) THEN
       RAISE EXCEPTION 'Инженер не относится к филиалу заказа' USING ERRCODE='P2403';
     END IF;
     RETURN NEW;
   END $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_branch_guard_request ON requests`,
  `CREATE TRIGGER trg_branch_guard_request BEFORE INSERT OR UPDATE OF branch_id,engineer_id,manager_id ON requests FOR EACH ROW EXECUTE FUNCTION branch_guard_request()`,
  `CREATE INDEX IF NOT EXISTS idx_requests_branch_status ON requests(branch_id,status)`,
  `CREATE INDEX IF NOT EXISTS idx_user_branches_branch ON user_branches(branch_id,user_id)`
];
