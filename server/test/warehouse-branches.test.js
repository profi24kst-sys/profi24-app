import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {warehouseBranchStatements} from '../src/warehouse-branch-schema.js';

test('склад запрещает скрытое перемещение между филиалами и чужую материальную ответственность',async()=>{
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  const pool={query,connect:async()=>({query,release(){}}),end:async()=>{}};
  try{
    await migrateCore(pool);
    await query(`CREATE TABLE warehouse_items(id SERIAL PRIMARY KEY,sku TEXT UNIQUE,name TEXT NOT NULL,oem_code TEXT,supplier TEXT,purchase_price NUMERIC(14,2) DEFAULT 0,sale_price NUMERIC(14,2) DEFAULT 0,quantity NUMERIC(14,3) DEFAULT 0,min_quantity NUMERIC(14,3) DEFAULT 0,location TEXT,notes TEXT,active BOOLEAN DEFAULT true,created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now())`);
    await query(`CREATE TABLE warehouse_movements(id SERIAL PRIMARY KEY,item_id INT NOT NULL REFERENCES warehouse_items(id),movement_type TEXT NOT NULL CHECK(movement_type IN ('RECEIPT','ISSUE','RETURN','INSTALL','WRITE_OFF','ADJUSTMENT')),quantity NUMERIC(14,3) NOT NULL CHECK(quantity>0),engineer_id INT REFERENCES users(id),request_id INT REFERENCES requests(id),unit_cost NUMERIC(14,2) DEFAULT 0,sale_price NUMERIC(14,2) DEFAULT 0,supplier TEXT,comment TEXT,created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now())`);
    await query(`CREATE TABLE stock_reservations(id SERIAL PRIMARY KEY,item_id INT REFERENCES warehouse_items(id),request_id INT REFERENCES requests(id),quantity NUMERIC(14,3) NOT NULL,status TEXT DEFAULT 'ACTIVE',created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now(),released_at TIMESTAMPTZ)`);
    for(const sql of warehouseBranchStatements)await query(sql);

    const kst=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id;
    const other=(await query("INSERT INTO branches(code,name) VALUES('WH2','Второй склад') RETURNING id")).rows[0].id;
    const owner=(await query("INSERT INTO users(name,email,password_hash,role) VALUES('Owner WH','wh-owner@test.invalid','unused','OWNER') RETURNING id")).rows[0].id;
    const engineer=(await query("INSERT INTO users(name,email,password_hash,role) VALUES('Engineer WH','wh-engineer@test.invalid','unused','ENGINEER') RETURNING id")).rows[0].id;
    const customer=(await query("INSERT INTO customers(name,phone) VALUES('Warehouse Client','000') RETURNING id")).rows[0].id;
    const otherOrder=(await query("INSERT INTO requests(number,customer_id,branch_id,status,complaint) VALUES('WH-OTHER',$1,$2,'REPAIR','Test') RETURNING id",[customer,other])).rows[0].id;
    const item=(await query("INSERT INTO warehouse_items(branch_id,sku,name,quantity,purchase_price) VALUES($1,'WH-SKU','Компрессор',3,1000) RETURNING id",[kst])).rows[0].id;

    await assert.rejects(
      query("INSERT INTO warehouse_movements(item_id,movement_type,quantity,engineer_id,created_by) VALUES($1,'ISSUE',1,$2,$3)",[item,engineer,owner]),
      error=>error.code==='P2403'
    );
    await query('INSERT INTO user_branches(user_id,branch_id,is_primary) VALUES($1,$2,false)',[engineer,kst]);
    const movement=(await query("INSERT INTO warehouse_movements(item_id,movement_type,quantity,engineer_id,created_by) VALUES($1,'ISSUE',1,$2,$3) RETURNING id",[item,engineer,owner])).rows[0].id;

    await assert.rejects(
      query("INSERT INTO warehouse_movements(item_id,movement_type,quantity,engineer_id,request_id,created_by) VALUES($1,'INSTALL',1,$2,$3,$4)",[item,engineer,otherOrder,owner]),
      error=>error.code==='P2403'
    );
    await assert.rejects(query('UPDATE warehouse_items SET branch_id=$1 WHERE id=$2',[other,item]),error=>error.code==='P2401');
    await assert.rejects(query("UPDATE warehouse_movements SET comment='rewrite' WHERE id=$1",[movement]),error=>error.code==='P2401');

    const destination=(await query("INSERT INTO warehouse_items(branch_id,sku,name,quantity,purchase_price) VALUES($1,'WH-SKU','Компрессор',0,1000) RETURNING id",[other])).rows[0].id;
    const transfer=(await query(`INSERT INTO warehouse_transfers(transfer_key,from_branch_id,to_branch_id,source_item_id,destination_item_id,quantity,unit_cost,reason,document_reference,created_by) VALUES('wh-transfer-0001',$1,$2,$3,$4,1,1000,'Пополнение филиала','Накладная 1',$5) RETURNING id`,[kst,other,item,destination,owner])).rows[0].id;
    await assert.rejects(query("UPDATE warehouse_transfers SET reason='rewrite' WHERE id=$1",[transfer]),error=>error.code==='P2401');
  }finally{await db.close();}
});
