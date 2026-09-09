import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {prepareProcurementReplenishment,buildReplenishmentPlan,installProcurementReplenishment} from '../src/procurement-replenishment.js';

test('план закупок учитывает склад, резервы, сервисную потребность и уже заказанное',async()=>{
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  let chain=Promise.resolve();
  const pool={query,connect:async()=>{const before=chain;let release;chain=new Promise(r=>release=r);await before;return{query,release}},end:async()=>{}};
  try{
    await migrateCore(pool);
    const branch=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id;
    const owner=(await query("INSERT INTO users(name,email,password_hash,role,primary_branch_id) VALUES('Replenishment Owner','rpl-owner@test.invalid','x','OWNER',$1) RETURNING id",[branch])).rows[0].id;
    const manager=(await query("INSERT INTO users(name,email,password_hash,role,primary_branch_id) VALUES('Replenishment Manager','rpl-manager@test.invalid','x','MANAGER',$1) RETURNING id",[branch])).rows[0].id;
    const accountant=(await query("INSERT INTO users(name,email,password_hash,role,primary_branch_id) VALUES('Replenishment Accountant','rpl-accountant@test.invalid','x','ACCOUNTANT',$1) RETURNING id",[branch])).rows[0].id;
    const customer=(await query("INSERT INTO customers(name,phone) VALUES('Replenishment Client','77000000222') RETURNING id")).rows[0].id;
    const request=(await query("INSERT INTO requests(number,customer_id,branch_id,status,complaint) VALUES('RPL-REQ-1',$1,$2,'WAITING_PART','test') RETURNING id",[customer,branch])).rows[0].id;

    await query(`CREATE TABLE warehouse_items(
      id SERIAL PRIMARY KEY,branch_id INT NOT NULL REFERENCES branches(id),sku TEXT,name TEXT NOT NULL,oem_code TEXT,supplier TEXT,
      purchase_price NUMERIC(14,2) DEFAULT 0,sale_price NUMERIC(14,2) DEFAULT 0,quantity NUMERIC(14,3) DEFAULT 0,min_quantity NUMERIC(14,3) DEFAULT 0,
      location TEXT,active BOOLEAN DEFAULT true,updated_at TIMESTAMPTZ DEFAULT now()
    )`);
    await query(`CREATE TABLE warehouse_movements(
      id SERIAL PRIMARY KEY,item_id INT NOT NULL REFERENCES warehouse_items(id),movement_type TEXT NOT NULL,quantity NUMERIC(14,3) NOT NULL,
      unit_cost NUMERIC(14,2) DEFAULT 0,created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await query(`CREATE TABLE stock_reservations(
      id SERIAL PRIMARY KEY,item_id INT REFERENCES warehouse_items(id),request_id INT REFERENCES requests(id),quantity NUMERIC(14,3) NOT NULL,
      status TEXT DEFAULT 'ACTIVE',created_by INT REFERENCES users(id),branch_id INT REFERENCES branches(id),created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await query(`CREATE TABLE suppliers(id SERIAL PRIMARY KEY,name TEXT NOT NULL,active BOOLEAN DEFAULT true)`);
    await query(`CREATE TABLE purchase_orders(
      id SERIAL PRIMARY KEY,number TEXT UNIQUE NOT NULL,supplier_id INT REFERENCES suppliers(id),branch_id INT NOT NULL REFERENCES branches(id),status TEXT DEFAULT 'DRAFT',
      expected_at DATE,comment TEXT,created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now()
    )`);
    await query(`CREATE TABLE purchase_order_items(
      id SERIAL PRIMARY KEY,purchase_order_id INT REFERENCES purchase_orders(id) ON DELETE CASCADE,item_id INT REFERENCES warehouse_items(id),name TEXT NOT NULL,
      qty NUMERIC(14,3) NOT NULL,unit_cost NUMERIC(14,2) DEFAULT 0,received_qty NUMERIC(14,3) DEFAULT 0
    )`);
    await query(`CREATE TABLE part_demands(
      id BIGSERIAL PRIMARY KEY,request_id INT NOT NULL REFERENCES requests(id),item_id INT NOT NULL REFERENCES warehouse_items(id),qty NUMERIC(14,3) NOT NULL,
      status TEXT NOT NULL DEFAULT 'NEED_PURCHASE',branch_id INT NOT NULL REFERENCES branches(id)
    )`);
    await query(`CREATE TABLE supplier_catalog_items(
      id BIGSERIAL PRIMARY KEY,supplier_id INT NOT NULL REFERENCES suppliers(id),purchase_price NUMERIC(14,2) NOT NULL DEFAULT 0,
      available_qty NUMERIC(14,3),lead_time_days INT,currency TEXT DEFAULT 'KZT',active BOOLEAN DEFAULT true
    )`);
    await query(`CREATE TABLE supplier_catalog_links(
      catalog_item_id BIGINT NOT NULL REFERENCES supplier_catalog_items(id),branch_id INT NOT NULL REFERENCES branches(id),warehouse_item_id INT NOT NULL REFERENCES warehouse_items(id)
    )`);

    const supplier=(await query("INSERT INTO suppliers(name) VALUES('Parts Partner') RETURNING id")).rows[0].id;
    const item=(await query("INSERT INTO warehouse_items(branch_id,sku,name,oem_code,supplier,purchase_price,sale_price,quantity,min_quantity) VALUES($1,'RPL-COMP','Компрессор RPL','OEM-RPL','Parts Partner',1000,1600,2,5) RETURNING id",[branch])).rows[0].id;
    await query("INSERT INTO stock_reservations(item_id,request_id,quantity,status,created_by,branch_id) VALUES($1,$2,1,'ACTIVE',$3,$4)",[item,request,owner,branch]);
    await query("INSERT INTO part_demands(request_id,item_id,qty,status,branch_id) VALUES($1,$2,2,'NEED_PURCHASE',$3)",[request,item,branch]);
    const oldPo=(await query("INSERT INTO purchase_orders(number,supplier_id,branch_id,status,expected_at,comment,created_by,created_at) VALUES('PO-OLD-RPL',$1,$2,'ORDERED',CURRENT_DATE-3,'старый заказ',$3,now()-interval '10 days') RETURNING id",[supplier,branch,owner])).rows[0].id;
    await query("INSERT INTO purchase_order_items(purchase_order_id,item_id,name,qty,unit_cost,received_qty) VALUES($1,$2,'Компрессор RPL',1,900,0)",[oldPo,item]);
    const catalog=(await query("INSERT INTO supplier_catalog_items(supplier_id,purchase_price,available_qty,lead_time_days,currency) VALUES($1,800,20,3,'KZT') RETURNING id",[supplier])).rows[0].id;
    await query('INSERT INTO supplier_catalog_links(catalog_item_id,branch_id,warehouse_item_id) VALUES($1,$2,$3)',[catalog,branch,item]);
    await query("INSERT INTO warehouse_movements(item_id,movement_type,quantity,unit_cost,created_at) VALUES($1,'INSTALL',6,1000,now()-interval '20 days'),($1,'INSTALL',3,1000,now()-interval '60 days')",[item]);

    await prepareProcurementReplenishment(pool,{logger:{warn(){}}});
    let rows=await buildReplenishmentPlan(pool,{needOnly:true});
    assert.equal(rows.length,1);
    const line=rows[0];
    assert.equal(Number(line.stock_quantity),2);
    assert.equal(Number(line.min_quantity),5);
    assert.equal(Number(line.reserved_quantity),1);
    assert.equal(Number(line.service_demand_quantity),2);
    assert.equal(Number(line.pending_order_quantity),1);
    assert.equal(Number(line.recommended_quantity),5);
    assert.equal(line.priority,'CRITICAL');
    assert.equal(Number(line.best_supplier_id),Number(supplier));
    assert.equal(Number(line.best_unit_cost),800);
    assert.equal(Number(line.estimated_value),4000);
    assert.equal(Number(line.consumption_30d),6);
    assert.equal(Number(line.consumption_90d),9);

    const app=Fastify({logger:false});
    await app.register(jwt,{secret:'r'.repeat(64)});
    const auth=async(req,reply)=>{try{await req.jwtVerify()}catch{return reply.code(401).send({data:null,error:{code:'UNAUTHORIZED',message:'auth'}})}};
    const view=auth;
    const manage=async(req,reply)=>{await auth(req,reply);if(reply.sent)return;if(!['OWNER','SUPERVISOR','MANAGER'].includes(req.user.role))return reply.code(403).send({data:null,error:{code:'FORBIDDEN',message:'no'}})};
    const branchIds=async user=>['OWNER','SUPERVISOR','ACCOUNTANT'].includes(user.role)?null:[branch];
    installProcurementReplenishment(app,pool,{view,manage,branchIds});await app.ready();
    const token=(id,role)=>app.jwt.sign({id,role});
    const call=async(method,url,payload,t=token(owner,'OWNER'))=>{const r=await app.inject({method,url,payload,headers:{authorization:'Bearer '+t}});let body={};try{body=r.json()}catch{}return{status:r.statusCode,...body}};

    let r=await call('GET','/api/v1/replenishment');assert.equal(r.status,200);assert.equal(r.data.summary.positions,1);assert.equal(r.data.summary.critical,1);assert.equal(r.data.summary.overdue_orders,1);assert.equal(r.data.attention_orders[0].number,'PO-OLD-RPL');assert.equal(r.data.attention_orders[0].overdue,true);
    r=await call('POST','/api/v1/replenishment/orders',{idempotency_key:'rpl-test-key',items:[{item_id:item}]},token(accountant,'ACCOUNTANT'));assert.equal(r.status,403);
    r=await call('POST','/api/v1/replenishment/orders',{idempotency_key:'rpl-test-key',items:[{item_id:item}]},token(manager,'MANAGER'));assert.equal(r.status,201,JSON.stringify(r));const batch=r.data;assert.equal(batch.lines.length,1);assert.equal(Number(batch.lines[0].ordered_quantity),5);assert.equal(Number(batch.lines[0].unit_cost),800);
    const poCount1=Number((await query("SELECT count(*) n FROM purchase_orders WHERE comment LIKE 'Автопополнение по плану %'")).rows[0].n);assert.equal(poCount1,1);
    r=await call('POST','/api/v1/replenishment/orders',{idempotency_key:'rpl-test-key',items:[{item_id:item}]},token(manager,'MANAGER'));assert.equal(r.status,200);assert.equal(Number(r.data.id),Number(batch.id));
    const poCount2=Number((await query("SELECT count(*) n FROM purchase_orders WHERE comment LIKE 'Автопополнение по плану %'")).rows[0].n);assert.equal(poCount2,1);
    rows=await buildReplenishmentPlan(pool,{needOnly:true});assert.equal(rows.length,0);
    r=await call('POST','/api/v1/replenishment/orders',{idempotency_key:'rpl-fresh-key',items:[{item_id:item}]},token(manager,'MANAGER'));assert.equal(r.status,409);assert.equal(r.error.code,'NO_REPLENISHMENT');
    await assert.rejects(query('UPDATE procurement_replenishment_batches SET total_value=0 WHERE id=$1',[batch.id]),e=>e.code==='P2401');
    await assert.rejects(query('UPDATE procurement_replenishment_lines SET ordered_quantity=1 WHERE batch_id=$1',[batch.id]),e=>e.code==='P2401');
    await app.close();
  }finally{await db.close()}
});
