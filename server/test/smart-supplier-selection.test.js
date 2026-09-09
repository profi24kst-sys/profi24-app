import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {chooseSupplierOffer} from '../src/smart-supplier-selection.js';
import {prepareProcurementReplenishment,buildReplenishmentPlan,installProcurementReplenishment} from '../src/procurement-replenishment.js';

const offer=(supplier_id,supplier_name,unit_cost,lead_time_days,currency='KZT')=>({item_id:1,supplier_id,supplier_name,unit_cost,lead_time_days,supplier_available_qty:50,currency,source:'CATALOG',auto_eligible:currency==='KZT',auto_exclusion_reason:currency==='KZT'?null:'FOREIGN_CURRENCY'});
const profile=(supplier_id,score,confidence='HIGH',recommendation_code='MONITOR')=>({supplier_id,score,rating:score>=85?'A':score>=70?'B':score>=55?'C':'D',confidence,recommendation_code,on_time_rate:score,overdue_open_orders:recommendation_code==='DELIVERY_RISK'?2:0});

test('умный выбор меняет веса для критичного ремонта и обычного пополнения',()=>{
  const cheap=offer(1,'Дешёвый поставщик',10000,10),fast=offer(2,'Быстрый поставщик',12000,2);
  const criticalProfiles=new Map([[1,profile(1,55,'MEDIUM','DELIVERY_RISK')],[2,profile(2,90,'HIGH','PREFERRED')]]);
  let decision=chooseSupplierOffer({row:{priority:'CRITICAL',recommended_quantity:2},offers:[cheap,fast],profiles:criticalProfiles});
  assert.equal(decision.selected.supplier_id,2);
  assert.equal(decision.selected.selection_strategy,'SERVICE_CRITICAL');
  assert.equal(decision.selected.cheapest_supplier_id,1);
  assert.equal(Number(decision.selected.price_premium_pct),20);
  assert.match(decision.selected.selection_reason,/критичный ремонт/i);
  assert.ok(decision.selected.selection_score>decision.alternatives.find(x=>x.supplier_id===1).selection_score);

  const routineProfiles=new Map([[1,profile(1,70,'MEDIUM','MONITOR')],[2,profile(2,90,'HIGH','PREFERRED')]]);
  decision=chooseSupplierOffer({row:{priority:'HIGH',recommended_quantity:2},offers:[cheap,fast],profiles:routineProfiles});
  assert.equal(decision.selected.supplier_id,1,'при обычном пополнении цена должна оставаться главным фактором');
  assert.equal(decision.selected.selection_strategy,'STOCK_REPLENISHMENT');
  assert.equal(Number(decision.selected.price_premium_pct),0);
});

test('иностранная валюта не участвует в автоматическом сравнении с KZT',()=>{
  const usd=offer(3,'USD Supplier',500,1,'USD'),kzt=offer(4,'KZT Supplier',250000,5,'KZT');
  let decision=chooseSupplierOffer({row:{priority:'CRITICAL',recommended_quantity:1},offers:[usd,kzt],profiles:new Map()});
  assert.equal(decision.selected.supplier_id,4);
  assert.equal(decision.selected.currency,'KZT');
  decision=chooseSupplierOffer({row:{priority:'HIGH',recommended_quantity:1},offers:[usd],profiles:new Map()});
  assert.equal(decision.selected,null);
  assert.equal(decision.alternatives[0].auto_exclusion_reason,'FOREIGN_CURRENCY');
});

test('критичная сервисная потребность использует реальную историю PO и сохраняет решение в аудите',async()=>{
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  let chain=Promise.resolve();
  const pool={query,connect:async()=>{const before=chain;let release;chain=new Promise(r=>release=r);await before;return{query,release}},end:async()=>{}};
  let app;
  try{
    await migrateCore(pool);
    const branch=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id;
    const owner=(await query("INSERT INTO users(name,email,password_hash,role,primary_branch_id) VALUES('Smart Owner','smart-owner@test.invalid','x','OWNER',$1) RETURNING id",[branch])).rows[0].id;
    const manager=(await query("INSERT INTO users(name,email,password_hash,role,primary_branch_id) VALUES('Smart Manager','smart-manager@test.invalid','x','MANAGER',$1) RETURNING id",[branch])).rows[0].id;
    const customer=(await query("INSERT INTO customers(name,phone) VALUES('Smart Client','77000000991') RETURNING id")).rows[0].id;
    const request=(await query("INSERT INTO requests(number,customer_id,branch_id,status,complaint) VALUES('SMART-REQ-1',$1,$2,'WAITING_PART','critical part') RETURNING id",[customer,branch])).rows[0].id;
    await query(`CREATE TABLE warehouse_items(id SERIAL PRIMARY KEY,branch_id INT NOT NULL REFERENCES branches(id),sku TEXT,name TEXT NOT NULL,oem_code TEXT,supplier TEXT,purchase_price NUMERIC(14,2) DEFAULT 0,sale_price NUMERIC(14,2) DEFAULT 0,quantity NUMERIC(14,3) DEFAULT 0,min_quantity NUMERIC(14,3) DEFAULT 0,location TEXT,active BOOLEAN DEFAULT true,updated_at TIMESTAMPTZ DEFAULT now())`);
    await query(`CREATE TABLE warehouse_movements(id SERIAL PRIMARY KEY,item_id INT NOT NULL REFERENCES warehouse_items(id),movement_type TEXT NOT NULL,quantity NUMERIC(14,3) NOT NULL,unit_cost NUMERIC(14,2) DEFAULT 0,created_at TIMESTAMPTZ DEFAULT now())`);
    await query(`CREATE TABLE stock_reservations(id SERIAL PRIMARY KEY,item_id INT REFERENCES warehouse_items(id),request_id INT REFERENCES requests(id),quantity NUMERIC(14,3) NOT NULL,status TEXT DEFAULT 'ACTIVE',created_by INT REFERENCES users(id),branch_id INT REFERENCES branches(id),created_at TIMESTAMPTZ DEFAULT now())`);
    await query(`CREATE TABLE suppliers(id SERIAL PRIMARY KEY,name TEXT NOT NULL,active BOOLEAN DEFAULT true)`);
    await query(`CREATE TABLE purchase_orders(id SERIAL PRIMARY KEY,number TEXT UNIQUE NOT NULL,supplier_id INT REFERENCES suppliers(id),branch_id INT NOT NULL REFERENCES branches(id),status TEXT DEFAULT 'DRAFT',expected_at DATE,comment TEXT,created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now())`);
    await query(`CREATE TABLE purchase_order_items(id SERIAL PRIMARY KEY,purchase_order_id INT REFERENCES purchase_orders(id) ON DELETE CASCADE,item_id INT REFERENCES warehouse_items(id),name TEXT NOT NULL,qty NUMERIC(14,3) NOT NULL,unit_cost NUMERIC(14,2) DEFAULT 0,received_qty NUMERIC(14,3) DEFAULT 0)`);
    await query(`CREATE TABLE part_demands(id BIGSERIAL PRIMARY KEY,request_id INT NOT NULL REFERENCES requests(id),item_id INT NOT NULL REFERENCES warehouse_items(id),qty NUMERIC(14,3) NOT NULL,status TEXT NOT NULL DEFAULT 'NEED_PURCHASE',branch_id INT NOT NULL REFERENCES branches(id))`);
    await query(`CREATE TABLE supplier_catalog_items(id BIGSERIAL PRIMARY KEY,supplier_id INT NOT NULL REFERENCES suppliers(id),purchase_price NUMERIC(14,2) NOT NULL DEFAULT 0,available_qty NUMERIC(14,3),lead_time_days INT,currency TEXT DEFAULT 'KZT',active BOOLEAN DEFAULT true,updated_at TIMESTAMPTZ DEFAULT now())`);
    await query(`CREATE TABLE supplier_catalog_links(catalog_item_id BIGINT NOT NULL REFERENCES supplier_catalog_items(id),branch_id INT NOT NULL REFERENCES branches(id),warehouse_item_id INT NOT NULL REFERENCES warehouse_items(id))`);

    const cheap=(await query("INSERT INTO suppliers(name) VALUES('Cheap Late') RETURNING id")).rows[0].id;
    const fast=(await query("INSERT INTO suppliers(name) VALUES('Fast Reliable') RETURNING id")).rows[0].id;
    const item=(await query("INSERT INTO warehouse_items(branch_id,sku,name,oem_code,purchase_price,sale_price,quantity,min_quantity) VALUES($1,'SMART-1','Критичный компрессор','OEM-SMART',10000,16000,0,0) RETURNING id",[branch])).rows[0].id;
    await query("INSERT INTO part_demands(request_id,item_id,qty,status,branch_id) VALUES($1,$2,1,'NEED_PURCHASE',$3)",[request,item,branch]);
    for(let i=0;i<5;i++){
      const day=String(i+1).padStart(2,'0');
      const cheapPo=(await query(`INSERT INTO purchase_orders(number,supplier_id,branch_id,status,expected_at,created_by,created_at,updated_at) VALUES($1,$2,$3,'RECEIVED','2026-08-08',$4,$5::timestamptz,'2026-08-15T10:00:00Z') RETURNING id`,[`SMART-C-${i}`,cheap,branch,owner,`2026-08-${day}T08:00:00Z`])).rows[0].id;
      await query("INSERT INTO purchase_order_items(purchase_order_id,item_id,name,qty,unit_cost,received_qty) VALUES($1,$2,'Критичный компрессор',1,10000,1)",[cheapPo,item]);
      const fastPo=(await query(`INSERT INTO purchase_orders(number,supplier_id,branch_id,status,expected_at,created_by,created_at,updated_at) VALUES($1,$2,$3,'RECEIVED','2026-08-08',$4,$5::timestamptz,'2026-08-06T10:00:00Z') RETURNING id`,[`SMART-F-${i}`,fast,branch,owner,`2026-08-${day}T08:00:00Z`])).rows[0].id;
      await query("INSERT INTO purchase_order_items(purchase_order_id,item_id,name,qty,unit_cost,received_qty) VALUES($1,$2,'Критичный компрессор',1,10500,1)",[fastPo,item]);
    }
    const cheapCat=(await query("INSERT INTO supplier_catalog_items(supplier_id,purchase_price,available_qty,lead_time_days,currency) VALUES($1,10000,20,10,'KZT') RETURNING id",[cheap])).rows[0].id;
    const fastCat=(await query("INSERT INTO supplier_catalog_items(supplier_id,purchase_price,available_qty,lead_time_days,currency) VALUES($1,10500,20,2,'KZT') RETURNING id",[fast])).rows[0].id;
    await query('INSERT INTO supplier_catalog_links(catalog_item_id,branch_id,warehouse_item_id) VALUES($1,$2,$3),($4,$2,$3)',[cheapCat,branch,item,fastCat]);

    await prepareProcurementReplenishment(pool,{logger:{warn(){}}});
    let rows=await buildReplenishmentPlan(pool,{needOnly:true});
    assert.equal(rows.length,1);const row=rows[0];
    assert.equal(row.priority,'CRITICAL');
    assert.equal(Number(row.best_supplier_id),Number(fast));
    assert.equal(row.selection_strategy,'SERVICE_CRITICAL');
    assert.equal(Number(row.cheapest_supplier_id),Number(cheap));
    assert.equal(Number(row.price_premium_pct),5);
    assert.equal(row.supplier_confidence,'HIGH');
    assert.match(row.selection_reason,/критичный ремонт/i);
    assert.ok(Number(row.selection_score)>70);

    app=Fastify({logger:false});await app.register(jwt,{secret:'z'.repeat(64)});
    const auth=async(req,reply)=>{try{await req.jwtVerify()}catch{return reply.code(401).send({data:null,error:{code:'UNAUTHORIZED'}})}};
    const manage=async(req,reply)=>{await auth(req,reply);if(reply.sent)return;if(!['OWNER','SUPERVISOR','MANAGER'].includes(req.user.role))return reply.code(403).send({data:null,error:{code:'FORBIDDEN'}})};
    const branchIds=async()=>[Number(branch)];installProcurementReplenishment(app,pool,{view:auth,manage,branchIds});await app.ready();
    const token=app.jwt.sign({id:manager,role:'MANAGER'}),resp=await app.inject({method:'POST',url:'/api/v1/replenishment/orders',headers:{authorization:'Bearer '+token},payload:{idempotency_key:'smart-selection-audit',items:[{item_id:item}]}});assert.equal(resp.statusCode,201,resp.body);const batch=resp.json().data,line=batch.lines[0];
    assert.equal(Number(line.supplier_id),Number(fast));
    assert.equal(line.selection_strategy,'SERVICE_CRITICAL');
    assert.equal(line.manual_supplier_override,false);
    assert.equal(Number(line.cheapest_supplier_id),Number(cheap));
    assert.equal(Number(line.price_premium_pct),5);
    assert.match(line.selection_reason,/критичный ремонт/i);
    await assert.rejects(query('UPDATE procurement_replenishment_lines SET selection_reason=\'changed\' WHERE id=$1',[line.id]),e=>e.code==='P2401');
    rows=await buildReplenishmentPlan(pool,{needOnly:true});assert.equal(rows.length,0,'созданный PO должен закрыть потребность');
  }finally{if(app)await app.close().catch(()=>{});await db.close()}
});
