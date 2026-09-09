import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {buildWarehouseStockAnalytics,installWarehouseStockAnalytics,resolveWarehouseBranchIds} from '../src/warehouse-stock-analytics.js';

test('аналитика склада выявляет неликвид, ABC/XYZ и межфилиальное перемещение',async()=>{
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  const pool={query,connect:async()=>({query,release(){}}),end:async()=>{}};
  const now=new Date('2026-09-09T08:00:00Z');
  try{
    await migrateCore(pool);
    const kst=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id;
    const tld=(await query("INSERT INTO branches(code,name,address,timezone,active) VALUES('TLD','Талдыкорган','Шевченко 68','Asia/Almaty',true) RETURNING id")).rows[0].id;
    const owner=(await query("INSERT INTO users(name,email,password_hash,role,primary_branch_id) VALUES('Stock Analytics Owner','wa-owner@test.invalid','x','OWNER',$1) RETURNING id",[kst])).rows[0].id;
    const manager=(await query("INSERT INTO users(name,email,password_hash,role,primary_branch_id) VALUES('Stock Analytics Manager','wa-manager@test.invalid','x','MANAGER',$1) RETURNING id",[kst])).rows[0].id;
    const engineer=(await query("INSERT INTO users(name,email,password_hash,role,primary_branch_id) VALUES('Stock Analytics Engineer','wa-engineer@test.invalid','x','ENGINEER',$1) RETURNING id",[kst])).rows[0].id;

    await query(`CREATE TABLE warehouse_items(
      id SERIAL PRIMARY KEY,branch_id INT NOT NULL REFERENCES branches(id),sku TEXT,name TEXT NOT NULL,oem_code TEXT,supplier TEXT,
      purchase_price NUMERIC(14,2) DEFAULT 0,sale_price NUMERIC(14,2) DEFAULT 0,quantity NUMERIC(14,3) DEFAULT 0,min_quantity NUMERIC(14,3) DEFAULT 0,
      location TEXT,active BOOLEAN DEFAULT true,created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now()
    )`);
    await query(`CREATE TABLE warehouse_movements(
      id SERIAL PRIMARY KEY,item_id INT NOT NULL REFERENCES warehouse_items(id),branch_id INT REFERENCES branches(id),movement_type TEXT NOT NULL,quantity NUMERIC(14,3) NOT NULL,
      engineer_id INT REFERENCES users(id),request_id INT REFERENCES requests(id),unit_cost NUMERIC(14,2) DEFAULT 0,comment TEXT,created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await query(`CREATE TABLE stock_reservations(
      id SERIAL PRIMARY KEY,item_id INT REFERENCES warehouse_items(id),request_id INT REFERENCES requests(id),quantity NUMERIC(14,3) NOT NULL,status TEXT DEFAULT 'ACTIVE',created_by INT REFERENCES users(id),branch_id INT REFERENCES branches(id),created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await query(`CREATE TABLE suppliers(id SERIAL PRIMARY KEY,name TEXT NOT NULL,active BOOLEAN DEFAULT true)`);
    await query(`CREATE TABLE purchase_orders(id SERIAL PRIMARY KEY,number TEXT UNIQUE NOT NULL,supplier_id INT REFERENCES suppliers(id),branch_id INT NOT NULL REFERENCES branches(id),status TEXT DEFAULT 'DRAFT',created_at TIMESTAMPTZ DEFAULT now())`);
    await query(`CREATE TABLE purchase_order_items(id SERIAL PRIMARY KEY,purchase_order_id INT REFERENCES purchase_orders(id),item_id INT REFERENCES warehouse_items(id),name TEXT NOT NULL,qty NUMERIC(14,3) NOT NULL,unit_cost NUMERIC(14,2) DEFAULT 0,received_qty NUMERIC(14,3) DEFAULT 0)`);
    await query(`CREATE TABLE part_demands(id BIGSERIAL PRIMARY KEY,request_id INT NOT NULL REFERENCES requests(id),item_id INT NOT NULL REFERENCES warehouse_items(id),qty NUMERIC(14,3) NOT NULL,status TEXT NOT NULL DEFAULT 'NEED_PURCHASE',branch_id INT NOT NULL REFERENCES branches(id))`);

    const source=(await query("INSERT INTO warehouse_items(branch_id,sku,name,oem_code,purchase_price,quantity,min_quantity,created_at) VALUES($1,'CMP-X','Компрессор X','OEM-X',1000,10,2,'2025-01-01') RETURNING id",[kst])).rows[0].id;
    const destination=(await query("INSERT INTO warehouse_items(branch_id,sku,name,oem_code,purchase_price,quantity,min_quantity,created_at) VALUES($1,'CMP-X','Компрессор X','OEM-X',1000,0,3,'2025-01-01') RETURNING id",[tld])).rows[0].id;
    const fast=(await query("INSERT INTO warehouse_items(branch_id,sku,name,oem_code,purchase_price,quantity,min_quantity,created_at) VALUES($1,'PUMP-X','Насос ходовой','OEM-PUMP',500,4,2,'2025-01-01') RETURNING id",[kst])).rows[0].id;
    const dead=(await query("INSERT INTO warehouse_items(branch_id,sku,name,oem_code,purchase_price,quantity,min_quantity,created_at) VALUES($1,'OLD-X','Редкий модуль','OEM-OLD',2000,5,0,'2024-01-01') RETURNING id",[kst])).rows[0].id;

    for(const month of ['2026-03','2026-04','2026-05','2026-06','2026-07','2026-08'])await query("INSERT INTO warehouse_movements(item_id,branch_id,movement_type,quantity,unit_cost,created_at) VALUES($1,$2,'INSTALL',2,500,$3)",[fast,kst,`${month}-15T10:00:00Z`]);
    await query("INSERT INTO warehouse_movements(item_id,branch_id,movement_type,quantity,unit_cost,created_at) VALUES($1,$2,'RECEIPT',10,1000,'2026-01-10T10:00:00Z')",[source,kst]);

    let result=await buildWarehouseStockAnalytics(pool,{now});
    assert.equal(result.rows.length,4);
    assert.equal(result.summary.positions,4);
    assert.equal(result.summary.transfer_opportunities,1);
    assert.equal(result.summary.no_consumption_365>=1,true);
    assert.equal(result.summary.dead_stock_value>=10000,true);
    assert.equal(result.summary.turnover_365>0,true);

    const fastRow=result.rows.find(x=>Number(x.id)===Number(fast));
    assert.equal(fastRow.abc,'A');
    assert.equal(fastRow.xyz,'X');
    assert.equal(Number(fastRow.usage_qty_365),12);
    assert.equal(Number(fastRow.usage_value_365),6000);
    assert.equal(fastRow.inventory_reconstruction_accuracy,'FULL');
    assert.equal(fastRow.turnover_365>0,true);

    const sourceRow=result.rows.find(x=>Number(x.id)===Number(source));
    assert.equal(sourceRow.recommendation_code,'TRANSFER');
    assert.equal(Number(sourceRow.transfer_opportunity.branch_id),Number(tld));
    assert.equal(Number(sourceRow.transfer_opportunity.quantity),3);
    assert.equal(Number(sourceRow.excess_quantity),8);

    const deadRow=result.rows.find(x=>Number(x.id)===Number(dead));
    assert.equal(deadRow.recommendation_code,'REVIEW_WRITE_OFF');
    assert.equal(deadRow.days_no_consumption>=365,true);
    assert.equal(Number(deadRow.stock_value),10000);

    const destRow=result.rows.find(x=>Number(x.id)===Number(destination));
    assert.equal(Number(destRow.replenishment_need_quantity),3);

    const app=Fastify({logger:false});await app.register(jwt,{secret:'w'.repeat(64)});
    const auth=async(req,reply)=>{try{await req.jwtVerify()}catch{return reply.code(401).send({data:null,error:{code:'UNAUTHORIZED',message:'auth'}})}};
    const warehouseView=async(req,reply)=>{await auth(req,reply);if(reply.sent)return;if(!['OWNER','SUPERVISOR','ACCOUNTANT','MANAGER'].includes(req.user.role))return reply.code(403).send({data:null,error:{code:'FORBIDDEN',message:'no'}})};
    installWarehouseStockAnalytics(app,pool,{warehouseView,branchIds:resolveWarehouseBranchIds});await app.ready();
    const token=(id,role)=>app.jwt.sign({id,role});
    const call=async(role,id,url='/api/v1/warehouse-stock')=>{const r=await app.inject({method:'GET',url,headers:{authorization:'Bearer '+token(id,role)}});let body={};try{body=r.json()}catch{}return{status:r.statusCode,...body}};

    let r=await call('OWNER',owner);assert.equal(r.status,200);assert.equal(r.data.rows.length,4);assert.equal(r.data.summary.transfer_opportunities,1);
    r=await call('MANAGER',manager);assert.equal(r.status,200);assert.equal(r.data.rows.every(x=>Number(x.branch_id)===Number(kst)),true);assert.equal(r.data.rows.length,3);assert.equal(r.data.summary.transfer_opportunities,0);
    r=await call('MANAGER',manager,`/api/v1/warehouse-stock?branch_id=${tld}`);assert.equal(r.status,403);
    r=await call('ENGINEER',engineer);assert.equal(r.status,403);
    await app.close();
  }finally{await db.close()}
});
