export const equipmentPickupStatements=[
  `CREATE TABLE IF NOT EXISTS equipment_pickup_settings(
    id INT PRIMARY KEY CHECK(id=1),
    active BOOLEAN NOT NULL DEFAULT true,
    storage_days SMALLINT NOT NULL DEFAULT 7 CHECK(storage_days BETWEEN 1 AND 90),
    reminder_interval_days SMALLINT NOT NULL DEFAULT 3 CHECK(reminder_interval_days BETWEEN 1 AND 30),
    updated_by INT REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `INSERT INTO equipment_pickup_settings(id,active,storage_days,reminder_interval_days)
    VALUES(1,true,7,3) ON CONFLICT(id) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS equipment_pickup_states(
    id BIGSERIAL PRIMARY KEY,
    request_id INT NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
    customer_id INT NOT NULL REFERENCES customers(id),
    branch_id INT REFERENCES branches(id),
    status TEXT NOT NULL DEFAULT 'WAITING' CHECK(status IN ('WAITING','PICKED_UP','CANCELLED')),
    ready_at TIMESTAMPTZ NOT NULL,
    storage_due_at TIMESTAMPTZ NOT NULL,
    picked_up_at TIMESTAMPTZ,
    reminder_count INT NOT NULL DEFAULT 0 CHECK(reminder_count>=0),
    last_reminder_at TIMESTAMPTZ,
    escalation_task_id INT REFERENCES tasks(id),
    last_holder TEXT,
    source_history_id BIGINT REFERENCES request_history(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_equipment_pickup_waiting ON equipment_pickup_states(status,storage_due_at,last_reminder_at)`,
  `CREATE INDEX IF NOT EXISTS idx_equipment_pickup_branch ON equipment_pickup_states(branch_id,status,storage_due_at)`
];
