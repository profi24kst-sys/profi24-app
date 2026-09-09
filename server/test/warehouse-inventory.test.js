import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {warehouseBranchStatements} from '../src/warehouse-branch-schema.js';
import {prepareWarehouseInventory,installWarehouseInventory} from '../src/warehouse-inventory.js';

test('инвентаризация проводит только фактическую разницу и защищена от параллельных движений',async()=>{
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  let chain=Promise.resolve();
  const pool={query,connect:async()=>{const before=chain;let release;chain=new Promise(r=>release=r);await before;return{query,release}},end:async()=>{}};
  try{
    await migrateCore(pool);
    await query(`CREATE TABLE warehouse_items(id SERIAL PRIMARY KEY,sku TEXT UNIQUE,name TEXT NOT NULL,oem_code TEXT,supplier TEXT,purchase_price NUMERIC(14,2) DEFAULT 0,sale_price NUMERIC(14,2) DEFAULT 0,quantity NUMERIC(14,3) DEFAULT 0,min_quantity NUMERIC(14,3) DEFAULT 0,location TEXT,notes TEXT,active BOOLEAN DEFAULT true,created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now())`);
    await query(`CREATE TABLE warehouse_movements(id SERIAL PRIMARY KEY,item_id INT NOT NULL REFERENCES warehouse_items(id),movement_type TEXT NOT NULL CHECK(movement_type IN ('RECEIPT','ISSUE','RETURN','INSTALL','WRITE_OFF','ADJUSTMENT')),quantity NUMERIC(14,3) NOT NULL CHECK(quantity>0),engineer_id INT REFERENCES users(id),request_id INT REFERENCES requests(id),unit_cost NUMERIC(14,2) DEFAULT 0,sale_price NUMERIC(14,2) DEFAULT 0,supplier TEXT,comment TEXT,created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now())`);
    await query(`CREATE TABLE stock_reservations(id SERIAL PRIMARY KEY,item_id INT REFERENCES warehouse_items(id),request_id INT REFERENCES requests(id),quantity NUMERIC(14,3) NOT NULL,status TEXT DEFAULT 'ACTIVE',created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now(),released_at TIMESTAMPTZ)`);
    for(const sql of warehouseBranchStatements)await query(sql);
    await prepareWarehouseInventory(pool,{logger:{warn(){}}});

    const branch=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id;
    const owner=(await query("INSERT INTO users(name,email,password_hash,role,primary_branch_id) VALUES('Inventory Owner','inv-owner@test.invalid','x','OWNER',$1) RETURNING id",[branch])).rows[0].id;
    const supervisor=(await query("INSERT INTO users(name,email,password_hash,role,primary_branch_id) VALUES('Inventory Supervisor','inv-super@test.invalid','x','SUPERVISOR',$1) RETURNING id",[branch])).rows[0].id;
    const manager=(await query("INSERT INTO users(name,email,password_hash,role,primary_branch_id) VALUES('Inventory Manager','inv-manager@test.invalid','x','MANAGER',$1) RETURNING id",[branch])).rows[0].id;
    const a=(await query("INSERT INTO warehouse_items(branch_id,sku,name,quantity,purchase_price,sale_price,location) VALUES($1,'INV-A','Компрессор',5,10000,15000,'A-1') RETURNING id",[branch])).rows[0].id;
    const b=(await query("INSERT INTO warehouse_items(branch_id,sku,name,quantity,purchase_price,sale_price,location) VALUES($1,'INV-B','Насос',2,5000,8000,'B-1') RETURNING id",[branch])).rows[0].id;

    const app=Fastify({logger:false});await app.register(jwt,{secret:'i'.repeat(64)});installWarehouseInventory(app,pool);await app.ready();
    const token=(id,role)=>app.jwt.sign({id,role});
    const call=async(method,url,payload,t=token(owner,'OWNER'))=>{const r=await app.inject({method,url,payload,headers:{authorization:'Bearer '+t}});let body={};try{body=r.json()}catch{}return{status:r.statusCode,...body}};

    assert.equal((await call('POST','/api/v1/inventories',{branch_id:branch},token(manager,'MANAGER'))).status,403);
    let r=await call('POST','/api/v1/inventories',{branch_id:branch,note:'Полный пересчёт'});assert.equal(r.status,201);assert.equal(r.data.status,'DRAFT');assert.equal(r.data.lines.length,2);const first=r.data;
    assert.equal((await call('POST','/api/v1/inventories',{branch_id:branch},token(supervisor,'SUPERVISOR'))).status,409);
    const la=first.lines.find(x=>Number(x.item_id)===Number(a)),lb=first.lines.find(x=>Number(x.item_id)===Number(b));
    r=await call('PATCH',`/api/v1/inventories/${first.id}/lines/${la.id}`,{actual_quantity:4});assert.equal(r.status,200);
    r=await call('PATCH',`/api/v1/inventories/${first.id}/lines/${lb.id}`,{actual_quantity:4},token(supervisor,'SUPERVISOR'));assert.equal(r.status,200);
    r=await call('POST',`/api/v1/inventories/${first.id}/post`,{},token(supervisor,'SUPERVISOR'));assert.equal(r.status,200);assert.equal(r.data.status,'POSTED');assert.equal(Number(r.data.summary.variance_units),1);assert.equal(Number(r.data.summary.variance_value),0);
    assert.equal(Number((await query('SELECT quantity FROM warehouse_items WHERE id=$1',[a])).rows[0].quantity),4);
    assert.equal(Number((await query('SELECT quantity FROM warehouse_items WHERE id=$1',[b])).rows[0].quantity),4);
    const moves=(await query("SELECT item_id,quantity,comment FROM warehouse_movements WHERE movement_type='ADJUSTMENT' ORDER BY item_id")).rows;assert.equal(moves.length,2);assert.equal(Number(moves.find(x=>Number(x.item_id)===Number(a)).quantity),1);assert.equal(Number(moves.find(x=>Number(x.item_id)===Number(b)).quantity),2);assert.match(moves.find(x=>Number(x.item_id)===Number(a)).comment,/Недостача/);assert.match(moves.find(x=>Number(x.item_id)===Number(b)).comment,/Излишек/);
    assert.equal((await call('PATCH',`/api/v1/inventories/${first.id}/lines/${la.id}`,{actual_quantity:5})).status,409);
    await assert.rejects(query('UPDATE warehouse_inventory_lines SET note=$1 WHERE id=$2',['rewrite',la.id]),e=>e.code==='P2401');

    r=await call('POST','/api/v1/inventories',{branch_id:branch});assert.equal(r.status,201);const stale=r.data;for(const line of stale.lines)await call('PATCH',`/api/v1/inventories/${stale.id}/lines/${line.id}`,{actual_quantity:Number(line.expected_quantity)});
    await query('UPDATE warehouse_items SET quantity=quantity+1,updated_at=clock_timestamp() WHERE id=$1',[a]);
    await query("INSERT INTO warehouse_movements(item_id,movement_type,quantity,unit_cost,comment,created_by) VALUES($1,'RECEIPT',1,10000,'Параллельный приход',$2)",[a,owner]);
    r=await call('POST',`/api/v1/inventories/${stale.id}/post`,{});assert.equal(r.status,409);assert.equal(r.error.code,'INVENTORY_STALE');assert.equal((await query('SELECT status FROM warehouse_inventories WHERE id=$1',[stale.id])).rows[0].status,'DRAFT');
    r=await call('POST',`/api/v1/inventories/${stale.id}/cancel`,{reason:'Пересчёт устарел'});assert.equal(r.status,200);assert.equal(r.data.status,'CANCELLED');

    r=await call('POST','/api/v1/inventories',{branch_id:branch});assert.equal(r.status,201);const reservedDoc=r.data;const reservedLine=reservedDoc.lines.find(x=>Number(x.item_id)===Number(b));for(const line of reservedDoc.lines)await call('PATCH',`/api/v1/inventories/${reservedDoc.id}/lines/${line.id}`,{actual_quantity:Number(line.expected_quantity)});
    const customer=(await query("INSERT INTO customers(name,phone) VALUES('Inventory Customer','77000000888') RETURNING id")).rows[0].id;const request=(await query("INSERT INTO requests(number,customer_id,branch_id,status,complaint) VALUES('INV-REQ',$1,$2,'REPAIR','test') RETURNING id",[customer,branch])).rows[0].id;
    await query("INSERT INTO stock_reservations(item_id,request_id,quantity,status,created_by) VALUES($1,$2,3,'ACTIVE',$3)",[b,request,owner]);
    await call('PATCH',`/api/v1/inventories/${reservedDoc.id}/lines/${reservedLine.id}`,{actual_quantity:2});
    r=await call('POST',`/api/v1/inventories/${reservedDoc.id}/post`,{});assert.equal(r.status,409);assert.equal(r.error.code,'RESERVATION_CONFLICT');

    assert.equal((await call('GET','/api/v1/inventories',undefined,token(manager,'MANAGER'))).status,200);
    await app.close();
  }finally{await db.close()}
});
