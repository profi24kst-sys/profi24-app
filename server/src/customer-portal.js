import crypto from 'node:crypto';
import {authenticate,requireOrder} from './access.js';

const officeRoles=new Set(['OWNER','SUPERVISOR','MANAGER']);
const publicEvents=new Map([
 ['REQUEST_CREATED','Заявка принята'],['REQUEST_ASSIGNED','Назначен специалист'],['REQUEST_ACCEPTED','Заявка принята специалистом'],
 ['WORKFLOW_ACCEPT','Специалист принял заявку'],['WORKFLOW_DEPART','Специалист выехал'],['WORKFLOW_ARRIVE','Специалист прибыл'],
 ['DIAGNOSIS_COMPLETED','Диагностика завершена'],['WORKFLOW_SEND_APPROVAL','Стоимость направлена на согласование'],
 ['CUSTOMER_APPROVED','Стоимость согласована'],['CUSTOMER_DECLINED','Клиент отказался от ремонта'],['WORKFLOW_START_REPAIR','Ремонт начат'],
 ['WORKFLOW_START_TEST','Идёт проверка после ремонта'],['WORKFLOW_REQUEST_PAYMENT','Ремонт завершён, ожидается оплата'],
 ['PAYMENT_RECEIVED','Оплата получена'],['PAYMENT_REFUNDED','Оплата возвращена'],['REQUEST_CLOSED','Заказ завершён'],
 ['WORKFLOW_CLOSE','Заказ завершён'],['REQUEST_CANCELLED','Заказ отменён'],['WARRANTY_ISSUED','Гарантия оформлена']
]);
const hashToken=token=>crypto.createHash('sha256').update(String(token||'')).digest('hex');
const fail=(reply,code,message,status=422)=>reply.code(status).send({data:null,error:{code,message}});
const id=value=>{const n=Number(value);return Number.isSafeInteger(n)&&n>0?n:null};
const baseUrl=()=>String(process.env.PUBLIC_BASE_URL||process.env.CORS_ORIGIN?.split(',')[0]||'http://localhost:5173').replace(/\/$/,'');

async function tableExists(pool,name){return Boolean((await pool.query('SELECT to_regclass($1) name',[`public.${name}`])).rows[0]?.name)}
async function authenticated(req,reply,pool){if(!await authenticate(req,reply,pool))return false;if(!officeRoles.has(req.user.role)){fail(reply,'FORBIDDEN','Недостаточно прав',403);return false}return true}
async function accessibleOrder(pool,user,requestId,reply){try{return await requireOrder(pool,user,requestId)}catch(error){fail(reply,error.code||'FORBIDDEN',error.message||'Нет доступа к заказу',error.statusCode||403);return null}}

async function queuePortalMessage(pool,{requestId,phone,customerName,url,linkId,createdBy}){
 try{
  if(!await tableExists(pool,'message_queue'))return false;
  const body=`${customerName}, для вас создан личный кабинет PROFI24. Здесь можно следить за статусом и историей ремонта: ${url}`;
  await pool.query(`INSERT INTO message_queue(request_id,template_code,channel,audience,recipient,body,status,dedupe_key,created_by)
    VALUES($1,'CUSTOMER_PORTAL_LINK','WHATSAPP','CUSTOMER',$2,$3,$4,$5,$6) ON CONFLICT(dedupe_key) DO NOTHING`,
    [requestId,phone,body,phone?'QUEUED':'WAITING_RECIPIENT',`customer-portal:${linkId}`,createdBy]);
  return true;
 }catch{return false}
}

async function publicOrder(pool,row){
 const history=(await pool.query(`SELECT action,created_at FROM request_history WHERE request_id=$1 AND action=ANY($2::text[]) ORDER BY id`,[row.id,[...publicEvents.keys()]])).rows
   .map(x=>({label:publicEvents.get(x.action),created_at:x.created_at}));
 const actions={};
 if(await tableExists(pool,'customer_approvals')){
  const approval=(await pool.query(`SELECT token,status,expires_at FROM customer_approvals WHERE request_id=$1 ORDER BY version DESC LIMIT 1`,[row.id])).rows[0];
  if(approval?.status==='PENDING'&&new Date(approval.expires_at)>new Date())actions.approval_url=`/approve/${approval.token}`;
 }
 if(await tableExists(pool,'warranty_cards')){
  const warranty=(await pool.query(`SELECT token,warranty_until FROM warranty_cards WHERE request_id=$1 LIMIT 1`,[row.id])).rows[0];
  if(warranty){actions.warranty_url=`/warranty/${warranty.token}`;actions.warranty_until=warranty.warranty_until}
 }
 return {...row,timeline:history,actions};
}

export function installCustomerPortal(app,pool){
 app.post('/api/v1/customer-portal/requests/:id/link',async(req,reply)=>{
  if(!await authenticated(req,reply,pool))return;
  const requestId=id(req.params.id);if(!requestId)return fail(reply,'VALIDATION','Некорректный заказ');
  const order=await accessibleOrder(pool,req.user,requestId,reply);if(!order)return;
  const customer=(await pool.query('SELECT id,name,phone FROM customers WHERE id=$1 AND deleted_at IS NULL',[order.customer_id])).rows[0];
  if(!customer)return fail(reply,'CUSTOMER_NOT_FOUND','Клиент не найден',404);
  const days=Math.min(90,Math.max(1,Number(req.body?.expires_days)||30));
  const raw=crypto.randomBytes(32).toString('hex'),tokenHash=hashToken(raw);
  const c=await pool.connect();let link;
  try{
   await c.query('BEGIN');
   await c.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE',[customer.id]);
   await c.query('UPDATE customer_portal_links SET revoked_at=COALESCE(revoked_at,now()) WHERE customer_id=$1 AND revoked_at IS NULL',[customer.id]);
   link=(await c.query(`INSERT INTO customer_portal_links(customer_id,source_request_id,token_hash,created_by,expires_at)
     VALUES($1,$2,$3,$4,now()+($5||' days')::interval) RETURNING id,customer_id,source_request_id,created_at,expires_at`,
     [customer.id,requestId,tokenHash,req.user.id,String(days)])).rows[0];
   await c.query(`INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,'CUSTOMER_PORTAL_LINK_CREATED',$3)`,[requestId,req.user.id,{portal_link_id:link.id,expires_at:link.expires_at}]);
   await c.query('COMMIT');
  }catch(error){try{await c.query('ROLLBACK')}catch{}throw error}finally{c.release()}
  const url=`${baseUrl()}/client/${raw}`;
  const queued=req.body?.send===true?await queuePortalMessage(pool,{requestId,phone:customer.phone,customerName:customer.name,url,linkId:link.id,createdBy:req.user.id}):false;
  return reply.code(201).send({data:{...link,customer_name:customer.name,url:`/client/${raw}`,message_queued:queued}});
 });

 app.get('/api/v1/customer-portal/requests/:id/link',async(req,reply)=>{
  if(!await authenticated(req,reply,pool))return;
  const requestId=id(req.params.id);if(!requestId)return fail(reply,'VALIDATION','Некорректный заказ');
  const order=await accessibleOrder(pool,req.user,requestId,reply);if(!order)return;
  const row=(await pool.query(`SELECT id,customer_id,source_request_id,created_at,expires_at,revoked_at,last_used_at,
    (revoked_at IS NULL AND expires_at>now()) active FROM customer_portal_links WHERE customer_id=$1 ORDER BY id DESC LIMIT 1`,[order.customer_id])).rows[0]||null;
  return{data:row};
 });

 app.post('/api/v1/customer-portal/links/:id/revoke',async(req,reply)=>{
  if(!await authenticated(req,reply,pool))return;
  const linkId=id(req.params.id);if(!linkId)return fail(reply,'VALIDATION','Некорректная ссылка');
  const link=(await pool.query('SELECT * FROM customer_portal_links WHERE id=$1',[linkId])).rows[0];if(!link)return fail(reply,'NOT_FOUND','Ссылка не найдена',404);
  const order=await accessibleOrder(pool,req.user,link.source_request_id,reply);if(!order)return;
  const row=(await pool.query('UPDATE customer_portal_links SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 RETURNING id,revoked_at',[linkId])).rows[0];
  await pool.query(`INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,'CUSTOMER_PORTAL_LINK_REVOKED',$3)`,[link.source_request_id,req.user.id,{portal_link_id:linkId}]);
  return{data:row};
 });

 app.get('/public/customer-portal/:token',async(req,reply)=>{
  const raw=String(req.params.token||'');if(!/^[a-f0-9]{64}$/i.test(raw))return fail(reply,'NOT_FOUND','Кабинет не найден',404);
  const link=(await pool.query(`SELECT l.*,c.name customer_name FROM customer_portal_links l JOIN customers c ON c.id=l.customer_id
    WHERE l.token_hash=$1`,[hashToken(raw)])).rows[0];
  if(!link)return fail(reply,'NOT_FOUND','Кабинет не найден',404);
  if(link.revoked_at)return fail(reply,'PORTAL_REVOKED','Ссылка на кабинет отозвана',410);
  if(new Date(link.expires_at)<=new Date())return fail(reply,'PORTAL_EXPIRED','Срок действия ссылки истёк',410);
  await pool.query('UPDATE customer_portal_links SET last_used_at=now() WHERE id=$1',[link.id]);
  const rows=(await pool.query(`SELECT r.id,r.number,r.status,r.complaint,r.diagnosis,r.total,r.paid,r.scheduled_at,r.created_at,r.closed_at,r.warranty_until,
    e.category,e.brand,e.model,e.serial_number
    FROM requests r LEFT JOIN equipment e ON e.id=r.equipment_id
    WHERE r.customer_id=$1 AND r.deleted_at IS NULL ORDER BY r.created_at DESC,r.id DESC`,[link.customer_id])).rows;
  const orders=[];for(const row of rows)orders.push(await publicOrder(pool,row));
  return{data:{customer:{name:link.customer_name},expires_at:link.expires_at,orders}};
 });
}
