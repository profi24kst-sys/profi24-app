import pg from 'pg';

const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const statements=[
  `CREATE SEQUENCE IF NOT EXISTS request_number_seq START 1001`,
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_norm TEXT`,
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS notes TEXT`,
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`,
  `UPDATE customers SET phone_norm=regexp_replace(phone,'\\D','','g') WHERE phone_norm IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_customers_phone_norm ON customers(phone_norm)`,
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
  `CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status)`,
  `CREATE INDEX IF NOT EXISTS idx_requests_engineer ON requests(engineer_id,status)`,
  `CREATE INDEX IF NOT EXISTS idx_requests_customer ON requests(customer_id,created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS payments(id SERIAL PRIMARY KEY,request_id INT NOT NULL REFERENCES requests(id),amount NUMERIC(14,2) NOT NULL CHECK(amount>0),method TEXT NOT NULL DEFAULT 'KASPI',kind TEXT NOT NULL DEFAULT 'PAYMENT' CHECK(kind IN ('PAYMENT','REFUND')),reference TEXT,created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS parts(id SERIAL PRIMARY KEY,request_id INT NOT NULL REFERENCES requests(id),name TEXT NOT NULL,oem_code TEXT,qty NUMERIC(10,2) NOT NULL DEFAULT 1,purchase_price NUMERIC(14,2) DEFAULT 0,sale_price NUMERIC(14,2) DEFAULT 0,supplier TEXT,status TEXT NOT NULL DEFAULT 'REQUESTED',eta DATE,created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS approvals(id SERIAL PRIMARY KEY,request_id INT NOT NULL REFERENCES requests(id),version INT NOT NULL DEFAULT 1,amount NUMERIC(14,2) NOT NULL,channel TEXT NOT NULL DEFAULT 'PHONE',status TEXT NOT NULL DEFAULT 'APPROVED',comment TEXT,created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS complaints(id SERIAL PRIMARY KEY,number TEXT UNIQUE NOT NULL,request_id INT REFERENCES requests(id),customer_id INT NOT NULL REFERENCES customers(id),text TEXT NOT NULL,severity TEXT NOT NULL DEFAULT 'NORMAL',status TEXT NOT NULL DEFAULT 'OPEN',classification TEXT,resolution TEXT,responsible_id INT REFERENCES users(id),created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now(),closed_at TIMESTAMPTZ)`,
  `CREATE TABLE IF NOT EXISTS tasks(id SERIAL PRIMARY KEY,title TEXT NOT NULL,request_id INT REFERENCES requests(id),assigned_to INT NOT NULL REFERENCES users(id),priority TEXT NOT NULL DEFAULT 'NORMAL',status TEXT NOT NULL DEFAULT 'OPEN',due_at TIMESTAMPTZ,created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now(),completed_at TIMESTAMPTZ)`,
  `CREATE TABLE IF NOT EXISTS quality_incidents(id SERIAL PRIMARY KEY,request_id INT REFERENCES requests(id),employee_id INT REFERENCES users(id),category TEXT NOT NULL,description TEXT NOT NULL,financial_impact NUMERIC(14,2) DEFAULT 0,root_cause TEXT,prevention TEXT,status TEXT NOT NULL DEFAULT 'OPEN',created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now(),closed_at TIMESTAMPTZ)`
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
