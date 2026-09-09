import {transaction,requireOrder,accessError,authenticate,installOrderAccess} from './access.js';
import {lockStock,requireStock} from './stock-service.js';
import {can,PERMISSIONS} from './rbac.js';
import {runSchemaStatements} from './schema-retry.js';
import {prepareProcurementReplenishment,installProcurementReplenishment} from './procurement-replenishment.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import pg from 'pg';

const app=Fastify({logger:true});
await app.register(cors,{origin:(process.env.CORS_ORIGIN||'http://localhost:5173').split(',').map(x=>x.trim()),credentials:true});
await app.register(helmet,{contentSecurityPolicy:false});
await app.register(rateLimit,{max:300,timeWindow:'1 minute'});
await app.register(jwt,{secret:process.env.JWT_SECRET||'dev-secret-change-me'});

const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const q=(s,p=[])=>pool.query(s,p);
const n=v=>Number(v||0);
const fail=(r,c,m,s=422)=>r.code(s).send({data:null,error:{code:c,message:m}});

await runSchemaStatements(pool,[
 `CREATE TABLE IF NOT EXISTS suppliers(id SERIAL PRIMARY KEY,name TEXT NOT NULL,bin TEXT,phone TEXT,email TEXT,address TEXT,contact_person TEXT,notes TEXT,active BOOLEAN DEFAULT true,created_at TIMESTAMPTZ DEFAULT now())`,
 `CREATE TABLE IF NOT EXISTS purchase_orders(id SERIAL PRIMARY KEY,number TEXT UNIQUE NOT NULL,supplier_id INT REFERENCES suppliers(id),status TEXT DEFAULT 'DRAFT',expected_at DATE,comment TEXT,created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now())`,
 `CREATE TABLE IF NOT EXISTS purchase_order_items(id SERIAL PRIMARY KEY,purchase_order_id INT REFERENCES purchase_orders(id) ON DELETE CASCADE,item_id INT REFERENCES warehouse_items(id),name TEXT NOT NULL,qty NUMERIC(14,3) NOT NULL,unit_cost NUMERIC(14,2) DEFAULT 0,received_qty NUMERIC(14,3) DEFAULT 0)`,
 `CREATE TABLE IF NOT EXISTS stock_reservations(id SERIAL PRIMARY KEY,item_id INT REFERENCES warehouse_items(id),request_id INT REFERENCES requests(id),quantity NUMERIC(14,3) NOT NULL,status TEXT DEFAULT 'ACTIVE',created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now(),released_at TIMESTAMPTZ)`
],{logger:app.log});

await runSchemaStatements(pool,[
 `ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS branch_id INT REFERENCES branches(id)`,
 `UPDATE purchase_orders po SET branch_id=COALESCE((SELECT w.branch_id FROM purchase_order_items i JOIN warehouse_items w ON w.id=i.item_id WHERE i.purchase_order_id=po.id ORDER BY i.id LIMIT 1),(SELECT id FROM branches WHERE code='KST')) WHERE branch_id IS NULL`,
 `ALTER TABLE purchase_orders ALTER COLUMN branch_id SET NOT NULL`,
 `CREATE INDEX IF NOT EXISTS idx_purchase_orders_branch ON purchase_orders(branch_id,status,created_at DESC)`,
 `ALTER TABLE stock_reservations ADD COLUMN IF NOT EXISTS branch_id INT REFERENCES branches(id)`,
 `UPDATE stock_reservations sr SET branch_id=w.branch_id FROM warehouse_items w WHERE w.id=sr.item_id AND sr.branch_id IS NULL`,
 `ALTER TABLE stock_reservations ALTER COLUMN branch_id SET NOT NULL`,
 `CREATE OR REPLACE FUNCTION procurement_order_branch_guard() RETURNS trigger AS $$ BEGIN IF NEW.branch_id IS NULL THEN SELECT id INTO NEW.branch_id FROM branches WHERE code='KST' AND active=true LIMIT 1; END IF; IF NOT EXISTS(SELECT 1 FROM branches WHERE id=NEW.branch_id AND active=true) THEN RAISE EXCEPTION 'Филиал закупки не найден или отключён' USING ERRCODE='P2403'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`,
 `DROP TRIGGER IF EXISTS trg_procurement_order_branch_guard ON purchase_orders`,
 `CREATE TRIGGER trg_procurement_order_branch_guard BEFORE INSERT OR UPDATE OF branch_id ON purchase_orders FOR EACH ROW EXECUTE FUNCTION procurement_order_branch_guard()`,
 `CREATE OR REPLACE FUNCTION procurement_item_branch_guard() RETURNS trigger AS $$ DECLARE ob INT; ib INT; BEGIN SELECT branch_id INTO ob FROM purchase_orders WHERE id=NEW.purchase_order_id; SELECT branch_id INTO ib FROM warehouse_items WHERE id=NEW.item_id; IF ob IS NULL OR ib IS NULL OR ob IS DISTINCT FROM ib THEN RAISE EXCEPTION 'Позиция закупки должна относиться к складу филиала заказа поставщику' USING ERRCODE='P2403'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`,
 `DROP TRIGGER IF EXISTS trg_procurement_item_branch_guard ON purchase_order_items`,
 `CREATE TRIGGER trg_procurement_item_branch_guard BEFORE INSERT OR UPDATE OF purchase_order_id,item_id ON purchase_order_items FOR EACH ROW EXECUTE FUNCTION procurement_item_branch_guard()`
],{logger:app.log});

await prepareProcurementReplenishment(pool,{logger:app.log});

const auth=async(req,reply)=>{if(!await authenticate(req,reply,pool))return;};
const permit=permission=>async(req,reply)=>{await auth(req,reply);if(reply.sent)return;if(!can(req.user.role,permission))return fail(reply,'FORBIDDEN','Недостаточно прав',403)};
const view=permit(PERMISSIONS.PROCUREMENT_VIEW);
const manage=permit(PERMISSIONS.PROCUREMENT_MANAGE);
const globalRoles=new Set(['OWNER','SUPERVISOR','ACCOUNTANT']);

async function branchIds(user){
 if(globalRoles.has(user.role))return null;
 return(await q('SELECT branch_id FROM user_branches WHERE user_id=$1',[user.id])).rows.map(x=>Number(x.branch_id));
}
async function assertBranch(user,branchId){
 if(globalRoles.has(user.role))return Number(branchId);
 const ok=(await q('SELECT 1 FROM user_branches WHERE user_id=$1 AND branch_id=$2',[user.id,branchId])).rows[0];
 if(!ok)throw accessError('FORBIDDEN','Нет доступа к закупкам этого филиала',403);
 return Number(branchId);
}
async function defaultBranch(user){
 const row=(await q('SELECT primary_branch_id FROM users WHERE id=$1',[user.id])).rows[0];
 return Number(row?.primary_branch_id||(await q("SELECT id FROM branches WHERE code='KST' LIMIT 1")).rows[0]?.id||0);
}

installOrderAccess(app,pool,'procurement');
installProcurementReplenishment(app,pool,{view,manage,branchIds});

app.get('/health',async()=>{await q('SELECT 1');return{ok:true,service:'profi24-procurement',version:'1.4-replenishment'}});

app.get('/api/v1/suppliers',{preHandler:view},async()=>({data:(await q('SELECT * FROM suppliers WHERE active=true ORDER BY name')).rows}));
app.post('/api/v1/suppliers',{preHandler:manage},async(req,reply)=>{
 const b=req.body||{};
 if(!b.name?.trim())return fail(reply,'VALIDATION','Укажите поставщика');
 const r=await q('INSERT INTO suppliers(name,bin,phone,email,address,contact_person,notes) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[b.name.trim(),b.bin||null,b.phone||null,b.email||null,b.address||null,b.contact_person||null,b.notes||null]);
 return reply.code(201).send({data:r.rows[0]});
});

app.get('/api/v1/alerts',{preHandler:view},async req=>{
 const ids=await branchIds(req.user),p=[];let scope='WHERE w.active=true';
 if(ids){p.push(ids);scope+=' AND w.branch_id=ANY($1::int[])'}
 return{data:(await q(`SELECT w.*,b.name branch_name,b.code branch_code,
   COALESCE((SELECT sum(quantity) FROM stock_reservations sr JOIN requests r ON r.id=sr.request_id WHERE sr.item_id=w.id AND sr.status='ACTIVE' AND r.deleted_at IS NULL),0)::numeric reserved,
   (w.quantity-COALESCE((SELECT sum(quantity) FROM stock_reservations sr JOIN requests r ON r.id=sr.request_id WHERE sr.item_id=w.id AND sr.status='ACTIVE' AND r.deleted_at IS NULL),0))::numeric available
   FROM warehouse_items w JOIN branches b ON b.id=w.branch_id ${scope}
   AND (w.quantity-COALESCE((SELECT sum(quantity) FROM stock_reservations sr JOIN requests r ON r.id=sr.request_id WHERE sr.item_id=w.id AND sr.status='ACTIVE' AND r.deleted_at IS NULL),0))<=w.min_quantity
   ORDER BY available ASC,b.name,w.name`,p)).rows};
});

app.get('/api/v1/reservations',{preHandler:view},async req=>{
 const ids=await branchIds(req.user),p=[];let scope="WHERE sr.status='ACTIVE' AND r.deleted_at IS NULL";
 if(ids){p.push(ids);scope+=' AND sr.branch_id=ANY($1::int[])'}
 return{data:(await q(`SELECT sr.*,w.name item_name,w.sku,r.number request_number,c.name customer_name,b.name branch_name,b.code branch_code
   FROM stock_reservations sr JOIN warehouse_items w ON w.id=sr.item_id JOIN requests r ON r.id=sr.request_id JOIN customers c ON c.id=r.customer_id JOIN branches b ON b.id=sr.branch_id
   ${scope} ORDER BY sr.created_at DESC`,p)).rows};
});

app.post('/api/v1/reservations',{preHandler:manage},async(req,reply)=>{
 const item=n(req.body?.item_id),request=n(req.body?.request_id),qty=Number(req.body?.quantity);
 if(!item||!request||!Number.isFinite(qty)||qty<=0)return fail(reply,'VALIDATION','Укажите запчасть, заказ и количество');
 const row=await transaction(pool,async c=>{
   const order=await requireOrder(c,req.user,request,{mutable:true,lock:true});
   const stock=await lockStock(c,item);
   if(Number(stock.branch_id)!==Number(order.branch_id))throw accessError('BRANCH_MISMATCH','Резерв возможен только со склада филиала заказа',409);
   await assertBranch(req.user,order.branch_id);await requireStock(c,stock,qty);
   return(await c.query('INSERT INTO stock_reservations(item_id,request_id,quantity,created_by,branch_id) VALUES($1,$2,$3,$4,$5) RETURNING *',[item,request,qty,req.user.id,order.branch_id])).rows[0];
 });
 return reply.code(201).send({data:row});
});

app.post('/api/v1/reservations/:id/release',{preHandler:manage},async(req,reply)=>{
 const cur=(await q("SELECT branch_id FROM stock_reservations WHERE id=$1 AND status='ACTIVE'",[req.params.id])).rows[0];
 if(!cur)return fail(reply,'NOT_FOUND','Резерв не найден',404);
 await assertBranch(req.user,cur.branch_id);
 const r=await q("UPDATE stock_reservations SET status='RELEASED',released_at=now() WHERE id=$1 AND status='ACTIVE' RETURNING *",[req.params.id]);
 return{data:r.rows[0]};
});

app.get('/api/v1/orders',{preHandler:view},async req=>{
 const ids=await branchIds(req.user),p=[];let where='';
 if(ids){p.push(ids);where='WHERE po.branch_id=ANY($1::int[])'}
 return{data:(await q(`SELECT po.*,s.name supplier_name,b.name branch_name,b.code branch_code,
   COALESCE(sum(i.qty*i.unit_cost),0)::numeric total,count(i.id)::int positions,
   COALESCE(sum(GREATEST(i.qty-i.received_qty,0)),0)::numeric remaining_qty,
   CASE WHEN po.expected_at<CURRENT_DATE AND po.status NOT IN('RECEIVED','CANCELLED') THEN true ELSE false END overdue,
   GREATEST(0,(CURRENT_DATE-COALESCE(po.expected_at,CURRENT_DATE)))::int overdue_days
   FROM purchase_orders po JOIN branches b ON b.id=po.branch_id LEFT JOIN suppliers s ON s.id=po.supplier_id LEFT JOIN purchase_order_items i ON i.purchase_order_id=po.id
   ${where} GROUP BY po.id,s.name,b.name,b.code ORDER BY overdue DESC,po.created_at DESC`,p)).rows};
});

app.post('/api/v1/orders',{preHandler:manage},async(req,reply)=>{
 const b=req.body||{};
 if(!b.supplier_id)return fail(reply,'VALIDATION','Выберите поставщика');
 const branchId=b.branch_id?n(b.branch_id):await defaultBranch(req.user);await assertBranch(req.user,branchId);
 const number=`PO-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;
 const r=await q('INSERT INTO purchase_orders(number,supplier_id,branch_id,expected_at,comment,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[number,b.supplier_id,branchId,b.expected_at||null,b.comment||null,req.user.id]);
 return reply.code(201).send({data:r.rows[0]});
});

app.post('/api/v1/orders/:id/items',{preHandler:manage},async(req,reply)=>{
 const b=req.body||{};
 if(!b.item_id||n(b.qty)<=0)return fail(reply,'VALIDATION','Выберите позицию и количество');
 const po=(await q('SELECT branch_id FROM purchase_orders WHERE id=$1',[req.params.id])).rows[0];
 if(!po)return fail(reply,'NOT_FOUND','Заказ поставщику не найден',404);
 await assertBranch(req.user,po.branch_id);
 const wi=(await q('SELECT name,purchase_price,branch_id FROM warehouse_items WHERE id=$1',[b.item_id])).rows[0];
 if(!wi)return fail(reply,'NOT_FOUND','Запчасть не найдена',404);
 if(Number(wi.branch_id)!==Number(po.branch_id))return fail(reply,'BRANCH_MISMATCH','Запчасть относится к другому филиалу',409);
 const r=await q('INSERT INTO purchase_order_items(purchase_order_id,item_id,name,qty,unit_cost) VALUES($1,$2,$3,$4,$5) RETURNING *',[req.params.id,b.item_id,wi.name,n(b.qty),b.unit_cost==null?wi.purchase_price:n(b.unit_cost)]);
 await q("UPDATE purchase_orders SET status='ORDERED',updated_at=now() WHERE id=$1",[req.params.id]);
 return reply.code(201).send({data:r.rows[0]});
});

app.get('/api/v1/orders/:id',{preHandler:view},async(req,reply)=>{
 const o=(await q('SELECT po.*,s.name supplier_name,b.name branch_name,b.code branch_code FROM purchase_orders po JOIN branches b ON b.id=po.branch_id LEFT JOIN suppliers s ON s.id=po.supplier_id WHERE po.id=$1',[req.params.id])).rows[0];
 if(!o)return fail(reply,'NOT_FOUND','Заказ поставщику не найден',404);
 await assertBranch(req.user,o.branch_id);
 o.items=(await q('SELECT i.*,w.sku,w.oem_code FROM purchase_order_items i LEFT JOIN warehouse_items w ON w.id=i.item_id WHERE purchase_order_id=$1 ORDER BY id',[req.params.id])).rows;
 return{data:o};
});

app.post('/api/v1/orders/:id/receive',{preHandler:manage},async(req,reply)=>{
 const c=await pool.connect();
 try{
   await c.query('BEGIN');
   const po=(await c.query('SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
   if(!po)throw accessError('NOT_FOUND','Заказ поставщику не найден',404);
   await assertBranch(req.user,po.branch_id);
   if(po.status==='CANCELLED')throw accessError('ORDER_FINISHED','Заказ поставщику отменён');
   const items=(await c.query('SELECT * FROM purchase_order_items WHERE purchase_order_id=$1 ORDER BY item_id,id FOR UPDATE',[req.params.id])).rows;
   if(!items.length)throw accessError('EMPTY','В заказе нет позиций',422);
   for(const i of items){
     const rem=n(i.qty)-n(i.received_qty);if(rem<=0)continue;
     const w=(await c.query('SELECT * FROM warehouse_items WHERE id=$1 FOR UPDATE',[i.item_id])).rows[0];
     if(Number(w.branch_id)!==Number(po.branch_id))throw accessError('BRANCH_MISMATCH','Позиция закупки относится к другому филиалу',409);
     const newQty=n(w.quantity)+rem;
     const avg=newQty?((n(w.quantity)*n(w.purchase_price))+(rem*n(i.unit_cost)))/newQty:n(i.unit_cost);
     await c.query('UPDATE warehouse_items SET quantity=$1,purchase_price=$2,updated_at=now() WHERE id=$3',[newQty,avg,w.id]);
     await c.query("INSERT INTO warehouse_movements(item_id,movement_type,quantity,unit_cost,supplier,comment,created_by) VALUES($1,'RECEIPT',$2,$3,(SELECT s.name FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id WHERE po.id=$4),$5,$6)",[w.id,rem,i.unit_cost,req.params.id,`Приход по заказу ${req.params.id}`,req.user.id]);
     await c.query('UPDATE purchase_order_items SET received_qty=qty WHERE id=$1',[i.id]);
   }
   await c.query("UPDATE purchase_orders SET status='RECEIVED',updated_at=now() WHERE id=$1",[req.params.id]);
   await c.query('COMMIT');return{data:{ok:true}};
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
});

app.listen({port:Number(process.env.PORT||8082),host:'0.0.0.0'});
