import {authenticate,installOrderAccess,transaction} from './access.js';
import {can,PERMISSIONS,roleAllowed} from './rbac.js';
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
const owner=async(req,reply)=>{if(!await authenticate(req,reply,pool))return;if(req.user.role!=='OWNER')return fail(reply,'FORBIDDEN','Доступно только владельцу',403)};
const auth=async(req,reply)=>{if(!await authenticate(req,reply,pool))return;};
const staffManager=async(req,reply)=>{if(!await authenticate(req,reply,pool))return;if(!can(req.user.role,PERMISSIONS.STAFF_MANAGE))return fail(reply,'FORBIDDEN','Управление наставниками доступно собственнику и управляющему',403)};
const operations=async(req,reply)=>{if(!await authenticate(req,reply,pool))return;if(!can(req.user.role,PERMISSIONS.OPERATIONS_MANAGE))return fail(reply,'FORBIDDEN','Управление участниками заказа недоступно этой роли',403)};
const phone=v=>String(v||'').replace(/\D/g,'').replace(/^8(?=7\d{9}$)/,'7');
const mergeTables=[
 ['requests','orders'],
 ['equipment','equipment'],
 ['complaints','complaints'],
 ['customer_feedback','feedback'],
 ['customer_visit_confirmations','visit_confirmations'],
 ['equipment_pickup_states','pickup_states'],
 ['service_contracts','service_contracts']
];
async function customerMergeSnapshot(c,id){
 const customer=(await c.query(`SELECT id,name,phone,phone_norm,email,address,notes,latitude,longitude,location_source,location_verified_at,created_at,updated_at,deleted_at,delete_reason FROM customers WHERE id=$1`,[id])).rows[0];
 if(!customer)return null;
 const counts={};
 for(const [table,key] of mergeTables)counts[key]=Number((await c.query(`SELECT count(*)::int value FROM ${table} WHERE customer_id=$1`,[id])).rows[0].value);
 counts.location_audit_preserved=Number((await c.query('SELECT count(*)::int value FROM engineer_route_location_audit WHERE customer_id=$1',[id])).rows[0].value);
 return{customer,counts};
}

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

installOrderAccess(app,pool,'directory-admin');
app.get('/health',async()=>{await q('SELECT 1');return{ok:true,service:'directory-admin',version:'1.4-customer-merge'}});

app.get('/api/v1/customers/deleted-by-phone',{preHandler:auth},async(req,reply)=>{if(!roleAllowed(req.user.role,['OWNER','MANAGER']))return fail(reply,'FORBIDDEN','Поиск удалённых клиентов доступен менеджеру, управляющему и владельцу',403);const pn=phone(req.query?.phone);if(!pn)return fail(reply,'VALIDATION','Укажите телефон');const row=(await q(`SELECT id,name,phone,email,address,notes,deleted_at,delete_reason FROM customers WHERE phone_norm=$1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 1`,[pn])).rows[0];return{data:row||null}});

app.get('/api/v1/customers/:id/merge-preview',{preHandler:owner},async(req,reply)=>{
 const sourceId=Number(req.params.id),targetId=Number(req.query?.target_id);
 if(!Number.isSafeInteger(sourceId)||!Number.isSafeInteger(targetId)||sourceId<1||targetId<1||sourceId===targetId)return fail(reply,'VALIDATION','Выберите двух разных клиентов');
 const [source,target]=await Promise.all([customerMergeSnapshot(pool,sourceId),customerMergeSnapshot(pool,targetId)]);
 if(!source||!target)return fail(reply,'NOT_FOUND','Клиент не найден',404);
 if(source.customer.deleted_at||target.customer.deleted_at)return fail(reply,'CUSTOMER_INACTIVE','Объединять можно только активных клиентов',409);
 return{data:{source,target,phones_match:Boolean(source.customer.phone_norm&&source.customer.phone_norm===target.customer.phone_norm)}};
});

app.post('/api/v1/customers/:id/merge',{preHandler:owner},async(req,reply)=>{
 const sourceId=Number(req.params.id),targetId=Number(req.body?.target_id),confirmedId=Number(req.body?.confirm_target_id),reason=String(req.body?.reason||'').trim();
 if(!Number.isSafeInteger(sourceId)||!Number.isSafeInteger(targetId)||sourceId<1||targetId<1||sourceId===targetId)return fail(reply,'VALIDATION','Выберите двух разных клиентов');
 if(confirmedId!==targetId)return fail(reply,'CONFIRMATION_REQUIRED','Подтвердите карточку клиента, которая останется основной',409);
 if(reason.length<5)return fail(reply,'VALIDATION','Укажите причину объединения минимум из 5 символов');
 const result=await tx(async c=>{
  const locked=(await c.query('SELECT * FROM customers WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE',[[sourceId,targetId]])).rows;
  const source=locked.find(x=>Number(x.id)===sourceId),target=locked.find(x=>Number(x.id)===targetId);
  if(!source||!target)abort('NOT_FOUND','Клиент не найден',404);
  if(source.deleted_at||target.deleted_at)abort('CUSTOMER_INACTIVE','Объединять можно только активных клиентов',409);
  const oldMerge=(await c.query('SELECT target_customer_id FROM customer_merge_audit WHERE source_customer_id=$1',[sourceId])).rows[0];
  if(oldMerge)abort('ALREADY_MERGED',`Клиент уже был объединён с карточкой ${oldMerge.target_customer_id}`,409);
  const before=await customerMergeSnapshot(c,sourceId),targetBefore=await customerMergeSnapshot(c,targetId);
  const targetAfter=(await c.query(`UPDATE customers SET
    email=COALESCE(NULLIF(email,''),NULLIF($1::text,'')),
    address=COALESCE(NULLIF(address,''),NULLIF($2::text,'')),
    notes=CASE WHEN NULLIF($3::text,'') IS NULL THEN notes WHEN NULLIF(notes,'') IS NULL THEN $3::text WHEN notes=$3::text THEN notes ELSE notes||E'\\n'||$3::text END,
    latitude=COALESCE(latitude,$4),longitude=COALESCE(longitude,$5),
    location_source=CASE WHEN latitude IS NULL AND $4::numeric IS NOT NULL THEN $6 ELSE location_source END,
    location_verified_at=CASE WHEN latitude IS NULL AND $4::numeric IS NOT NULL THEN $7 ELSE location_verified_at END,
    updated_at=now() WHERE id=$8 RETURNING *`,[source.email,source.address,source.notes,source.latitude,source.longitude,source.location_source,source.location_verified_at,targetId])).rows[0];
  await c.query(`INSERT INTO customer_merge_aliases(source_customer_id,target_customer_id,phone_norm) VALUES($1,$2,$3)`,[sourceId,targetId,source.phone_norm]);
  await c.query(`UPDATE customer_merge_aliases SET target_customer_id=$1 WHERE target_customer_id=$2`,[targetId,sourceId]);
  await c.query(`INSERT INTO request_history(request_id,user_id,action,details)
    SELECT id,$1::int,'CUSTOMER_MERGED',jsonb_build_object('source_customer_id',$2::int,'target_customer_id',$3::int,'reason',$4::text)
    FROM requests WHERE customer_id=$2`,[req.user.id,sourceId,targetId,reason]);
  for(const [table] of mergeTables)await c.query(`UPDATE ${table} SET customer_id=$1 WHERE customer_id=$2`,[targetId,sourceId]);
  await c.query(`UPDATE customers SET phone_norm=NULL,deleted_at=now(),deleted_by=$1,delete_reason=$2,updated_at=now() WHERE id=$3`,[req.user.id,`MERGED_INTO:${targetId}:${reason}`,sourceId]);
  const audit=(await c.query(`INSERT INTO customer_merge_audit(source_customer_id,target_customer_id,actor_id,reason,source_snapshot,target_before,target_after,moved_counts)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,created_at`,[sourceId,targetId,req.user.id,reason,before.customer,targetBefore.customer,targetAfter,before.counts])).rows[0];
  return{audit_id:audit.id,created_at:audit.created_at,source_customer_id:sourceId,target_customer_id:targetId,target:targetAfter,moved:before.counts};
 });
 return{data:result};
});

app.get('/api/v1/mentorship',{preHandler:auth},async(req,reply)=>{if(!can(req.user.role,PERMISSIONS.STAFF_VIEW)&&!can(req.user.role,PERMISSIONS.OPERATIONS_MANAGE))return fail(reply,'FORBIDDEN','Нет доступа к наставничеству',403);const rows=(await q(`SELECT t.id trainee_id,t.name trainee_name,t.active trainee_active,m.id mentor_id,m.name mentor_name,m.active mentor_active,um.assigned_at,ab.name assigned_by_name FROM users t LEFT JOIN user_mentors um ON um.trainee_id=t.id LEFT JOIN users m ON m.id=um.mentor_id LEFT JOIN users ab ON ab.id=um.assigned_by WHERE t.role='TRAINEE' ORDER BY t.active DESC,t.name`)).rows;return{data:rows}});

app.put('/api/v1/trainees/:id/mentor',{preHandler:staffManager},async(req,reply)=>{const traineeId=Number(req.params.id),mentorId=Number(req.body?.mentor_id);if(!Number.isSafeInteger(traineeId)||!Number.isSafeInteger(mentorId))return fail(reply,'VALIDATION','Укажите стажёра и наставника');const out=await tx(async c=>{const trainee=(await c.query("SELECT id,name FROM users WHERE id=$1 AND role='TRAINEE' AND active=true",[traineeId])).rows[0];if(!trainee)abort('NOT_FOUND','Активный стажёр не найден',404);const mentor=(await c.query("SELECT id,name FROM users WHERE id=$1 AND role='ENGINEER' AND active=true",[mentorId])).rows[0];if(!mentor)abort('VALIDATION','Наставником может быть только активный инженер');const removed=(await c.query(`UPDATE request_participants SET removed_at=now() WHERE user_id=$1 AND participant_role='TRAINEE' AND removed_at IS NULL AND COALESCE(mentor_id,0)<>$2 RETURNING request_id`,[traineeId,mentorId])).rows;await c.query(`INSERT INTO user_mentors(trainee_id,mentor_id,assigned_by,assigned_at,updated_at) VALUES($1,$2,$3,now(),now()) ON CONFLICT(trainee_id) DO UPDATE SET mentor_id=EXCLUDED.mentor_id,assigned_by=EXCLUDED.assigned_by,assigned_at=now(),updated_at=now()`,[traineeId,mentorId,req.user.id]);for(const row of removed)await c.query(`INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,'TRAINEE_REMOVED_MENTOR_CHANGED',$3)`,[row.request_id,req.user.id,{trainee_id:traineeId,new_mentor_id:mentorId}]);return{trainee_id:traineeId,trainee_name:trainee.name,mentor_id:mentorId,mentor_name:mentor.name,removed_from_orders:removed.length}});return{data:out}});

app.delete('/api/v1/trainees/:id/mentor',{preHandler:staffManager},async(req,reply)=>{const traineeId=Number(req.params.id);if(!Number.isSafeInteger(traineeId))return fail(reply,'VALIDATION','Некорректный стажёр');const out=await tx(async c=>{const current=(await c.query(`SELECT um.trainee_id,um.mentor_id,t.name trainee_name,m.name mentor_name FROM user_mentors um JOIN users t ON t.id=um.trainee_id JOIN users m ON m.id=um.mentor_id WHERE um.trainee_id=$1 FOR UPDATE`,[traineeId])).rows[0];if(!current)abort('NOT_FOUND','Наставник не назначен',404);const removed=(await c.query(`UPDATE request_participants SET removed_at=now() WHERE user_id=$1 AND participant_role='TRAINEE' AND removed_at IS NULL RETURNING request_id`,[traineeId])).rows;await c.query('DELETE FROM user_mentors WHERE trainee_id=$1',[traineeId]);for(const row of removed)await c.query(`INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,'TRAINEE_REMOVED_MENTOR_DETACHED',$3)`,[row.request_id,req.user.id,{trainee_id:traineeId,old_mentor_id:current.mentor_id}]);return{...current,removed_from_orders:removed.length}});return{data:out}});

app.get('/api/v1/requests/:id/participants',async(req)=>{const requestId=Number(req.params.id);const primary=(await q(`SELECT u.id,u.name,u.role FROM requests r LEFT JOIN users u ON u.id=r.engineer_id WHERE r.id=$1`,[requestId])).rows[0];const participants=(await q(`SELECT rp.id,rp.user_id,u.name,u.role participant_role,rp.mentor_id,m.name mentor_name,rp.added_at,ab.name added_by_name FROM request_participants rp JOIN users u ON u.id=rp.user_id LEFT JOIN users m ON m.id=rp.mentor_id LEFT JOIN users ab ON ab.id=rp.added_by WHERE rp.request_id=$1 AND rp.removed_at IS NULL ORDER BY rp.added_at`,[requestId])).rows;return{data:{primary_engineer:primary?.id?primary:null,participants}}});

app.post('/api/v1/requests/:id/participants',{preHandler:operations},async(req,reply)=>{const requestId=Number(req.params.id),userId=Number(req.body?.user_id);if(!Number.isSafeInteger(userId))return fail(reply,'VALIDATION','Укажите сотрудника');const out=await tx(async c=>{const order=(await c.query('SELECT id,number,engineer_id FROM requests WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[requestId])).rows[0];if(!order)abort('NOT_FOUND','Заказ не найден',404);const member=(await c.query(`SELECT id,name,role,active FROM users WHERE id=$1`,[userId])).rows[0];if(!member||!member.active||!['ENGINEER','TRAINEE'].includes(member.role))abort('VALIDATION','Участником может быть только активный инженер или стажёр');if(Number(order.engineer_id)===userId)abort('VALIDATION','Этот инженер уже назначен основным инженером');const existing=(await c.query(`SELECT id FROM request_participants WHERE request_id=$1 AND user_id=$2 AND removed_at IS NULL`,[requestId,userId])).rows[0];if(existing)return{id:existing.id,request_id:requestId,user_id:userId,participant_role:member.role,already_assigned:true};let mentorId=null;if(member.role==='TRAINEE'){const mentor=(await c.query(`SELECT um.mentor_id,m.active FROM user_mentors um JOIN users m ON m.id=um.mentor_id AND m.role='ENGINEER' WHERE um.trainee_id=$1`,[userId])).rows[0];if(!mentor?.active)abort('MENTOR_REQUIRED','Сначала назначьте стажёру активного наставника',409);mentorId=Number(mentor.mentor_id);if(!order.engineer_id||Number(order.engineer_id)!==mentorId)abort('MENTOR_ORDER_REQUIRED','Стажёр может участвовать только в заказе своего наставника',409)}const row=(await c.query(`INSERT INTO request_participants(request_id,user_id,participant_role,mentor_id,added_by) VALUES($1,$2,$3,$4,$5) RETURNING *`,[requestId,userId,member.role,mentorId,req.user.id])).rows[0];await c.query(`INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,'REQUEST_PARTICIPANT_ADDED',$3)`,[requestId,req.user.id,{participant_user_id:userId,participant_role:member.role,mentor_id:mentorId}]);return row});return reply.code(201).send({data:out})});

app.delete('/api/v1/requests/:id/participants/:userId',{preHandler:operations},async(req,reply)=>{const requestId=Number(req.params.id),userId=Number(req.params.userId);const out=await tx(async c=>{const row=(await c.query(`UPDATE request_participants SET removed_at=now() WHERE request_id=$1 AND user_id=$2 AND removed_at IS NULL RETURNING id,participant_role,mentor_id`,[requestId,userId])).rows[0];if(!row)abort('NOT_FOUND','Участник не найден в заказе',404);await c.query(`INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,'REQUEST_PARTICIPANT_REMOVED',$3)`,[requestId,req.user.id,{participant_user_id:userId,participant_role:row.participant_role,mentor_id:row.mentor_id}]);return{id:row.id,request_id:requestId,user_id:userId,removed:true}});return{data:out}});

app.get('/api/v1/deleted',{preHandler:owner},async()=>{const [customers,equipment]=await Promise.all([
 q(`SELECT c.id,c.name,c.phone,c.address,c.deleted_at,c.delete_reason,u.name deleted_by_name,(SELECT count(*) FROM requests r WHERE r.customer_id=c.id AND r.deleted_at IS NULL)::int request_count FROM customers c LEFT JOIN users u ON u.id=c.deleted_by WHERE c.deleted_at IS NOT NULL ORDER BY c.deleted_at DESC LIMIT 500`),
 q(`SELECT e.id,e.customer_id,e.category,e.brand,e.model,e.serial_number,e.deleted_at,e.delete_reason,c.name customer_name,u.name deleted_by_name FROM equipment e JOIN customers c ON c.id=e.customer_id LEFT JOIN users u ON u.id=e.deleted_by WHERE e.deleted_at IS NOT NULL ORDER BY e.deleted_at DESC LIMIT 1000`)
 ]);return{data:{customers:customers.rows,equipment:equipment.rows}}});

app.delete('/api/v1/customers/:id',{preHandler:owner},async req=>tx(async c=>{const reason=String(req.body?.reason||'').trim();if(reason.length<3)abort('VALIDATION','Укажите причину удаления клиента');const cur=(await c.query('SELECT * FROM customers WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!cur)abort('NOT_FOUND','Клиент не найден',404);if(cur.deleted_at)return{data:{id:cur.id,deleted:true}};const active=(await c.query(`SELECT count(*)::int c FROM requests WHERE customer_id=$1 AND deleted_at IS NULL AND status NOT IN ('CLOSED','CANCELLED')`,[cur.id])).rows[0].c;if(active>0)abort('ACTIVE_ORDERS',`У клиента ${active} активных заказов. Сначала закройте, отмените или удалите их.`,409);await c.query('UPDATE customers SET deleted_at=now(),deleted_by=$1,delete_reason=$2,updated_at=now() WHERE id=$3',[req.user.id,reason,cur.id]);await c.query(`UPDATE equipment SET deleted_at=now(),deleted_by=$1,delete_reason=$2,updated_at=now() WHERE customer_id=$3 AND deleted_at IS NULL`,[req.user.id,`AUTO_CUSTOMER:${cur.id}:${reason}`,cur.id]);return{data:{id:cur.id,deleted:true,message:'Клиент и его активная карточка техники перемещены в корзину. История заказов сохранена.'}}}));

app.post('/api/v1/customers/:id/restore',{preHandler:owner},async req=>tx(async c=>{const cur=(await c.query('SELECT * FROM customers WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!cur)abort('NOT_FOUND','Клиент не найден',404);if(!cur.deleted_at)return{data:{id:cur.id,restored:true}};if(String(cur.delete_reason||'').startsWith('MERGED_INTO:'))abort('MERGED_CUSTOMER','Объединённую карточку нельзя восстановить отдельно: её история уже перенесена в основную карточку',409);await c.query('UPDATE customers SET deleted_at=NULL,deleted_by=NULL,delete_reason=NULL,updated_at=now() WHERE id=$1',[cur.id]);await c.query(`UPDATE equipment SET deleted_at=NULL,deleted_by=NULL,delete_reason=NULL,updated_at=now() WHERE customer_id=$1 AND delete_reason LIKE $2`,[cur.id,`AUTO_CUSTOMER:${cur.id}:%`]);return{data:{id:cur.id,restored:true,message:'Клиент и техника, скрытая вместе с ним, восстановлены'}}}));

app.delete('/api/v1/equipment/:id',{preHandler:owner},async req=>tx(async c=>{const reason=String(req.body?.reason||'').trim();if(reason.length<3)abort('VALIDATION','Укажите причину удаления техники');const cur=(await c.query('SELECT * FROM equipment WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!cur)abort('NOT_FOUND','Техника не найдена',404);if(cur.deleted_at)return{data:{id:cur.id,deleted:true}};const active=(await c.query(`SELECT count(*)::int c FROM requests WHERE equipment_id=$1 AND deleted_at IS NULL AND status NOT IN ('CLOSED','CANCELLED')`,[cur.id])).rows[0].c;if(active>0)abort('ACTIVE_ORDERS',`По этой технике ${active} активных заказов. Сначала закройте, отмените или удалите их.`,409);await c.query('UPDATE equipment SET deleted_at=now(),deleted_by=$1,delete_reason=$2,updated_at=now() WHERE id=$3',[req.user.id,reason,cur.id]);return{data:{id:cur.id,deleted:true,message:'Техника перемещена в корзину. Старые заказы сохранены.'}}}));

app.post('/api/v1/equipment/:id/restore',{preHandler:owner},async req=>tx(async c=>{const cur=(await c.query('SELECT * FROM equipment WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!cur)abort('NOT_FOUND','Техника не найдена',404);const customer=(await c.query('SELECT deleted_at FROM customers WHERE id=$1',[cur.customer_id])).rows[0];if(customer?.deleted_at)abort('CUSTOMER_DELETED','Сначала восстановите клиента',409);await c.query('UPDATE equipment SET deleted_at=NULL,deleted_by=NULL,delete_reason=NULL,updated_at=now() WHERE id=$1',[cur.id]);return{data:{id:cur.id,restored:true}}}));

const close=async()=>{try{await pool.end()}finally{process.exit(0)}};process.on('SIGTERM',close);process.on('SIGINT',close);
app.listen({port:Number(process.env.PORT||8104),host:'0.0.0.0'});
