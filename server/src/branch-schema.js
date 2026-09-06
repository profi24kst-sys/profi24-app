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
  `ALTER TABLE requests ADD COLUMN IF NOT EXISTS branch_id INT REFERENCES branches(id)`,
  `UPDATE requests SET branch_id=(SELECT id FROM branches WHERE code='KST') WHERE branch_id IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_requests_branch_status ON requests(branch_id,status)`,
  `CREATE INDEX IF NOT EXISTS idx_user_branches_branch ON user_branches(branch_id,user_id)`
];
