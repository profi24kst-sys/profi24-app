import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {buildSupplierPerformanceAnalytics,installSupplierPerformanceAnalytics} from '../src/supplier-performance-analytics.js';

test('рейтинг поставщиков сравнивает одинаковые позиции, сроки, переплату и branch scope',async()=>{
 const db=await PGlite.create();const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));const pool={query,end:async()=>{}};
 try{
  await migrateCore(pool);const kst=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id;const alt=(await query("INSERT INTO branches(code,name,timezone) VALUES('ALT','Другой филиал','Asia/Qostanay') RETURNING id")).rows[0].id;
  const owner=(await query("INSERT INTO users(name,email,password_hash,role,primary_branch_id) VALUES('Supplier Owner','supplier-owner@test.invalid','x','OWNER',$1) RETURNING id",[kst])).rows[0].id;
  const manager=(await query("INSERT INTO users(name,email,password_hash,role,primary_branch_id) VALUES('Supplier Manager','supplier-manager@test.invalid','x','MANAGER',$1) RETURNING id",[kst])).rows[0].id;
  const accountant=(await query("INSERT INTO users(name,email,password_hash,role,primary_branch_id) VALUES('Supplier Accountant','supplier-accountant@test.invalid','x','ACCOUNTANT',$1) RETURNING id",[kst])).rows[0].id;
  const engineer=(await query("INSERT INTO users(name,email,password_hash,role,primary_branch_id) VALUES('Supplier Engineer','supplier-engineer@test.invalid','x','ENGINEER',$1) RETURNING id",[kst])).rows[0].id;
  await query(`CREATE TABLE warehouse_items(id SERIAL PRIMARY KEY,branch_id INT NOT NULL REFERENCES branches(id),sku TEXT,name TEXT NOT NULL,oem_code TEXT,purchase_price NUMERIC(14,2) DEFAULT 0,active BOOLEAN DEFAULT true)`);
  await query(`CREATE TABLE suppliers(id SERIAL PRIMARY KEY,name TEXT NOT NULL,active BOOLEAN DEFAULT true)`);
  await query(`CREATE TABLE purchase_orders(id SERIAL PRIMARY KEY,number TEXT UNIQUE NOT NULL,supplier_id INT REFERENCES suppliers(id),branch_id INT NOT NULL REFERENCES branches(id),status TEXT DEFAULT 'DRAFT',expected_at DATE,created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now())`);
  await query(`CREATE TABLE purchase_order_items(id SERIAL PRIMARY KEY,purchase_order_id INT REFERENCES purchase_orders(id),item_id INT REFERENCES warehouse_items(id),name TEXT NOT NULL,qty NUMERIC(14,3) NOT NULL,unit_cost NUMERIC(14,2) DEFAULT 0,received_qty NUMERIC(14,3) DEFAULT 0)`);
  await query(`CREATE TABLE supplier_catalog_items(id BIGSERIAL PRIMARY KEY,supplier_id INT REFERENCES suppliers(id),purchase_price NUMERIC(14,2) NOT NULL,available_qty NUMERIC(14,3),lead_time_days INT,active BOOLEAN DEFAULT true,updated_at TIMESTAMPTZ DEFAULT now())`);
  await query(`CREATE TABLE supplier_catalog_links(catalog_item_id BIGINT REFERENCES supplier_catalog_items(id),branch_id INT REFERENCES branches(id),warehouse_item_id INT REFERENCES warehouse_items(id))`);
  const cheap=(await query("INSERT INTO suppliers(name) VALUES('Быстрый и дешёвый') RETURNING id")).rows[0].id,slow=(await query("INSERT INTO suppliers(name) VALUES('Дорогой и медленный') RETURNING id")).rows[0].id,remote=(await query("INSERT INTO suppliers(name) VALUES('Чужой филиал') RETURNING id")).rows[0].id;
  const item=(await query("INSERT INTO warehouse_items(branch_id,sku,name,oem_code,purchase_price) VALUES($1,'SUP-1','Компрессор SUP','OEM-SUP',1000) RETURNING id",[kst])).rows[0].id;
  const overdueItem=(await query("INSERT INTO warehouse_items(branch_id,sku,name,oem_code,purchase_price) VALUES($1,'SUP-LATE','Деталь для просрочки','OEM-LATE',1250) RETURNING id",[kst])).rows[0].id;
  const remoteItem=(await query("INSERT INTO warehouse_items(branch_id,sku,name,oem_code,purchase_price) VALUES($1,'SUP-ALT','Чужая деталь','OEM-ALT',5000) RETURNING id",[alt])).rows[0].id;
  const po1=(await query("INSERT INTO purchase_orders(number,supplier_id,branch_id,status,expected_at,created_by,created_at,updated_at) VALUES('PO-SUP-CHEAP',$1,$2,'RECEIVED','2026-08-08',$3,'2026-08-01T08:00:00Z','2026-08-06T08:00:00Z') RETURNING id",[cheap,kst,owner])).rows[0].id;
  await query("INSERT INTO purchase_order_items(purchase_order_id,item_id,name,qty,unit_cost,received_qty) VALUES($1,$2,'Компрессор SUP',5,1000,5)",[po1,item]);
  const po2=(await query("INSERT INTO purchase_orders(number,supplier_id,branch_id,status,expected_at,created_by,created_at,updated_at) VALUES('PO-SUP-SLOW',$1,$2,'RECEIVED','2026-08-08',$3,'2026-08-02T08:00:00Z','2026-08-14T08:00:00Z') RETURNING id",[slow,kst,owner])).rows[0].id;
  await query("INSERT INTO purchase_order_items(purchase_order_id,item_id,name,qty,unit_cost,received_qty) VALUES($1,$2,'Компрессор SUP',5,1200,5)",[po2,item]);
  const po3=(await query("INSERT INTO purchase_orders(number,supplier_id,branch_id,status,expected_at,created_by,created_at,updated_at) VALUES('PO-SUP-OVERDUE',$1,$2,'ORDERED','2026-09-01',$3,'2026-08-20T08:00:00Z','2026-08-20T08:00:00Z') RETURNING id",[slow,kst,owner])).rows[0].id;
  await query("INSERT INTO purchase_order_items(purchase_order_id,item_id,name,qty,unit_cost,received_qty) VALUES($1,$2,'Деталь для просрочки',2,1250,0)",[po3,overdueItem]);
  const po4=(await query("INSERT INTO purchase_orders(number,supplier_id,branch_id,status,expected_at,created_by,created_at,updated_at) VALUES('PO-SUP-ALT',$1,$2,'RECEIVED','2026-08-10',$3,'2026-08-01T08:00:00Z','2026-08-05T08:00:00Z') RETURNING id",[remote,alt,owner])).rows[0].id;
  await query("INSERT INTO purchase_order_items(purchase_order_id,item_id,name,qty,unit_cost,received_qty) VALUES($1,$2,'Чужая деталь',20,5000,20)",[po4,remoteItem]);
  const catCheap=(await query("INSERT INTO supplier_catalog_items(supplier_id,purchase_price,available_qty,lead_time_days) VALUES($1,950,20,3) RETURNING id",[cheap])).rows[0].id,catSlow=(await query("INSERT INTO supplier_catalog_items(supplier_id,purchase_price,available_qty,lead_time_days) VALUES($1,1100,20,7) RETURNING id",[slow])).rows[0].id;
  await query('INSERT INTO supplier_catalog_links(catalog_item_id,branch_id,warehouse_item_id) VALUES($1,$2,$3),($4,$2,$3)',[catCheap,kst,item,catSlow]);

  const now=new Date('2026-09-09T12:00:00Z');let data=await buildSupplierPerformanceAnalytics(pool,{days:365,now});assert.equal(data.summary.suppliers,3);assert.equal(data.summary.orders,4);assert.equal(data.summary.possible_savings,1000);assert.equal(data.price_opportunities.length,1);assert.equal(data.price_opportunities[0].supplier_id,Number(slow));assert.equal(data.price_opportunities[0].best_unit_cost,1000);assert.equal(data.price_opportunities[0].actual_unit_cost,1200);assert.equal(data.price_opportunities[0].possible_saving,1000);assert.ok(data.monthly.some(x=>x.month==='2026-08'));
  const cheapRow=data.suppliers.find(x=>x.supplier_id===Number(cheap)),slowRow=data.suppliers.find(x=>x.supplier_id===Number(slow));assert.equal(cheapRow.on_time_rate,100);assert.equal(slowRow.on_time_rate,0);assert.equal(slowRow.price_premium_pct,20);assert.equal(slowRow.overdue_open_orders,1);assert.ok(slowRow.monthly.some(x=>x.month==='2026-08'&&Number(x.possible_savings)===1000));assert.ok(cheapRow.score>slowRow.score);assert.ok(data.summary.overdue_open_value>=2500);assert.ok(data.summary.top_supplier_share>80,'remote branch should dominate owner-wide spend');
  data=await buildSupplierPerformanceAnalytics(pool,{branchIds:[Number(kst)],days:365,now});assert.equal(data.summary.suppliers,2);assert.equal(data.suppliers.some(x=>x.supplier_id===Number(remote)),false);assert.equal(data.summary.possible_savings,1000);assert.ok(data.summary.top_supplier_share<80);

  const app=Fastify({logger:false});await app.register(jwt,{secret:'s'.repeat(64)});const procurementView=async(req,reply)=>{try{await req.jwtVerify()}catch{return reply.code(401).send({data:null,error:{code:'UNAUTHORIZED'}})}if(!['OWNER','SUPERVISOR','ACCOUNTANT','MANAGER'].includes(req.user.role))return reply.code(403).send({data:null,error:{code:'FORBIDDEN'}})};installSupplierPerformanceAnalytics(app,pool,{procurementView});await app.ready();const token=(id,role)=>app.jwt.sign({id,role});
  const call=async(userId,role,url='/api/v1/supplier-performance')=>{const r=await app.inject({method:'GET',url,headers:{authorization:'Bearer '+token(userId,role)}});return{status:r.statusCode,body:r.json()}};
  let r=await call(manager,'MANAGER');assert.equal(r.status,200);assert.equal(r.body.data.suppliers.length,2);assert.equal(r.body.data.suppliers.some(x=>x.supplier_id===Number(remote)),false);r=await call(manager,'MANAGER',`/api/v1/supplier-performance?branch_id=${alt}`);assert.equal(r.status,403);r=await call(accountant,'ACCOUNTANT');assert.equal(r.status,200);assert.equal(r.body.data.suppliers.length,3);r=await call(engineer,'ENGINEER');assert.equal(r.status,403);await app.close();
 }finally{await db.close()}
});
