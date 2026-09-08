import {requireStock,consumeReservations} from './stock-service.js';
import {requireOrder} from './access.js';
import {recalculateOrder} from './order-totals.js';
import {authenticate,installOrderAccess} from './access.js';
import {can,PERMISSIONS} from './rbac.js';
import {warehouseBranchStatements} from './warehouse-branch-schema.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import pg from 'pg';

const app=Fastify({logger:true,bodyLimit:4*1024*1024});
await app.register(cors,{origin:(process.env.CORS_ORIGIN||'http://localhost:5173').split(',').map(x=>x.trim()),credentials:true});
await app.register(helmet,{contentSecurityPolicy:false});
await app.register(rateLimit,{max:300,timeWindow:'1 minute'});
await app.register(jwt,{secret:process.env.JWT_SECRET||'dev-secret-change-me'});

const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:Number(process.env.DB_POOL_MAX||10)});
const q=(s,p=[])=>pool.query(s,p);
const tx=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}};
const n=v=>Number(v||0);
const fail=(reply,code,message,status=422,details)=>reply.code(status).send({data:null,error:{code,message,details}});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function startupDdl(sql){
 for(let attempt=0;;attempt++){
  try{return await q(sql)}catch(error){
   if(error?.code!=='40P01'||attempt>=5)throw error;
   const delay=100*(2**attempt)+Math.floor(Math.random()*75);
   app.log.warn({attempt:attempt+1,delay_ms:delay,code:error.code},'Transient startup DDL deadlock; retrying');
   await sleep(delay);
  }
 }
}

const schema=[
`CREATE TABLE IF NOT EXISTS warehouse_items(
 id SERIAL PRIMARY KEY,
 sku TEXT UNIQUE,
 name TEXT NOT NULL,
 oem_code TEXT,
 supplier TEXT,
 purchase_price NUMERIC(14,2) NOT NULL DEFAULT 0,
 sale_price NUMERIC(14,2) NOT NULL DEFAULT 0,
 quantity NUMERIC(14,3) NOT NULL DEFAULT 0,
 min_quantity NUMERIC(14,3) NOT NULL DEFAULT 0,
 location TEXT,
 notes TEXT,
 active BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ DEFAULT now(),
 updated_at TIMESTAMPTZ DEFAULT now()
)`,
`CREATE INDEX IF NOT EXISTS idx_warehouse_items_name ON warehouse_items(lower(name))`,
`CREATE INDEX IF NOT EXISTS idx_warehouse_items_oem ON warehouse_items(oem_code)`,
`CREATE TABLE IF NOT EXISTS warehouse_movements(
 id SERIAL PRIMARY KEY,
 item_id INT NOT NULL REFERENCES warehouse_items(id),
 movement_type TEXT NOT NULL CHECK(movement_type IN ('RECEIPT','ISSUE','RETURN','INSTALL','WRITE_OFF','ADJUSTMENT')),
 quantity NUMERIC(14,3) NOT NULL CHECK(quantity>0),
 engineer_id INT REFERENCES users(id),
 request_id INT REFERENCES requests(id),
 unit_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
 sale_price NUMERIC(14,2) NOT NULL DEFAULT 0,
 supplier TEXT,
 comment TEXT,
 created_by INT REFERENCES users(id),
 created_at TIMESTAMPTZ DEFAULT now()
)`,
`CREATE INDEX IF NOT EXISTS idx_warehouse_movements_item ON warehouse_movements(item_id,created_at DESC)`,
`CREATE INDEX IF NOT EXISTS idx_warehouse_movements_engineer ON warehouse_movements(engineer_id,created_at DESC)`,
`CREATE INDEX IF NOT EXISTS idx_warehouse_movements_request ON warehouse_movements(request_id,created_at DESC)`
];
for(const s of schema)await startupDdl(s);
await startupDdl(`CREATE TABLE IF NOT EXISTS stock_reservations(id SERIAL PRIMARY KEY,item_id INT REFERENCES warehouse_items(id),request_id INT REFERENCES requests(id),quantity NUMERIC(14,3) NOT NULL,status TEXT DEFAULT 'ACTIVE',created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now(),released_at TIMESTAMPTZ)`);
for(const s of warehouseBranchStatements)await startupDdl(s);

const auth=async(req,reply)=>{if(!await authenticate(req,reply,pool))return;};
const permit=permission=>async(req,reply)=>{await auth(req,reply);if(reply.sent)return;if(!can(req.user.role,permission))return fail(reply,'FORBIDDEN','Недостаточно прав для этой операции склада',403)};
const warehouseView=permit(PERMISSIONS.WAREHOUSE_VIEW);
const warehouseReceive=permit(PERMISSIONS.WAREHOUSE_RECEIVE);
const warehouseIssue=permit(PERMISSIONS.WAREHOUSE_ISSUE);
const warehouseWriteoff=permit(PERMISSIONS.WAREHOUSE_WRITEOFF);
const globalBranchRoles=new Set(['OWNER','SUPERVISOR','ACCOUNTANT']);

async function branchIds(c,user){
 if(globalBranchRoles.has(user.role))return null;
 return (await c.query('SELECT branch_id FROM user_branches WHERE user_id=$1',[user.id])).rows.map(x=>Number(x.branch_id));
}
async function assertBranchAccess(c,user,branchId){
 if(globalBranchRoles.has(user.role))return Number(branchId);
 const ok=(await c.query('SELECT 1 FROM user_branches WHERE user_id=$1 AND branch_id=$2',[user.id,branchId])).rows[0];
 if(!ok)throw Object.assign(new Error('Нет доступа к складу этого филиала'),{code:'FORBIDDEN',statusCode:403});
 return Number(branchId);
}
async function defaultBranch(c,user){
 const row=(await c.query('SELECT primary_branch_id FROM users WHERE id=$1',[user.id])).rows[0];
 if(row?.primary_branch_id)return Number(row.primary_branch_id);
 return Number((await c.query("SELECT id FROM branches WHERE code='KST' AND active=true LIMIT 1")).rows[0]?.id||0);
}
async function scopedItem(c,user,itemId,{lock=false}={}){
 const item=(await c.query(`SELECT i.*,b.code branch_code,b.name branch_name FROM warehouse_items i JOIN branches b ON b.id=i.branch_id WHERE i.id=$1${lock?' FOR UPDATE OF i':''}`,[itemId])).rows[0];
 if(!item)throw Object.assign(new Error('Позиция не найдена'),{code:'NOT_FOUND',statusCode:404});
 await assertBranchAccess(c,user,item.branch_id);
 return item;
}
async function engineerBalance(c,itemId,engineerId){
 const r=await c.query(`SELECT COALESCE(sum(CASE WHEN movement_type='ISSUE' THEN quantity WHEN movement_type IN ('RETURN','INSTALL') THEN -quantity ELSE 0 END),0)::numeric balance FROM warehouse_movements WHERE item_id=$1 AND engineer_id=$2`,[itemId,engineerId]);
 return n(r.rows[0].balance);
}
async function recalcRequest(c,id){return recalculateOrder(c,id)}

app.get('/health',async()=>({ok:true,service:'warehouse'}));
installOrderAccess(app,pool,'warehouse');
app.get('/api/v1/warehouse/items',{preHandler:warehouseView},async req=>tx(async c=>{const ids=await branchIds(c,req.user);const branchId=req.query?.branch_id?Number(req.query.branch_id):null;if(branchId)await assertBranchAccess(c,req.user,branchId);const rows=(await c.query(`SELECT i.*,b.code branch_code,b.name branch_name FROM warehouse_items i JOIN branches b ON b.id=i.branch_id WHERE i.active=true AND ($1::int IS NULL OR i.branch_id=$1) AND ($2::int[] IS NULL OR i.branch_id=ANY($2::int[])) ORDER BY b.code,i.name`,[branchId,ids])).rows;return{data:rows}}));
app.post('/api/v1/warehouse/items',{preHandler:warehouseReceive},async(req,reply)=>tx(async c=>{try{const b=req.body||{},branchId=Number(b.branch_id||await defaultBranch(c,req.user));await assertBranchAccess(c,req.user,branchId);if(!b.name)return fail(reply,'VALIDATION','Укажите название позиции');const r=(await c.query(`INSERT INTO warehouse_items(sku,name,oem_code,supplier,purchase_price,sale_price,quantity,min_quantity,location,notes,branch_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[b.sku||null,b.name,b.oem_code||null,b.supplier||null,n(b.purchase_price),n(b.sale_price),n(b.quantity),n(b.min_quantity),b.location||null,b.notes||null,branchId])).rows[0];return reply.code(201).send({data:r})}catch(e){if(e.code==='23505')return fail(reply,'DUPLICATE','SKU уже существует',409);throw e}}));
app.patch('/api/v1/warehouse/items/:id',{preHandler:warehouseReceive},async(req,reply)=>tx(async c=>{const old=await scopedItem(c,req.user,req.params.id,{lock:true}),b={...old,...req.body};if(req.body?.branch_id&&Number(req.body.branch_id)!==Number(old.branch_id)){await assertBranchAccess(c,req.user,req.body.branch_id);const movements=Number((await c.query('SELECT count(*) c FROM warehouse_movements WHERE item_id=$1',[old.id])).rows[0].c);if(movements>0)return fail(reply,'STATE_CONFLICT','Нельзя перенести позицию с историей движений между филиалами',409)}const r=(await c.query(`UPDATE warehouse_items SET sku=$1,name=$2,oem_code=$3,supplier=$4,purchase_price=$5,sale_price=$6,min_quantity=$7,location=$8,notes=$9,active=$10,branch_id=$11,updated_at=now() WHERE id=$12 RETURNING *`,[b.sku,b.name,b.oem_code,b.supplier,n(b.purchase_price),n(b.sale_price),n(b.min_quantity),b.location,b.notes,b.active!==false,Number(b.branch_id),old.id])).rows[0];return{data:r}}));
app.get('/api/v1/warehouse/items/:id/movements',{preHandler:warehouseView},async(req,reply)=>tx(async c=>{await scopedItem(c,req.user,req.params.id);const rows=(await c.query(`SELECT m.*,u.name engineer_name,r.number request_number,cu.name created_by_name FROM warehouse_movements m LEFT JOIN users u ON u.id=m.engineer_id LEFT JOIN requests r ON r.id=m.request_id LEFT JOIN users cu ON cu.id=m.created_by WHERE m.item_id=$1 ORDER BY m.created_at DESC,m.id DESC LIMIT 500`,[req.params.id])).rows;return{data:rows}}));
app.get('/api/v1/warehouse/engineers/:id',{preHandler:warehouseView},async(req,reply)=>tx(async c=>{const engineerId=Number(req.params.id);const ids=await branchIds(c,req.user);const rows=(await c.query(`SELECT i.id,i.sku,i.name,i.oem_code,i.branch_id,b.code branch_code,b.name branch_name,COALESCE(sum(CASE WHEN m.movement_type='ISSUE' THEN m.quantity WHEN m.movement_type IN ('RETURN','INSTALL') THEN -m.quantity ELSE 0 END),0)::numeric balance FROM warehouse_items i JOIN branches b ON b.id=i.branch_id LEFT JOIN warehouse_movements m ON m.item_id=i.id AND m.engineer_id=$1 WHERE ($2::int[] IS NULL OR i.branch_id=ANY($2::int[])) GROUP BY i.id,b.id HAVING COALESCE(sum(CASE WHEN m.movement_type='ISSUE' THEN m.quantity WHEN m.movement_type IN ('RETURN','INSTALL') THEN -m.quantity ELSE 0 END),0)>0 ORDER BY b.code,i.name`,[engineerId,ids])).rows;return{data:rows}}));
app.post('/api/v1/warehouse/movements',{preHandler:auth},async(req,reply)=>tx(async c=>{try{const b=req.body||{},type=String(b.movement_type||'').toUpperCase(),qty=n(b.quantity);if(!['RECEIPT','ISSUE','RETURN','INSTALL','WRITE_OFF','ADJUSTMENT'].includes(type)||qty<=0)return fail(reply,'VALIDATION','Некорректное движение склада');const permission=type==='WRITE_OFF'?PERMISSIONS.WAREHOUSE_WRITEOFF:type==='RECEIPT'?PERMISSIONS.WAREHOUSE_RECEIVE:PERMISSIONS.WAREHOUSE_ISSUE;if(!can(req.user.role,permission))return fail(reply,'FORBIDDEN','Недостаточно прав для движения склада',403);const item=await scopedItem(c,req.user,b.item_id,{lock:true});let request=null;if(b.request_id){request=await requireOrder(c,Number(b.request_id));if(Number(request.branch_id)!==Number(item.branch_id))return fail(reply,'BRANCH_MISMATCH','Заказ и складская позиция относятся к разным филиалам',409)}if(['ISSUE','INSTALL','WRITE_OFF'].includes(type))await requireStock(c,item.id,qty);if(type==='RETURN'&&b.engineer_id){const bal=await engineerBalance(c,item.id,b.engineer_id);if(bal<qty)return fail(reply,'INSUFFICIENT_ENGINEER_BALANCE','У инженера нет такого количества позиции',409)}let delta=0;if(type==='RECEIPT'||type==='RETURN')delta=qty;if(type==='ISSUE'||type==='WRITE_OFF')delta=-qty;if(type==='INSTALL')delta=-qty;const updated=(await c.query('UPDATE warehouse_items SET quantity=quantity+$1,updated_at=now() WHERE id=$2 RETURNING *',[delta,item.id])).rows[0];const movement=(await c.query(`INSERT INTO warehouse_movements(item_id,movement_type,quantity,engineer_id,request_id,unit_cost,sale_price,supplier,comment,created_by,branch_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[item.id,type,qty,b.engineer_id||null,b.request_id||null,n(b.unit_cost??item.purchase_price),n(b.sale_price??item.sale_price),b.supplier||item.supplier||null,b.comment||null,req.user.id,item.branch_id])).rows[0];if(type==='INSTALL'&&b.request_id){await consumeReservations(c,b.request_id,item.id,qty);await recalcRequest(c,b.request_id)}return reply.code(201).send({data:{movement,item:updated}})}catch(e){if(e.code==='INSUFFICIENT_STOCK')return fail(reply,e.code,e.message,409);if(e.code==='ORDER_NOT_FOUND')return fail(reply,e.code,e.message,404);throw e}}));
app.post('/api/v1/warehouse/reservations',{preHandler:warehouseIssue},async(req,reply)=>tx(async c=>{try{const b=req.body||{},qty=n(b.quantity);if(qty<=0)return fail(reply,'VALIDATION','Количество должно быть больше нуля');const item=await scopedItem(c,req.user,b.item_id,{lock:true}),request=await requireOrder(c,Number(b.request_id));if(Number(request.branch_id)!==Number(item.branch_id))return fail(reply,'BRANCH_MISMATCH','Заказ и складская позиция относятся к разным филиалам',409);await requireStock(c,item.id,qty);const existing=(await c.query("SELECT id FROM stock_reservations WHERE request_id=$1 AND item_id=$2 AND status='ACTIVE' FOR UPDATE",[request.id,item.id])).rows[0];let r;if(existing)r=(await c.query('UPDATE stock_reservations SET quantity=quantity+$1 WHERE id=$2 RETURNING *',[qty,existing.id])).rows[0];else r=(await c.query(`INSERT INTO stock_reservations(item_id,request_id,quantity,status,created_by,branch_id) VALUES($1,$2,$3,'ACTIVE',$4,$5) RETURNING *`,[item.id,request.id,qty,req.user.id,item.branch_id])).rows[0];return reply.code(201).send({data:r})}catch(e){if(e.code==='INSUFFICIENT_STOCK')return fail(reply,e.code,e.message,409);throw e}}));
app.post('/api/v1/warehouse/reservations/:id/release',{preHandler:warehouseIssue},async(req,reply)=>tx(async c=>{const r=(await c.query(`SELECT sr.*,i.branch_id FROM stock_reservations sr JOIN warehouse_items i ON i.id=sr.item_id WHERE sr.id=$1 FOR UPDATE OF sr`,[req.params.id])).rows[0];if(!r)return fail(reply,'NOT_FOUND','Резерв не найден',404);await assertBranchAccess(c,req.user,r.branch_id);const out=(await c.query("UPDATE stock_reservations SET status='RELEASED',released_at=now() WHERE id=$1 AND status='ACTIVE' RETURNING *",[r.id])).rows[0];if(!out)return fail(reply,'STATE_CONFLICT','Резерв уже освобождён',409);return{data:out}}));
app.get('/api/v1/warehouse/requests/:id/reservations',{preHandler:warehouseView},async(req,reply)=>tx(async c=>{const request=await requireOrder(c,Number(req.params.id)),ids=await branchIds(c,req.user);if(ids!==null&&!ids.includes(Number(request.branch_id)))return fail(reply,'FORBIDDEN','Нет доступа к складу этого филиала',403);const rows=(await c.query(`SELECT sr.*,i.sku,i.name,i.oem_code,i.branch_id,b.code branch_code FROM stock_reservations sr JOIN warehouse_items i ON i.id=sr.item_id JOIN branches b ON b.id=i.branch_id WHERE sr.request_id=$1 ORDER BY sr.created_at DESC`,[request.id])).rows;return{data:rows}}));

const close=async()=>{try{await pool.end()}finally{process.exit(0)}};process.on('SIGTERM',close);process.on('SIGINT',close);
app.listen({port:Number(process.env.PORT||8081),host:'0.0.0.0'});
