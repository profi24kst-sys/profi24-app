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

const auth=async(req,reply)=>{try{await req.jwtVerify()}catch{return fail(reply,'UNAUTHORIZED','Требуется авторизация',401)}};
const staff=async(req,reply)=>{await auth(req,reply);if(reply.sent)return;if(!['OWNER','MANAGER'].includes(req.user.role))return fail(reply,'FORBIDDEN','Склад доступен владельцу и менеджерам',403)};

async function engineerBalance(c,itemId,engineerId){
 const r=await c.query(`SELECT COALESCE(sum(CASE WHEN movement_type='ISSUE' THEN quantity WHEN movement_type IN ('RETURN','INSTALL') THEN -quantity ELSE 0 END),0)::numeric balance FROM warehouse_movements WHERE item_id=$1 AND engineer_id=$2`,[itemId,engineerId]);
 return n(r.rows[0].balance);
}
async function recalcRequest(c,requestId){
 const works=(await c.query('SELECT COALESCE(sum(qty*unit_price),0) sale,COALESCE(sum(qty*direct_cost),0) cost FROM request_works WHERE request_id=$1',[requestId])).rows[0];
 const parts=(await c.query('SELECT COALESCE(sum(qty*sale_price),0) sale,COALESCE(sum(qty*purchase_price),0) cost FROM parts WHERE request_id=$1',[requestId])).rows[0];
 const req=(await c.query('SELECT discount_amount FROM requests WHERE id=$1',[requestId])).rows[0];
 if(!req)throw new Error('Заказ не найден');
 const total=Math.max(0,n(works.sale)+n(parts.sale)-n(req.discount_amount));
 const cost=n(works.cost)+n(parts.cost);
 await c.query('UPDATE requests SET total=$1,direct_cost=$2,updated_at=now() WHERE id=$3',[total,cost,requestId]);
}

app.setErrorHandler((e,req,reply)=>{req.log.error(e);if(e.code==='23505')return fail(reply,'DUPLICATE','Позиция с таким SKU уже существует',409);return fail(reply,'INTERNAL_ERROR',process.env.NODE_ENV==='production'?'Внутренняя ошибка склада':e.message,500)});
app.get('/health',async()=>{await q('SELECT 1');return {ok:true,service:'profi24-warehouse',version:'1.0.0'}});

app.get('/api/v1/stock',{preHandler:staff},async req=>{
 const search=String(req.query?.search||'').trim();const p=[];let where='WHERE active=true';
 if(search){p.push(`%${search}%`);where+=` AND (name ILIKE $1 OR COALESCE(sku,'') ILIKE $1 OR COALESCE(oem_code,'') ILIKE $1 OR COALESCE(supplier,'') ILIKE $1)`}
 const rows=(await q(`SELECT *,CASE WHEN quantity<=min_quantity THEN true ELSE false END low_stock,(quantity*purchase_price)::numeric stock_cost FROM warehouse_items ${where} ORDER BY low_stock DESC,name LIMIT 1000`,p)).rows;
 return {data:rows};
});

app.get('/api/v1/metrics',{preHandler:staff},async()=>{
 const s=(await q(`SELECT count(*) FILTER(WHERE active=true)::int positions,COALESCE(sum(quantity),0)::numeric units,COALESCE(sum(quantity*purchase_price),0)::numeric stock_cost,count(*) FILTER(WHERE active=true AND quantity<=min_quantity)::int low_stock FROM warehouse_items`)).rows[0];
 const issued=(await q(`SELECT COALESCE(sum(CASE WHEN movement_type='ISSUE' THEN quantity WHEN movement_type IN ('RETURN','INSTALL') THEN -quantity ELSE 0 END),0)::numeric issued_units FROM warehouse_movements`)).rows[0];
 return {data:{...s,...issued}};
});

app.post('/api/v1/items',{preHandler:staff},async(req,reply)=>{
 const {sku,name,oem_code,supplier,purchase_price=0,sale_price=0,min_quantity=0,location,notes}=req.body||{};
 if(!name?.trim())return fail(reply,'VALIDATION','Укажите название запчасти');
 const r=await q(`INSERT INTO warehouse_items(sku,name,oem_code,supplier,purchase_price,sale_price,min_quantity,location,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[sku?.trim()||null,name.trim(),oem_code?.trim()||null,supplier?.trim()||null,n(purchase_price),n(sale_price),n(min_quantity),location?.trim()||null,notes?.trim()||null]);
 return reply.code(201).send({data:r.rows[0]});
});

app.patch('/api/v1/items/:id',{preHandler:staff},async(req,reply)=>{
 const old=(await q('SELECT * FROM warehouse_items WHERE id=$1',[req.params.id])).rows[0];if(!old)return fail(reply,'NOT_FOUND','Позиция не найдена',404);
 const b={...old,...req.body};
 const r=await q(`UPDATE warehouse_items SET sku=$1,name=$2,oem_code=$3,supplier=$4,purchase_price=$5,sale_price=$6,min_quantity=$7,location=$8,notes=$9,active=$10,updated_at=now() WHERE id=$11 RETURNING *`,[b.sku||null,b.name,b.oem_code||null,b.supplier||null,n(b.purchase_price),n(b.sale_price),n(b.min_quantity),b.location||null,b.notes||null,b.active!==false,req.params.id]);
 return {data:r.rows[0]};
});

app.post('/api/v1/items/:id/receive',{preHandler:staff},async(req,reply)=>{
 const qty=n(req.body?.quantity);if(qty<=0)return fail(reply,'VALIDATION','Количество должно быть больше 0');
 const result=await tx(async c=>{const item=(await c.query('SELECT * FROM warehouse_items WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!item)throw new Error('Позиция не найдена');
 const unitCost=req.body?.purchase_price==null?n(item.purchase_price):n(req.body.purchase_price);const supplier=req.body?.supplier??item.supplier;
 const oldQty=n(item.quantity),oldCost=n(item.purchase_price);const newQty=oldQty+qty;const avg=newQty>0?((oldQty*oldCost)+(qty*unitCost))/newQty:unitCost;
 const updated=(await c.query('UPDATE warehouse_items SET quantity=$1,purchase_price=$2,supplier=COALESCE($3,supplier),updated_at=now() WHERE id=$4 RETURNING *',[newQty,avg,supplier||null,item.id])).rows[0];
 await c.query(`INSERT INTO warehouse_movements(item_id,movement_type,quantity,unit_cost,supplier,comment,created_by) VALUES($1,'RECEIPT',$2,$3,$4,$5,$6)`,[item.id,qty,unitCost,supplier||null,req.body?.comment||null,req.user.id]);return updated});
 return {data:result};
});

app.post('/api/v1/items/:id/issue',{preHandler:staff},async(req,reply)=>{
 const qty=n(req.body?.quantity),engineerId=n(req.body?.engineer_id);if(qty<=0||!engineerId)return fail(reply,'VALIDATION','Укажите количество и инженера');
 const result=await tx(async c=>{const item=(await c.query('SELECT * FROM warehouse_items WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!item)throw new Error('Позиция не найдена');if(n(item.quantity)<qty)throw new Error(`Недостаточно на складе. Доступно: ${item.quantity}`);
 const engineer=(await c.query("SELECT id FROM users WHERE id=$1 AND role='ENGINEER' AND active=true",[engineerId])).rows[0];if(!engineer)throw new Error('Инженер не найден');
 const updated=(await c.query('UPDATE warehouse_items SET quantity=quantity-$1,updated_at=now() WHERE id=$2 RETURNING *',[qty,item.id])).rows[0];
 await c.query(`INSERT INTO warehouse_movements(item_id,movement_type,quantity,engineer_id,unit_cost,sale_price,comment,created_by) VALUES($1,'ISSUE',$2,$3,$4,$5,$6,$7)`,[item.id,qty,engineerId,item.purchase_price,item.sale_price,req.body?.comment||null,req.user.id]);return updated});return {data:result};
});

app.post('/api/v1/items/:id/return',{preHandler:staff},async(req,reply)=>{
 const qty=n(req.body?.quantity),engineerId=n(req.body?.engineer_id);if(qty<=0||!engineerId)return fail(reply,'VALIDATION','Укажите количество и инженера');
 const result=await tx(async c=>{const item=(await c.query('SELECT * FROM warehouse_items WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!item)throw new Error('Позиция не найдена');const bal=await engineerBalance(c,item.id,engineerId);if(bal<qty)throw new Error(`У инженера числится только ${bal}`);
 const updated=(await c.query('UPDATE warehouse_items SET quantity=quantity+$1,updated_at=now() WHERE id=$2 RETURNING *',[qty,item.id])).rows[0];
 await c.query(`INSERT INTO warehouse_movements(item_id,movement_type,quantity,engineer_id,unit_cost,sale_price,comment,created_by) VALUES($1,'RETURN',$2,$3,$4,$5,$6,$7)`,[item.id,qty,engineerId,item.purchase_price,item.sale_price,req.body?.comment||null,req.user.id]);return updated});return {data:result};
});

app.post('/api/v1/items/:id/install',{preHandler:staff},async(req,reply)=>{
 const qty=n(req.body?.quantity),requestId=n(req.body?.request_id),engineerId=req.body?.engineer_id?n(req.body.engineer_id):null;if(qty<=0||!requestId)return fail(reply,'VALIDATION','Укажите количество и заказ');
 const result=await tx(async c=>{const item=(await c.query('SELECT * FROM warehouse_items WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!item)throw new Error('Позиция не найдена');const request=(await c.query('SELECT id,number FROM requests WHERE id=$1',[requestId])).rows[0];if(!request)throw new Error('Заказ не найден');
 if(engineerId){const bal=await engineerBalance(c,item.id,engineerId);if(bal<qty)throw new Error(`У инженера числится только ${bal}`)}else{if(n(item.quantity)<qty)throw new Error(`Недостаточно на складе. Доступно: ${item.quantity}`);await c.query('UPDATE warehouse_items SET quantity=quantity-$1,updated_at=now() WHERE id=$2',[qty,item.id])}
 const sale=req.body?.sale_price==null?n(item.sale_price):n(req.body.sale_price);
 await c.query(`INSERT INTO warehouse_movements(item_id,movement_type,quantity,engineer_id,request_id,unit_cost,sale_price,comment,created_by) VALUES($1,'INSTALL',$2,$3,$4,$5,$6,$7,$8)`,[item.id,qty,engineerId,requestId,item.purchase_price,sale,req.body?.comment||null,req.user.id]);
 await c.query(`INSERT INTO parts(request_id,name,oem_code,qty,purchase_price,sale_price,supplier,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'INSTALLED',$8)`,[requestId,item.name,item.oem_code,qty,item.purchase_price,sale,item.supplier,req.user.id]);
 await recalcRequest(c,requestId);await c.query('INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,$3,$4)',[requestId,req.user.id,'WAREHOUSE_PART_INSTALLED',{warehouse_item_id:item.id,name:item.name,qty,engineer_id:engineerId}]);return {request_number:request.number,item_id:item.id,quantity:qty}});return {data:result};
});

app.post('/api/v1/items/:id/write-off',{preHandler:staff},async(req,reply)=>{
 const qty=n(req.body?.quantity);if(qty<=0)return fail(reply,'VALIDATION','Количество должно быть больше 0');
 const result=await tx(async c=>{const item=(await c.query('SELECT * FROM warehouse_items WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!item)throw new Error('Позиция не найдена');if(n(item.quantity)<qty)throw new Error(`Недостаточно на складе. Доступно: ${item.quantity}`);const updated=(await c.query('UPDATE warehouse_items SET quantity=quantity-$1,updated_at=now() WHERE id=$2 RETURNING *',[qty,item.id])).rows[0];await c.query(`INSERT INTO warehouse_movements(item_id,movement_type,quantity,unit_cost,comment,created_by) VALUES($1,'WRITE_OFF',$2,$3,$4,$5)`,[item.id,qty,item.purchase_price,req.body?.comment||null,req.user.id]);return updated});return {data:result};
});

app.get('/api/v1/movements',{preHandler:staff},async req=>{
 const limit=Math.min(500,Math.max(1,n(req.query?.limit)||200));
 const rows=(await q(`SELECT m.*,i.name item_name,i.sku,i.oem_code,u.name engineer_name,r.number request_number,cb.name created_by_name FROM warehouse_movements m JOIN warehouse_items i ON i.id=m.item_id LEFT JOIN users u ON u.id=m.engineer_id LEFT JOIN requests r ON r.id=m.request_id LEFT JOIN users cb ON cb.id=m.created_by ORDER BY m.created_at DESC LIMIT $1`,[limit])).rows;return {data:rows};
});

app.get('/api/v1/engineer-stock',{preHandler:staff},async()=>{
 const rows=(await q(`SELECT m.item_id,i.name,i.sku,i.oem_code,m.engineer_id,u.name engineer_name,COALESCE(sum(CASE WHEN m.movement_type='ISSUE' THEN m.quantity WHEN m.movement_type IN ('RETURN','INSTALL') THEN -m.quantity ELSE 0 END),0)::numeric quantity,i.purchase_price,i.sale_price FROM warehouse_movements m JOIN warehouse_items i ON i.id=m.item_id JOIN users u ON u.id=m.engineer_id WHERE m.engineer_id IS NOT NULL GROUP BY m.item_id,i.name,i.sku,i.oem_code,m.engineer_id,u.name,i.purchase_price,i.sale_price HAVING COALESCE(sum(CASE WHEN m.movement_type='ISSUE' THEN m.quantity WHEN m.movement_type IN ('RETURN','INSTALL') THEN -m.quantity ELSE 0 END),0)>0 ORDER BY u.name,i.name`)).rows;return {data:rows};
});

const close=async()=>{try{await pool.end()}finally{process.exit(0)}};process.on('SIGTERM',close);process.on('SIGINT',close);
app.listen({port:Number(process.env.PORT||8081),host:'0.0.0.0'});
