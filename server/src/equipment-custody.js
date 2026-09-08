import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import pg from 'pg';
import {pathToFileURL} from 'node:url';
import {authenticate,requireOrder} from './access.js';
import {can,PERMISSIONS} from './rbac.js';

const fail=(reply,code,message,status=422,details)=>reply.code(status).send({data:null,error:{code,message,details}});
const text=(v,max=500)=>String(v||'').trim().slice(0,max);
const positiveId=v=>{const n=Number(v);return Number.isSafeInteger(n)&&n>0?n:null};
const officeRoles=new Set(['OWNER','SUPERVISOR','MANAGER']);
const readGlobalRoles=new Set(['OWNER','SUPERVISOR','ACCOUNTANT']);
const transitions={
 CUSTOMER_TO_OFFICE:{from:null,to:'OFFICE',office:true},
 OFFICE_TO_STORAGE:{from:'OFFICE',to:'STORAGE',office:true},
 STORAGE_TO_ENGINEER:{from:'STORAGE',to:'ENGINEER',office:true,engineerTarget:true},
 ENGINEER_TO_STORAGE:{from:'ENGINEER',to:'STORAGE',engineerReturn:true},
 STORAGE_TO_OFFICE:{from:'STORAGE',to:'OFFICE',office:true},
 STORAGE_TO_DELIVERY:{from:'STORAGE',to:'DELIVERY',office:true},
 DELIVERY_TO_CUSTOMER:{from:'DELIVERY',to:'CUSTOMER',office:true,closed:true},
 OFFICE_TO_CUSTOMER:{from:'OFFICE',to:'CUSTOMER',office:true,closed:true}
};

export function installEquipmentCustody(app,pool){
 const tx=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const out=await fn(c);await c.query('COMMIT');return out}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}};
 app.setErrorHandler((e,req,reply)=>{const status=({P2400:422,P2401:409,P2403:403,P2409:409,23505:409,23503:409,23514:422})[e.code]||e.statusCode||e.status||500;if(status>=500)req.log.error(e);return reply.code(status).send({data:null,error:{code:e.code||'INTERNAL_ERROR',message:status>=500?'Не удалось выполнить действие. Обновите страницу и повторите.':e.message}})});
 const auth=async(req,reply)=>{if(!await authenticate(req,reply,pool))return};
 async function sameBranchUser(c,userId,branchId,{engineer=false}={}){
  if(!userId)return null;const role=engineer?"AND u.role='ENGINEER'":'';
  return (await c.query(`SELECT u.id,u.name,u.role FROM users u JOIN user_branches ub ON ub.user_id=u.id WHERE u.id=$1 AND u.active=true AND ub.branch_id=$2 ${role} LIMIT 1`,[userId,branchId])).rows[0]||null;
 }
 async function latest(c,requestId,{lock=false}={}){
  return (await c.query(`SELECT e.*,fu.name from_user_name,tu.name to_user_name,cb.name created_by_name FROM equipment_custody_events e LEFT JOIN users fu ON fu.id=e.from_user_id LEFT JOIN users tu ON tu.id=e.to_user_id LEFT JOIN users cb ON cb.id=e.created_by WHERE e.request_id=$1 ORDER BY e.id DESC LIMIT 1${lock?' FOR UPDATE OF e':''}`,[requestId])).rows[0]||null;
 }
 async function history(c,requestId){return (await c.query(`SELECT e.*,fu.name from_user_name,tu.name to_user_name,cb.name created_by_name FROM equipment_custody_events e LEFT JOIN users fu ON fu.id=e.from_user_id LEFT JOIN users tu ON tu.id=e.to_user_id LEFT JOIN users cb ON cb.id=e.created_by WHERE e.request_id=$1 ORDER BY e.id DESC`,[requestId])).rows}
 const cleanAccessories=value=>Array.isArray(value)?value.map(v=>text(v,120)).filter(Boolean).slice(0,50):[];

 app.get('/health',async()=>{await pool.query('SELECT 1');return{ok:true,service:'profi24-equipment-custody',version:'1.0.0'}});
 app.get('/api/v1/requests/:id/custody',{preHandler:auth},async req=>{
  const order=await requireOrder(pool,req.user,req.params.id),events=await history(pool,order.id);return{data:{order_id:order.id,request_number:order.number,request_status:order.status,current:events[0]||null,events}};
 });
 app.get('/api/v1/custody',{preHandler:auth},async(req,reply)=>{
  if(!can(req.user.role,PERMISSIONS.ORDERS_VIEW_ALL)&&!can(req.user.role,PERMISSIONS.ORDERS_VIEW_ASSIGNED))return fail(reply,'FORBIDDEN','Недостаточно прав',403);
  const params=[];let where=`WHERE cur.holder<>'CUSTOMER'`;
  if(req.query?.holder){params.push(String(req.query.holder).toUpperCase());where+=` AND cur.holder=$${params.length}`}
  if(req.user.role==='MANAGER'){params.push(req.user.id);where+=` AND EXISTS(SELECT 1 FROM user_branches ub WHERE ub.user_id=$${params.length} AND ub.branch_id=r.branch_id)`}
  else if(req.user.role==='ENGINEER'){params.push(req.user.id);where+=` AND (cur.responsible_user_id=$${params.length} OR r.engineer_id=$${params.length})`}
  else if(req.user.role==='TRAINEE')return{data:[]};
  else if(!readGlobalRoles.has(req.user.role))return fail(reply,'FORBIDDEN','Недостаточно прав',403);
  const rows=(await pool.query(`SELECT cur.*,r.number request_number,r.status request_status,r.branch_id,c.name customer_name,e.category,e.brand,e.model,e.serial_number,u.name responsible_name,b.name branch_name FROM equipment_custody_current cur JOIN requests r ON r.id=cur.request_id JOIN customers c ON c.id=r.customer_id LEFT JOIN equipment e ON e.id=r.equipment_id LEFT JOIN users u ON u.id=cur.responsible_user_id LEFT JOIN branches b ON b.id=r.branch_id ${where} ORDER BY cur.created_at DESC LIMIT 500`,params)).rows;return{data:rows};
 });
 app.post('/api/v1/requests/:id/custody/events',{preHandler:auth},async(req,reply)=>{
  const eventType=String(req.body?.event_type||'').toUpperCase(),rule=transitions[eventType];if(!rule)return fail(reply,'VALIDATION','Некорректный тип передачи');
  const location=text(req.body?.location_text,220),condition=text(req.body?.condition_text,500),note=text(req.body?.note,500),accessories=cleanAccessories(req.body?.accessories),toUserId=positiveId(req.body?.to_user_id);
  if(rule.office&&!officeRoles.has(req.user.role))return fail(reply,'FORBIDDEN','Передачу выполняет сотрудник офиса',403);
  if(rule.engineerReturn&&req.user.role!=='ENGINEER'&&!officeRoles.has(req.user.role))return fail(reply,'FORBIDDEN','Вернуть технику может ответственный инженер или сотрудник офиса',403);
  try{const result=await tx(async c=>{
   const order=await requireOrder(c,req.user,req.params.id,{lock:true}),current=await latest(c,req.params.id,{lock:true});
   if(!current&&eventType!=='CUSTOMER_TO_OFFICE')throw Object.assign(new Error('Сначала оформите приём техники от клиента'),{code:'CUSTODY_INTAKE_REQUIRED',statusCode:409});
   if(current&&eventType==='CUSTOMER_TO_OFFICE')throw Object.assign(new Error('Техника уже принята в рамках этого заказа'),{code:'CUSTODY_ALREADY_STARTED',statusCode:409});
   if(rule.from&&current?.to_holder!==rule.from)throw Object.assign(new Error(`Неверная цепочка передачи: сейчас техника находится у ${current?.to_holder||'неизвестно'}`),{code:'CUSTODY_TRANSITION_INVALID',statusCode:409});
   if(current?.to_holder==='CUSTOMER')throw Object.assign(new Error('Техника уже выдана клиенту'),{code:'CUSTODY_FINISHED',statusCode:409});
   if(rule.closed&&order.status!=='CLOSED')throw Object.assign(new Error('Выдать технику клиенту можно только после закрытия заказа'),{code:'ORDER_NOT_CLOSED',statusCode:409});
   let effectiveToUser=null;
   if(rule.engineerTarget){effectiveToUser=toUserId||positiveId(order.engineer_id);if(!effectiveToUser)throw Object.assign(new Error('Укажите инженера-получателя'),{code:'ENGINEER_REQUIRED',statusCode:422});if(Number(order.engineer_id)!==Number(effectiveToUser))throw Object.assign(new Error('Передача допускается только основному инженеру заказа'),{code:'PRIMARY_ENGINEER_REQUIRED',statusCode:409});if(!await sameBranchUser(c,effectiveToUser,order.branch_id,{engineer:true}))throw Object.assign(new Error('Инженер не относится к филиалу заказа'),{code:'ENGINEER_BRANCH_MISMATCH',statusCode:422})}
   if(rule.engineerReturn){const holder=positiveId(current?.to_user_id);if(!holder)throw Object.assign(new Error('В журнале не указан ответственный инженер'),{code:'CUSTODY_ENGINEER_MISSING',statusCode:409});if(req.user.role==='ENGINEER'&&Number(req.user.id)!==Number(holder))throw Object.assign(new Error('Инженер может вернуть только технику, которая числится за ним'),{code:'NOT_CUSTODIAN',statusCode:403})}
   const fromUser=positiveId(current?.to_user_id),event=(await c.query(`INSERT INTO equipment_custody_events(request_id,event_type,from_holder,to_holder,from_user_id,to_user_id,location_text,condition_text,accessories,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11) RETURNING *`,[order.id,eventType,current?.to_holder||'CUSTOMER',rule.to,fromUser,effectiveToUser,location||null,condition||null,JSON.stringify(accessories),note||null,req.user.id])).rows[0];
   await c.query(`INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,'EQUIPMENT_CUSTODY_EVENT',$3)`,[order.id,req.user.id,{custody_event_id:event.id,event_type:eventType,from_holder:event.from_holder,to_holder:event.to_holder,from_user_id:fromUser,to_user_id:effectiveToUser,location_text:location||null,condition_text:condition||null,accessories}]);return event;
  });return reply.code(201).send({data:result})}catch(e){if(e?.statusCode)return fail(reply,e.code||'CUSTODY_ERROR',e.message,e.statusCode);throw e}
 });
 return app;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const app=Fastify({logger:true,bodyLimit:2*1024*1024});
 await app.register(cors,{origin:(process.env.CORS_ORIGIN||'http://localhost:5173').split(',').map(x=>x.trim()),credentials:true});await app.register(helmet,{contentSecurityPolicy:false});await app.register(jwt,{secret:process.env.JWT_SECRET||'dev-secret-change-me'});
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:Number(process.env.DB_POOL_MAX||8)});installEquipmentCustody(app,pool);await app.listen({port:Number(process.env.PORT||8110),host:'0.0.0.0'});
}
