import {createHash} from 'node:crypto';
import {authenticate,accessError,requireOrder} from './access.js';
import {can,PERMISSIONS,roleAllowed} from './rbac.js';
import {validateOrderFields} from './order-form.js';

export const orderIntakeStatements=[
 `ALTER TABLE requests ADD COLUMN IF NOT EXISTS manager_comment TEXT`,
 `CREATE TABLE IF NOT EXISTS order_intake_operations(
   user_id INT NOT NULL REFERENCES users(id),operation_key UUID NOT NULL,payload_hash TEXT NOT NULL,
   request_id INT REFERENCES requests(id),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
   PRIMARY KEY(user_id,operation_key))`
];
const reject=(message,code='VALIDATION',status=422)=>{throw accessError(code,message,status)};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
function object(value,keys){if(!plain(value)||Object.keys(value).some(k=>!keys.includes(k)))reject('Проверьте поля приёма заказа');return value}
function text(value,max,required=false){if(value==null&&!required)return '';if(typeof value!=='string'||value.length>max||required&&!value.trim())reject('Проверьте текстовые поля приёма заказа');return value.trim()}
function id(value){if(!Number.isSafeInteger(value)||value<1)reject('Некорректный номер записи');return value}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(plain(value))return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value}
function payload(body){
 object(body,['customer_id','customer','equipment_id','equipment','order']);
 if(Boolean(body.customer_id)===Boolean(body.customer)||Boolean(body.equipment_id)===Boolean(body.equipment))reject('Выберите существующие записи или заполните новые');
 const customer=body.customer?object(body.customer,['name','phone','address']):null;
 const equipment=body.equipment?object(body.equipment,['category','brand','model','serial_number']):null;
 const order=object(body.order,['complaint','priority','source','scheduled_at','engineer_id','visit_type','manager_comment','order_type','custom_fields']);
 const order_type=order.order_type||'REPAIR',visit_type=order.visit_type||(order_type==='PAID_WORKSHOP'?'WORKSHOP':'FIELD');
 if(!['REPAIR','FIELD','PAID_WORKSHOP'].includes(order_type))reject('Для этого типа заказа пока не настроен рабочий процесс','ORDER_TYPE_NOT_READY');
 if(!['FIELD','WORKSHOP'].includes(visit_type)||order_type==='FIELD'&&visit_type!=='FIELD'||order_type==='PAID_WORKSHOP'&&visit_type!=='WORKSHOP')reject('Сценарий заказа не соответствует типу выезда или стационара','VISIT_TYPE_MISMATCH');
 const priority=order.priority||'NORMAL',source=order.source||'OTHER';
 if(!['NORMAL','HIGH','CRITICAL'].includes(priority)||!['GOOGLE_ADS','GOOGLE','2GIS','INSTAGRAM','TIKTOK','OLX','REFERRAL','REPEAT','B2B','OTHER','SITE'].includes(source))reject('Проверьте источник и приоритет заказа');
 const scheduled_at=order.scheduled_at||null;
 if(scheduled_at!==null&&(typeof scheduled_at!=='string'||scheduled_at.length>40||Number.isNaN(Date.parse(scheduled_at))))reject('Проверьте дату и время');
 const custom_fields=order.custom_fields??{};
 if(!plain(custom_fields)||Object.keys(custom_fields).length>60||JSON.stringify(custom_fields).length>32768)reject('Проверьте дополнительные поля');
 const result={customer_id:body.customer_id?id(body.customer_id):null,customer:customer?{name:text(customer.name,120,true),phone:text(customer.phone,40,true),address:text(customer.address,500)}:null,
  equipment_id:body.equipment_id?id(body.equipment_id):null,equipment:equipment?{category:text(equipment.category,120,true),brand:text(equipment.brand,120),model:text(equipment.model,160),serial_number:text(equipment.serial_number,160)}:null,
  order:{complaint:text(order.complaint,5000,true),priority,source,scheduled_at,engineer_id:order.engineer_id?id(order.engineer_id):null,visit_type,manager_comment:text(order.manager_comment,5000),order_type,custom_fields}};
 if(result.customer&&(result.customer.name.length<2||!/^\d{10,15}$/.test(result.customer.phone.replace(/\D/g,''))))reject('Укажите имя и корректный телефон клиента');
 if(result.order.complaint.length<3)reject('Опишите неисправность минимум тремя символами');
 return result;
}
const summary=r=>({id:r.id,number:r.number,customer_id:r.customer_id,equipment_id:r.equipment_id});
export function registerOrderIntakeRoutes(app,pool){
 app.post('/api/v1/requests/intake',{bodyLimit:131072,preHandler:async(req,reply)=>{
  if(!await authenticate(req,reply,pool))return;
  if(!roleAllowed(req.user.role,['OWNER','MANAGER'])||!can(req.user,PERMISSIONS.ORDERS_CREATE)||!can(req.user,PERMISSIONS.ORDERS_VIEW_ALL))return reply.code(403).send({data:null,error:{code:'FORBIDDEN',message:'Недостаточно прав для приёма заказа'}});
 }},async(req,reply)=>{
  let c,claimedOperation=false,rolledBack=false;
  try{
   const key=req.headers['x-idempotency-key'];
   if(typeof key!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key))reject('Передайте ключ операции приёма заказа','IDEMPOTENCY_REQUIRED');
   const hash=createHash('sha256').update(JSON.stringify(canonical(req.body??{}))).digest('hex');
   c=await pool.connect();await c.query('BEGIN');
   // The unique claim blocks concurrent retries until the entire first transaction commits.
   const claimed=(await c.query('INSERT INTO order_intake_operations(user_id,operation_key,payload_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING user_id',[req.user.id,key,hash])).rows[0];
   claimedOperation=Boolean(claimed);
   if(!claimed){
    const old=(await c.query('SELECT payload_hash,request_id FROM order_intake_operations WHERE user_id=$1 AND operation_key=$2 FOR UPDATE',[req.user.id,key])).rows[0];
    if(!old||old.payload_hash!==hash)reject('Ключ операции уже использован с другими данными','IDEMPOTENCY_CONFLICT',409);
    const order=await requireOrder(c,req.user,old.request_id);
    await c.query('COMMIT');return reply.code(200).send({data:{...summary(order),replayed:true}});
   }
   const data=payload(req.body);
   const branch=(await c.query('SELECT b.id FROM branches b JOIN users u ON u.primary_branch_id=b.id JOIN user_branches ub ON ub.user_id=u.id AND ub.branch_id=b.id WHERE u.id=$1 AND u.active=true AND b.active=true',[req.user.id])).rows[0];
   if(!branch)reject('Нет активного основного филиала','FORBIDDEN',403);
   const fields=await validateOrderFields(c,data.order.order_type,data.order.custom_fields);
   if(data.order.engineer_id){
    if(!can(req.user,PERMISSIONS.ORDERS_ASSIGN))reject('Нет прав на назначение инженера','FORBIDDEN',403);
    if(!(await c.query("SELECT u.id FROM users u JOIN user_branches ub ON ub.user_id=u.id WHERE u.id=$1 AND u.active=true AND u.role='ENGINEER' AND ub.branch_id=$2",[data.order.engineer_id,branch.id])).rows[0])reject('Выберите активного инженера своего филиала','INVALID_ENGINEER');
   }
   let customerId=data.customer_id;
   if(customerId){
    const customer=(await c.query(`SELECT c.id FROM customers c WHERE c.id=$1 AND c.deleted_at IS NULL AND ($2::text<>'MANAGER' OR EXISTS(SELECT 1 FROM requests r JOIN user_branches ub ON ub.branch_id=r.branch_id AND ub.user_id=$3 WHERE r.customer_id=c.id AND r.deleted_at IS NULL)) FOR SHARE`,[customerId,req.user.role,req.user.id])).rows[0];
    if(!customer)reject('Клиент не найден или недоступен','NOT_FOUND',404);
   }else{
    const pn=data.customer.phone.replace(/\D/g,'').replace(/^8(?=7\d{9}$)/,'7');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['order-intake-phone:'+pn]);
    if((await c.query('SELECT id FROM customers WHERE phone_norm=$1 AND deleted_at IS NULL LIMIT 1',[pn])).rows[0])reject('Клиент с таким телефоном уже существует. Найдите его в поиске клиентов.','POSSIBLE_DUPLICATE_CUSTOMER',409);
    customerId=(await c.query('INSERT INTO customers(name,phone,phone_norm,address) VALUES($1,$2,$3,$4) RETURNING id',[data.customer.name,data.customer.phone,pn,data.customer.address||null])).rows[0].id;
   }
   let equipmentId=data.equipment_id;
   if(equipmentId){
    const equipment=(await c.query(`SELECT e.id FROM equipment e WHERE e.id=$1 AND e.customer_id=$2 AND e.deleted_at IS NULL AND ($3::text<>'MANAGER' OR EXISTS(SELECT 1 FROM requests r JOIN user_branches ub ON ub.branch_id=r.branch_id AND ub.user_id=$4 WHERE r.equipment_id=e.id AND r.deleted_at IS NULL)) FOR SHARE`,[equipmentId,customerId,req.user.role,req.user.id])).rows[0];
    if(!equipment)reject('Техника клиента не найдена или недоступна','NOT_FOUND',404);
   }else{
    const e=data.equipment;equipmentId=(await c.query('INSERT INTO equipment(customer_id,category,brand,model,serial_number) VALUES($1,$2,$3,$4,$5) RETURNING id',[customerId,e.category,e.brand||null,e.model||null,e.serial_number||null])).rows[0].id;
   }
   const seq=(await c.query("SELECT nextval('request_number_seq') n")).rows[0].n,order=data.order;
   const created=(await c.query(`INSERT INTO requests(number,customer_id,equipment_id,manager_id,engineer_id,branch_id,status,priority,source,complaint,scheduled_at,sla_deadline,visit_type,manager_comment,order_type,custom_fields) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,[
    `KST-${new Date().getFullYear()}-${String(seq).padStart(7,'0')}`,customerId,equipmentId,req.user.id,order.engineer_id,branch.id,order.engineer_id?'ASSIGNED':'NEW',order.priority,order.source,order.complaint,order.scheduled_at,new Date(Date.now()+(order.priority==='CRITICAL'?15:60)*60000),order.visit_type,order.manager_comment||null,fields.order_type,fields.custom_fields])).rows[0];
   await c.query('INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,$3,$4)',[created.id,req.user.id,'REQUEST_CREATED',{source:order.source,priority:order.priority,visit_type:order.visit_type,order_type:order.order_type}]);
   if(order.engineer_id)await c.query('INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,$3,$4)',[created.id,req.user.id,'REQUEST_ASSIGNED',{engineer_id:order.engineer_id,scheduled_at:order.scheduled_at}]);
   await c.query('UPDATE order_intake_operations SET request_id=$1 WHERE user_id=$2 AND operation_key=$3',[created.id,req.user.id,key]);
   await c.query('COMMIT');return reply.code(201).send({data:{...summary(created),replayed:false}});
  }catch(error){
   if(c)try{await c.query('ROLLBACK');rolledBack=true}catch{}
   const status=error.statusCode||({23503:409,23514:422,P2403:403})[error.code]||500;
   if(status>=500)req.log.error({err:error},'order intake failed');
   return reply.code(status).send({data:null,error:{code:status>=500?'INTAKE_FAILED':error.code||'VALIDATION',message:status>=500?'Не удалось подтвердить сохранение. Повторите операцию с тем же ключом.':error.message,details:error.details,safe_to_edit:status<500&&claimedOperation&&rolledBack}});
  }finally{c?.release()}
 });
}
