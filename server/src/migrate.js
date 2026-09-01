import pg from 'pg';

const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const statements=[
  `CREATE SEQUENCE IF NOT EXISTS request_number_seq START 1001`,
  `CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('OWNER','MANAGER','ENGINEER')),active BOOLEAN DEFAULT TRUE,created_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS customers(id SERIAL PRIMARY KEY,name TEXT NOT NULL,phone TEXT NOT NULL,email TEXT,address TEXT,created_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS equipment(id SERIAL PRIMARY KEY,customer_id INT REFERENCES customers(id) ON DELETE CASCADE,category TEXT NOT NULL,brand TEXT,model TEXT,serial_number TEXT,created_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS requests(id SERIAL PRIMARY KEY,number TEXT UNIQUE NOT NULL,customer_id INT REFERENCES customers(id),equipment_id INT REFERENCES equipment(id),engineer_id INT REFERENCES users(id),status TEXT NOT NULL DEFAULT 'NEW',priority TEXT NOT NULL DEFAULT 'NORMAL',complaint TEXT NOT NULL,diagnosis TEXT,work_description TEXT,total NUMERIC(12,2) DEFAULT 0,paid NUMERIC(12,2) DEFAULT 0,scheduled_at TIMESTAMPTZ,sla_deadline TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT now(),closed_at TIMESTAMPTZ)`,
  `CREATE TABLE IF NOT EXISTS request_history(id SERIAL PRIMARY KEY,request_id INT REFERENCES requests(id) ON DELETE CASCADE,user_id INT REFERENCES users(id),action TEXT NOT NULL,details JSONB DEFAULT '{}',created_at TIMESTAMPTZ DEFAULT now())`,
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_norm TEXT`,
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS notes TEXT`,
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`,
  `UPDATE customers SET phone_norm=regexp_replace(phone,'\\D','','g') WHERE phone_norm IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_customers_phone_norm ON customers(phone_norm)`,
  `ALTER TABLE equipment DROP CONSTRAINT IF EXISTS equipment_customer_id_fkey`,
  `ALTER TABLE equipment ADD CONSTRAINT equipment_customer_id_fkey FOREIGN KEY(customer_id) REFERENCES customers(id)`,
  `ALTER TABLE equipment ADD COLUMN IF NOT EXISTS notes TEXT`,
  `ALTER TABLE equipment ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`,
  `ALTER TABLE requests ADD COLUMN IF NOT EXISTS manager_id INT REFERENCES users(id)`,
  `ALTER TABLE requests ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'OTHER'`,
  `ALTER TABLE requests ADD COLUMN IF NOT EXISTS test_result TEXT`,
  `ALTER TABLE requests ADD COLUMN IF NOT EXISTS warranty_until DATE`,
  `ALTER TABLE requests ADD COLUMN IF NOT EXISTS direct_cost NUMERIC(14,2) DEFAULT 0`,
  `ALTER TABLE requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`,
  `ALTER TABLE requests ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`,
  `ALTER TABLE requests ADD COLUMN IF NOT EXISTS original_request_id INT REFERENCES requests(id)`,
  `ALTER TABLE requests ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
  `ALTER TABLE requests ADD COLUMN IF NOT EXISTS deleted_by INT REFERENCES users(id)`,
  `ALTER TABLE requests ADD COLUMN IF NOT EXISTS delete_reason TEXT`,
  `ALTER TABLE requests ADD COLUMN IF NOT EXISTS deleted_snapshot JSONB`,
  `CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status)`,
  `CREATE INDEX IF NOT EXISTS idx_requests_engineer ON requests(engineer_id,status)`,
  `CREATE INDEX IF NOT EXISTS idx_requests_customer ON requests(customer_id,created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_requests_deleted ON requests(deleted_at)`,
  `CREATE TABLE IF NOT EXISTS payments(id SERIAL PRIMARY KEY,request_id INT NOT NULL REFERENCES requests(id),amount NUMERIC(14,2) NOT NULL CHECK(amount>0),method TEXT NOT NULL DEFAULT 'KASPI',kind TEXT NOT NULL DEFAULT 'PAYMENT' CHECK(kind IN ('PAYMENT','REFUND')),reference TEXT,created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS parts(id SERIAL PRIMARY KEY,request_id INT NOT NULL REFERENCES requests(id),name TEXT NOT NULL,oem_code TEXT,qty NUMERIC(10,2) NOT NULL DEFAULT 1,purchase_price NUMERIC(14,2) DEFAULT 0,sale_price NUMERIC(14,2) DEFAULT 0,supplier TEXT,status TEXT NOT NULL DEFAULT 'REQUESTED',eta DATE,created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS approvals(id SERIAL PRIMARY KEY,request_id INT NOT NULL REFERENCES requests(id),version INT NOT NULL DEFAULT 1,amount NUMERIC(14,2) NOT NULL,channel TEXT NOT NULL DEFAULT 'PHONE',status TEXT NOT NULL DEFAULT 'APPROVED',comment TEXT,created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS complaints(id SERIAL PRIMARY KEY,number TEXT UNIQUE NOT NULL,request_id INT REFERENCES requests(id),customer_id INT NOT NULL REFERENCES customers(id),text TEXT NOT NULL,severity TEXT NOT NULL DEFAULT 'NORMAL',status TEXT NOT NULL DEFAULT 'OPEN',classification TEXT,resolution TEXT,responsible_id INT REFERENCES users(id),created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now(),closed_at TIMESTAMPTZ)`,
  `CREATE TABLE IF NOT EXISTS tasks(id SERIAL PRIMARY KEY,title TEXT NOT NULL,request_id INT REFERENCES requests(id),assigned_to INT NOT NULL REFERENCES users(id),priority TEXT NOT NULL DEFAULT 'NORMAL',status TEXT NOT NULL DEFAULT 'OPEN',due_at TIMESTAMPTZ,created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now(),completed_at TIMESTAMPTZ)`,
  `CREATE TABLE IF NOT EXISTS quality_incidents(id SERIAL PRIMARY KEY,request_id INT REFERENCES requests(id),employee_id INT REFERENCES users(id),category TEXT NOT NULL,description TEXT NOT NULL,financial_impact NUMERIC(14,2) DEFAULT 0,root_cause TEXT,prevention TEXT,status TEXT NOT NULL DEFAULT 'OPEN',created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now(),closed_at TIMESTAMPTZ)`,
  `CREATE OR REPLACE FUNCTION release_reservations_on_request_soft_delete() RETURNS trigger AS $$ BEGIN IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND to_regclass('public.stock_reservations') IS NOT NULL THEN EXECUTE 'UPDATE stock_reservations SET status=''RELEASED_DELETED'',released_at=now() WHERE request_id=$1 AND status=''ACTIVE''' USING NEW.id; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_release_reservations_on_request_soft_delete ON requests`,
  `CREATE TRIGGER trg_release_reservations_on_request_soft_delete AFTER UPDATE OF deleted_at ON requests FOR EACH ROW EXECUTE FUNCTION release_reservations_on_request_soft_delete()`,
  `DO $$ BEGIN IF to_regclass('public.stock_reservations') IS NOT NULL THEN UPDATE stock_reservations sr SET status='RELEASED_DELETED',released_at=COALESCE(sr.released_at,now()) FROM requests r WHERE sr.request_id=r.id AND sr.status='ACTIVE' AND r.deleted_at IS NOT NULL; END IF; END $$`
];

try{
  for(const sql of statements) await pool.query(sql);
  console.log(`Applied ${statements.length} database migration statements`);
}catch(error){
  console.error('Migration failed:',error);
  process.exitCode=1;
}finally{
  await pool.end();
}
