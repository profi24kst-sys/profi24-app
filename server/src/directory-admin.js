import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import pg from 'pg';

const app=Fastify({logger:true});
await app.register(jwt,{secret:process.env.JWT_SECRET||'dev-secret-change-me'});
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:5});
const q=(s,p=[])=>pool.query(s,p);
const fail=(r,code,message,status=422)=>r.code(status).send({data:null,error:{code,message}});
class ApiError extends Error{constructor(code,message,status=422){super(message);this.code=code;this.status=status}}
const abort=(code,message,status)=>{throw new ApiError(code,message,status)};
const tx=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const out=await fn(c);await c.query('COMMIT');return out}catch(e){try{await c.query('ROLLBACK')}catch{}throw e}finally{c.release()}};
const owner=async(req,reply)=>{try{await req.jwtVerify()}catch{return fail(reply,'UNAUTHORIZED','Требуется авторизация',401)}if(req.user.role!=='OWNER')return fail(reply,'FORBIDDEN','Доступно только владельцу',403)};
const auth=async(req,reply)=>{try{await req.jwtVerify()}catch{return fail(reply,'UNAUTHORIZED','Требуется авторизация',401)}};
const phone=v=>String(v||'').replace(/\D/g,'').replace(/^8(?=7\d{9}$)/,'7');

for(const s of[
 `ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
 `ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_by INT REFERENCES users(id)`,
 `ALTER TABLE customers ADD COLUMN IF NOT EXISTS delete_reason TEXT`,
 `ALTER TABLE equipment ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
 `ALTER TABLE equipment ADD COLUMN IF NOT EXISTS deleted_by INT REFERENCES users(id)`,
 `ALTER TABLE equipment ADD COLUMN IF NOT EXISTS delete_reason TEXT`,
 `CREATE INDEX IF NOT EXISTS idx_customers_deleted_at ON customers(deleted_at)`,
 `CREATE INDEX IF NOT EXISTS idx_equipment_deleted_at ON equipment(deleted_at)`
])await q(s);

app.setErrorHandler((e,req,reply)=>{if(e instanceof ApiError)return fail(reply,e.code,e.message,e.status);if(e.statusCode&&e.statusCode<500)return fail(reply,e.code||'REQUEST_ERROR',e.message,e.statusCode);req.log.error(e);return fail(reply,'INTERNAL_ERROR','Внутренняя ошибка сервера',500)});
app.get('/health',async()=>{await q('SELECT 1');return{ok:true,service:'directory-admin',version:'1.1.0'}});

app.get('/api/v1/customers/deleted-by-phone',{preHandler:auth},async(req,reply)=>{const pn=phone(req.query?.phone);if(!pn)return fail(reply,'VALIDATION','Укажите телефон');const row=(await q(`SELECT id,name,phone,email,address,notes,deleted_at,delete_reason FROM customers WHERE phone_norm=$1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 1`,[pn])).rows[0];return{data:row||null}});

app.get('/api/v1/deleted',{preHandler:owner},async()=>{const [customers,equipment]=await Promise.all([
 q(`SELECT c.id,c.name,c.phone,c.address,c.deleted_at,c.delete_reason,u.name deleted_by_name,(SELECT count(*) FROM requests r WHERE r.customer_id=c.id AND r.deleted_at IS NULL)::int request_count FROM customers c LEFT JOIN users u ON u.id=c.deleted_by WHERE c.deleted_at IS NOT NULL ORDER BY c.deleted_at DESC LIMIT 500`),
 q(`SELECT e.id,e.customer_id,e.category,e.brand,e.model,e.serial_number,e.deleted_at,e.delete_reason,c.name customer_name,u.name deleted_by_name FROM equipment e JOIN customers c ON c.id=e.customer_id LEFT JOIN users u ON u.id=e.deleted_by WHERE e.deleted_at IS NOT NULL ORDER BY e.deleted_at DESC LIMIT 1000`)
 ]);return{data:{customers:customers.rows,equipment:equipment.rows}}});

app.delete('/api/v1/customers/:id',{preHandler:owner},async req=>tx(async c=>{const reason=String(req.body?.reason||'').trim();if(reason.length<3)abort('VALIDATION','Укажите причину удаления клиента');const cur=(await c.query('SELECT * FROM customers WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!cur)abort('NOT_FOUND','Клиент не найден',404);if(cur.deleted_at)return{data:{id:cur.id,deleted:true}};const active=(await c.query(`SELECT count(*)::int c FROM requests WHERE customer_id=$1 AND deleted_at IS NULL AND status NOT IN ('CLOSED','CANCELLED')`,[cur.id])).rows[0].c;if(active>0)abort('ACTIVE_ORDERS',`У клиента ${active} активных заказов. Сначала закройте, отмените или удалите их.`,409);await c.query('UPDATE customers SET deleted_at=now(),deleted_by=$1,delete_reason=$2,updated_at=now() WHERE id=$3',[req.user.id,reason,cur.id]);await c.query(`UPDATE equipment SET deleted_at=now(),deleted_by=$1,delete_reason=$2,updated_at=now() WHERE customer_id=$3 AND deleted_at IS NULL`,[req.user.id,`AUTO_CUSTOMER:${cur.id}:${reason}`,cur.id]);return{data:{id:cur.id,deleted:true,message:'Клиент и его активная карточка техники перемещены в корзину. История заказов сохранена.'}}}));

app.post('/api/v1/customers/:id/restore',{preHandler:owner},async req=>tx(async c=>{const cur=(await c.query('SELECT * FROM customers WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!cur)abort('NOT_FOUND','Клиент не найден',404);if(!cur.deleted_at)return{data:{id:cur.id,restored:true}};await c.query('UPDATE customers SET deleted_at=NULL,deleted_by=NULL,delete_reason=NULL,updated_at=now() WHERE id=$1',[cur.id]);await c.query(`UPDATE equipment SET deleted_at=NULL,deleted_by=NULL,delete_reason=NULL,updated_at=now() WHERE customer_id=$1 AND delete_reason LIKE $2`,[cur.id,`AUTO_CUSTOMER:${cur.id}:%`]);return{data:{id:cur.id,restored:true,message:'Клиент и техника, скрытая вместе с ним, восстановлены'}}}));

app.delete('/api/v1/equipment/:id',{preHandler:owner},async req=>tx(async c=>{const reason=String(req.body?.reason||'').trim();if(reason.length<3)abort('VALIDATION','Укажите причину удаления техники');const cur=(await c.query('SELECT * FROM equipment WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!cur)abort('NOT_FOUND','Техника не найдена',404);if(cur.deleted_at)return{data:{id:cur.id,deleted:true}};const active=(await c.query(`SELECT count(*)::int c FROM requests WHERE equipment_id=$1 AND deleted_at IS NULL AND status NOT IN ('CLOSED','CANCELLED')`,[cur.id])).rows[0].c;if(active>0)abort('ACTIVE_ORDERS',`По этой технике ${active} активных заказов. Сначала закройте, отмените или удалите их.`,409);await c.query('UPDATE equipment SET deleted_at=now(),deleted_by=$1,delete_reason=$2,updated_at=now() WHERE id=$3',[req.user.id,reason,cur.id]);return{data:{id:cur.id,deleted:true,message:'Техника перемещена в корзину. Старые заказы сохранены.'}}}));

app.post('/api/v1/equipment/:id/restore',{preHandler:owner},async req=>tx(async c=>{const cur=(await c.query('SELECT * FROM equipment WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!cur)abort('NOT_FOUND','Техника не найдена',404);const customer=(await c.query('SELECT deleted_at FROM customers WHERE id=$1',[cur.customer_id])).rows[0];if(customer?.deleted_at)abort('CUSTOMER_DELETED','Сначала восстановите клиента',409);await c.query('UPDATE equipment SET deleted_at=NULL,deleted_by=NULL,delete_reason=NULL,updated_at=now() WHERE id=$1',[cur.id]);return{data:{id:cur.id,restored:true}}}));

const close=async()=>{try{await pool.end()}finally{process.exit(0)}};process.on('SIGTERM',close);process.on('SIGINT',close);
app.listen({port:Number(process.env.PORT||8104),host:'0.0.0.0'});
