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
for(const s of schema)await q(s);
await q(`CREATE TABLE IF NOT EXISTS stock_reservations(id SERIAL PRIMARY KEY,item_id INT REFERENCES warehouse_items(id),request_id INT REFERENCES requests(id),quantity NUMERIC(14,3) NOT NULL,status TEXT DEFAULT 'ACTIVE',created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now(),released_at TIMESTAMPTZ)`);
for(const s of warehouseBranchStatements)await q(s);

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

installOrderAccess(app,pool,'warehouse');
app.get('/health',async()=>{await q('SELECT 1');return {ok:true,service:'profi24-warehouse',version:'1.2-branches'}});

app.get('/api/v1/stock',{preHandler:warehouseView},async req=>{
 const search=String(req.query?.search||'').trim(),requested=req.query?.branch_id?n(req.query.branch_id):null;
 const ids=await branchIds(pool,req.user);if(requested)await assertBranchAccess(pool,req.user,requested);
 const p=[];let where='WHERE i.active=true';
 if(ids){p.push(ids);where+=` AND i.branch_id=ANY($${p.length}::int[])`}
 if(requested){p.push(requested);where+=` AND i.branch_id=$${p.length}`}
 if(search){p.push(`%${search}%`);where+=` AND (i.name ILIKE $${p.length} OR COALESCE(i.sku,'') ILIKE $${p.length} OR COALESCE(i.oem_code,'') ILIKE $${p.length} OR COALESCE(i.supplier,'') ILIKE $${p.length})`}
 const rows=(await q(`SELECT i.*,b.code branch_code,b.name branch_name,CASE WHEN i.quantity<=i.min_quantity THEN true ELSE false END low_stock,(i.quantity*i.purchase_price)::numeric stock_cost FROM warehouse_items i JOIN branches b ON b.id=i.branch_id ${where} ORDER BY low_stock DESC,b.name,i.name LIMIT 1000`,p)).rows;
 return {data:rows};
});

app.get('/api/v1/metrics',{preHandler:warehouseView},async req=>{
 const ids=await branchIds(pool,req.user),p=[];let where='WHERE i.active=true',mw='WHERE true';
 if(ids){p.push(ids);where+=` AND i.branch_id=ANY($1::int[])`;mw+=` AND m.branch_id=ANY($1::int[])`}
 const s=(await q(`SELECT count(*)::int positions,COALESCE(sum(i.quantity),0)::numeric units,COALESCE(sum(i.quantity*i.purchase_price),0)::numeric stock_cost,count(*) FILTER(WHERE i.quantity<=i.min_quantity)::int low_stock FROM warehouse_items i ${where}`,p)).rows[0];
 const issued=(await q(`SELECT COALESCE(sum(CASE WHEN m.movement_type='ISSUE' THEN m.quantity WHEN m.movement_type IN ('RETURN','INSTALL') THEN -m.quantity ELSE 0 END),0)::numeric issued_units FROM warehouse_movements m ${mw}`,p)).rows[0];
 return {data:{...s,...issued}};
});

app.post('/api/v1/items',{preHandler:warehouseReceive},async(req,reply)=>{
 const {sku,name,oem_code,supplier,purchase_price=0,sale_price=0,min_quantity=0,location,notes}=req.body||{};
 if(!name?.trim())return fail(reply,'VALIDATION','Укажите название запчасти');
 const branchId=req.body?.branch_id?n(req.body.branch_id):await defaultBranch(pool,req.user);await assertBranchAccess(pool,req.user,branchId);
 try{const r=await q(`INSERT INTO warehouse_items(branch_id,sku,name,oem_code,supplier,purchase_price,sale_price,min_quantity,location,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[branchId,sku?.trim()||null,name.trim(),oem_code?.trim()||null,supplier?.trim()||null,n(purchase_price),n(sale_price),n(min_quantity),location?.trim()||null,notes?.trim()||null]);return reply.code(201).send({data:r.rows[0]})}catch(e){if(e.code==='23505')return fail(reply,'DUPLICATE','Такая складская позиция уже есть в этом филиале',409);throw e}
});

app.patch('/api/v1/items/:id',{preHandler:warehouseReceive},async(req,reply)=>{
 const old=await scopedItem(pool,req.user,req.params.id);if(req.body?.branch_id!=null&&Number(req.body.branch_id)!==Number(old.branch_id))return fail(reply,'TRANSFER_REQUIRED','Для смены филиала используйте документ перемещения',409);
 const b={...old,...req.body};
 const r=await q(`UPDATE warehouse_items SET sku=$1,name=$2,oem_code=$3,supplier=$4,purchase_price=$5,sale_price=$6,min_quantity=$7,location=$8,notes=$9,active=$10,updated_at=now() WHERE id=$11 RETURNING *`,[b.sku||null,b.name,b.oem_code||null,b.supplier||null,n(b.purchase_price),n(b.sale_price),n(b.min_quantity),b.location||null,b.notes||null,b.active!==false,req.params.id]);
 return {data:r.rows[0]};
});

app.post('/api/v1/items/:id/receive',{preHandler:warehouseReceive},async(req,reply)=>{
 const qty=n(req.body?.quantity);if(!Number.isFinite(qty)||qty<=0)return fail(reply,'VALIDATION','Количество должно быть больше 0');
 const result=await tx(async c=>{const item=await scopedItem(c,req.user,req.params.id,{lock:true});
 const unitCost=req.body?.purchase_price==null?n(item.purchase_price):n(req.body.purchase_price);const supplier=req.body?.supplier??item.supplier;
 const oldQty=n(item.quantity),oldCost=n(item.purchase_price);const newQty=oldQty+qty;const avg=newQty>0?((oldQty*oldCost)+(qty*unitCost))/newQty:unitCost;
 const updated=(await c.query('UPDATE warehouse_items SET quantity=$1,purchase_price=$2,supplier=COALESCE($3,supplier),updated_at=now() WHERE id=$4 RETURNING *',[newQty,avg,supplier||null,item.id])).rows[0];
 await c.query(`INSERT INTO warehouse_movements(item_id,movement_type,quantity,unit_cost,supplier,comment,created_by) VALUES($1,'RECEIPT',$2,$3,$4,$5,$6)`,[item.id,qty,unitCost,supplier||null,req.body?.comment||null,req.user.id]);return updated});
 return {data:result};
});

app.post('/api/v1/items/:id/issue',{preHandler:warehouseIssue},async(req,reply)=>{
 const qty=n(req.body?.quantity),engineerId=n(req.body?.engineer_id);if(!Number.isFinite(qty)||qty<=0||!engineerId)return fail(reply,'VALIDATION','Укажите количество и инженера');
 const result=await tx(async c=>{const item=await scopedItem(c,req.user,req.params.id,{lock:true});await requireStock(c,item,qty);
 const engineer=(await c.query("SELECT u.id FROM users u JOIN user_branches ub ON ub.user_id=u.id WHERE u.id=$1 AND u.role='ENGINEER' AND u.active=true AND ub.branch_id=$2",[engineerId,item.branch_id])).rows[0];if(!engineer)throw Object.assign(new Error('Инженер не относится к филиалу этого склада'),{code:'FORBIDDEN',statusCode:403});
 const updated=(await c.query('UPDATE warehouse_items SET quantity=quantity-$1,updated_at=now() WHERE id=$2 RETURNING *',[qty,item.id])).rows[0];
 await c.query(`INSERT INTO warehouse_movements(item_id,movement_type,quantity,engineer_id,unit_cost,sale_price,comment,created_by) VALUES($1,'ISSUE',$2,$3,$4,$5,$6,$7)`,[item.id,qty,engineerId,item.purchase_price,item.sale_price,req.body?.comment||null,req.user.id]);return updated});return {data:result};
});

app.post('/api/v1/items/:id/return',{preHandler:warehouseIssue},async(req,reply)=>{
 const qty=n(req.body?.quantity),engineerId=n(req.body?.engineer_id);if(!Number.isFinite(qty)||qty<=0||!engineerId)return fail(reply,'VALIDATION','Укажите количество и инженера');
 const result=await tx(async c=>{const item=await scopedItem(c,req.user,req.params.id,{lock:true});const bal=await engineerBalance(c,item.id,engineerId);if(bal<qty)throw new Error(`У инженера числится только ${bal}`);
 const updated=(await c.query('UPDATE warehouse_items SET quantity=quantity+$1,updated_at=now() WHERE id=$2 RETURNING *',[qty,item.id])).rows[0];
 await c.query(`INSERT INTO warehouse_movements(item_id,movement_type,quantity,engineer_id,unit_cost,sale_price,comment,created_by) VALUES($1,'RETURN',$2,$3,$4,$5,$6,$7)`,[item.id,qty,engineerId,item.purchase_price,item.sale_price,req.body?.comment||null,req.user.id]);return updated});return {data:result};
});

app.post('/api/v1/items/:id/install',{preHandler:warehouseIssue},async(req,reply)=>{
 const qty=n(req.body?.quantity),requestId=n(req.body?.request_id),engineerId=req.body?.engineer_id?n(req.body.engineer_id):null;if(!Number.isFinite(qty)||qty<=0||!requestId)return fail(reply,'VALIDATION','Укажите количество и заказ');
 const result=await tx(async c=>{const item=await scopedItem(c,req.user,req.params.id,{lock:true});const request=await requireOrder(c,req.user,requestId,{mutable:true,lock:true});if(Number(request.branch_id)!==Number(item.branch_id))throw Object.assign(new Error('Заказ относится к другому филиалу. Сначала переместите запчасть на его склад.'),{code:'BRANCH_MISMATCH',statusCode:409});
 if(engineerId){const bal=await engineerBalance(c,item.id,engineerId);if(bal<qty)throw new Error(`У инженера числится только ${bal}`)}else{await requireStock(c,item,qty,requestId);await consumeReservations(c,requestId,item.id,qty);await c.query('UPDATE warehouse_items SET quantity=quantity-$1,updated_at=now() WHERE id=$2',[qty,item.id])}
 const sale=req.body?.sale_price==null?n(item.sale_price):n(req.body.sale_price);
 await c.query(`INSERT INTO warehouse_movements(item_id,movement_type,quantity,engineer_id,request_id,unit_cost,sale_price,comment,created_by) VALUES($1,'INSTALL',$2,$3,$4,$5,$6,$7,$8)`,[item.id,qty,engineerId,requestId,item.purchase_price,sale,req.body?.comment||null,req.user.id]);
 await c.query(`INSERT INTO parts(request_id,name,oem_code,qty,purchase_price,sale_price,supplier,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'INSTALLED',$8)`,[requestId,item.name,item.oem_code,qty,item.purchase_price,sale,item.supplier,req.user.id]);
 await recalcRequest(c,requestId);await c.query('INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,$3,$4)',[requestId,req.user.id,'WAREHOUSE_PART_INSTALLED',{warehouse_item_id:item.id,branch_id:item.branch_id,name:item.name,qty,engineer_id:engineerId}]);return {request_number:request.number,item_id:item.id,quantity:qty}});return {data:result};
});

app.post('/api/v1/items/:id/write-off',{preHandler:warehouseWriteoff},async(req,reply)=>{
 const qty=n(req.body?.quantity),comment=String(req.body?.comment||'').trim();if(!Number.isFinite(qty)||qty<=0)return fail(reply,'VALIDATION','Количество должно быть больше 0');if(comment.length<3)return fail(reply,'VALIDATION','Укажите причину списания');
 const result=await tx(async c=>{const item=await scopedItem(c,req.user,req.params.id,{lock:true});await requireStock(c,item,qty);const updated=(await c.query('UPDATE warehouse_items SET quantity=quantity-$1,updated_at=now() WHERE id=$2 RETURNING *',[qty,item.id])).rows[0];await c.query(`INSERT INTO warehouse_movements(item_id,movement_type,quantity,unit_cost,comment,created_by) VALUES($1,'WRITE_OFF',$2,$3,$4,$5)`,[item.id,qty,item.purchase_price,comment,req.user.id]);return updated});return {data:result};
});

app.post('/api/v1/items/:id/transfer',{preHandler:warehouseWriteoff},async(req,reply)=>{
 const qty=n(req.body?.quantity),toBranch=n(req.body?.to_branch_id),reason=String(req.body?.reason||'').trim(),doc=String(req.body?.document_reference||'').trim(),key=String(req.body?.transfer_key||'').trim();
 if(!Number.isFinite(qty)||qty<=0||!toBranch)return fail(reply,'VALIDATION','Укажите количество и филиал назначения');if(reason.length<3||doc.length<2)return fail(reply,'VALIDATION','Укажите причину и документ перемещения');if(!/^[-\w:]{8,160}$/.test(key))return fail(reply,'IDEMPOTENCY_REQUIRED','Обновите форму перемещения: нет уникального номера операции');
 const result=await tx(async c=>{
   const replay=(await c.query('SELECT * FROM warehouse_transfers WHERE transfer_key=$1',[key])).rows[0];if(replay)return replay;
   const source=await scopedItem(c,req.user,req.params.id,{lock:true});if(Number(source.branch_id)===toBranch)throw new Error('Выберите другой филиал');await assertBranchAccess(c,req.user,toBranch);await requireStock(c,source,qty);
   const branch=(await c.query('SELECT id FROM branches WHERE id=$1 AND active=true',[toBranch])).rows[0];if(!branch)throw Object.assign(new Error('Филиал назначения не найден или отключён'),{code:'NOT_FOUND',statusCode:404});
   let dest=null;if(source.sku)dest=(await c.query('SELECT * FROM warehouse_items WHERE branch_id=$1 AND sku=$2 FOR UPDATE',[toBranch,source.sku])).rows[0];
   if(!dest&&source.oem_code)dest=(await c.query('SELECT * FROM warehouse_items WHERE branch_id=$1 AND oem_code=$2 AND active=true ORDER BY id LIMIT 1 FOR UPDATE',[toBranch,source.oem_code])).rows[0];
   if(!dest)dest=(await c.query('SELECT * FROM warehouse_items WHERE branch_id=$1 AND lower(name)=lower($2) AND active=true ORDER BY id LIMIT 1 FOR UPDATE',[toBranch,source.name])).rows[0];
   if(!dest)dest=(await c.query(`INSERT INTO warehouse_items(branch_id,sku,name,oem_code,supplier,purchase_price,sale_price,quantity,min_quantity,location,notes,active) VALUES($1,$2,$3,$4,$5,$6,$7,0,$8,NULL,$9,true) RETURNING *`,[toBranch,source.sku,source.name,source.oem_code,source.supplier,source.purchase_price,source.sale_price,source.min_quantity,source.notes])).rows[0];
   const destQty=n(dest.quantity),newDestQty=destQty+qty,newAvg=newDestQty?((destQty*n(dest.purchase_price))+(qty*n(source.purchase_price)))/newDestQty:n(source.purchase_price);
   await c.query('UPDATE warehouse_items SET quantity=quantity-$1,updated_at=now() WHERE id=$2',[qty,source.id]);
   await c.query('UPDATE warehouse_items SET quantity=$1,purchase_price=$2,updated_at=now() WHERE id=$3',[newDestQty,newAvg,dest.id]);
   const tr=(await c.query(`INSERT INTO warehouse_transfers(transfer_key,from_branch_id,to_branch_id,source_item_id,destination_item_id,quantity,unit_cost,reason,document_reference,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[key,source.branch_id,toBranch,source.id,dest.id,qty,source.purchase_price,reason,doc,req.user.id])).rows[0];
   await c.query(`INSERT INTO warehouse_movements(item_id,movement_type,quantity,unit_cost,comment,created_by) VALUES($1,'TRANSFER_OUT',$2,$3,$4,$5)`,[source.id,qty,source.purchase_price,`Перемещение #${tr.id}: ${reason}; ${doc}`,req.user.id]);
   await c.query(`INSERT INTO warehouse_movements(item_id,movement_type,quantity,unit_cost,comment,created_by) VALUES($1,'TRANSFER_IN',$2,$3,$4,$5)`,[dest.id,qty,source.purchase_price,`Перемещение #${tr.id}: ${reason}; ${doc}`,req.user.id]);
   return tr;
 });return {data:result};
});

app.get('/api/v1/movements',{preHandler:warehouseView},async req=>{
 const limit=Math.min(500,Math.max(1,n(req.query?.limit)||200)),ids=await branchIds(pool,req.user),p=[];let where='';if(ids){p.push(ids);where='WHERE m.branch_id=ANY($1::int[])'}p.push(limit);
 const rows=(await q(`SELECT m.*,i.name item_name,i.sku,i.oem_code,b.code branch_code,b.name branch_name,u.name engineer_name,r.number request_number,cb.name created_by_name FROM warehouse_movements m JOIN warehouse_items i ON i.id=m.item_id JOIN branches b ON b.id=m.branch_id LEFT JOIN users u ON u.id=m.engineer_id LEFT JOIN requests r ON r.id=m.request_id LEFT JOIN users cb ON cb.id=m.created_by ${where} ORDER BY m.created_at DESC LIMIT $${p.length}`,p)).rows;return {data:rows};
});

app.get('/api/v1/engineer-stock',{preHandler:warehouseView},async req=>{
 const ids=await branchIds(pool,req.user),p=[];let scope='WHERE m.engineer_id IS NOT NULL';if(ids){p.push(ids);scope+=' AND m.branch_id=ANY($1::int[])'}
 const rows=(await q(`SELECT m.item_id,i.name,i.sku,i.oem_code,i.branch_id,b.code branch_code,b.name branch_name,m.engineer_id,u.name engineer_name,COALESCE(sum(CASE WHEN m.movement_type='ISSUE' THEN m.quantity WHEN m.movement_type IN ('RETURN','INSTALL') THEN -m.quantity ELSE 0 END),0)::numeric quantity,i.purchase_price,i.sale_price FROM warehouse_movements m JOIN warehouse_items i ON i.id=m.item_id JOIN branches b ON b.id=i.branch_id JOIN users u ON u.id=m.engineer_id ${scope} GROUP BY m.item_id,i.name,i.sku,i.oem_code,i.branch_id,b.code,b.name,m.engineer_id,u.name,i.purchase_price,i.sale_price HAVING COALESCE(sum(CASE WHEN m.movement_type='ISSUE' THEN m.quantity WHEN m.movement_type IN ('RETURN','INSTALL') THEN -m.quantity ELSE 0 END),0)>0 ORDER BY b.name,u.name,i.name`,p)).rows;return {data:rows};
});

app.get('/api/v1/transfers',{preHandler:warehouseView},async req=>{
 const ids=await branchIds(pool,req.user),p=[];let where='';if(ids){p.push(ids);where='WHERE t.from_branch_id=ANY($1::int[]) OR t.to_branch_id=ANY($1::int[])'}
 const rows=(await q(`SELECT t.*,fb.name from_branch_name,tb.name to_branch_name,si.name item_name,si.sku,si.oem_code,u.name created_by_name FROM warehouse_transfers t JOIN branches fb ON fb.id=t.from_branch_id JOIN branches tb ON tb.id=t.to_branch_id JOIN warehouse_items si ON si.id=t.source_item_id LEFT JOIN users u ON u.id=t.created_by ${where} ORDER BY t.created_at DESC LIMIT 300`,p)).rows;return {data:rows};
});

const close=async()=>{try{await pool.end()}finally{process.exit(0)}};process.on('SIGTERM',close);process.on('SIGINT',close);
app.listen({port:Number(process.env.PORT||8081),host:'0.0.0.0'});
