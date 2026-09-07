import {authenticate,installOrderAccess} from './access.js';
import {can,PERMISSIONS} from './rbac.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import pg from 'pg';

const app=Fastify({logger:true});
await app.register(cors,{origin:(process.env.CORS_ORIGIN||'http://localhost:5173').split(',').map(x=>x.trim()),credentials:true});
await app.register(helmet,{contentSecurityPolicy:false});
await app.register(jwt,{secret:process.env.JWT_SECRET||'dev-secret-change-me'});
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const q=(sql,params=[])=>pool.query(sql,params);
const fail=(reply,code,message,status=422)=>reply.code(status).send({data:null,error:{code,message}});
const auth=async(req,reply)=>{if(!await authenticate(req,reply,pool))return;};
for(const sql of [
  `CREATE TABLE IF NOT EXISTS request_stage_events(id BIGSERIAL PRIMARY KEY,request_id INT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,stage TEXT NOT NULL,event TEXT NOT NULL,user_id INT REFERENCES users(id),note TEXT,created_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_stage_events_request ON request_stage_events(request_id,created_at DESC)`
])await q(sql);

const P=PERMISSIONS;
const flow={
  NEW:{event:'ASSIGN',to:'ASSIGNED',permission:P.ORDERS_ASSIGN,label:'Назначить'},
  ASSIGNED:{event:'ACCEPT',to:'ACCEPTED',permission:P.ORDERS_TECHNICAL,label:'Принять заявку',primaryEngineer:true},
  ACCEPTED:{event:'DEPART',to:'ACCEPTED',permission:P.ORDERS_TECHNICAL,label:'Выехал',primaryEngineer:true},
  ON_ROUTE:{event:'ARRIVE',to:'DIAGNOSTICS',permission:P.ORDERS_TECHNICAL,label:'На месте',primaryEngineer:true},
  DIAGNOSTICS:{event:'SEND_APPROVAL',to:'APPROVAL_REQUIRED',permission:P.ORDERS_TECHNICAL,label:'Диагностика завершена'},
  APPROVAL_REQUIRED:{event:'START_REPAIR',to:'REPAIR',permission:P.ORDERS_TECHNICAL,label:'Начать ремонт'},
  WAITING_PART:{event:'START_REPAIR',to:'REPAIR',permission:P.ORDERS_TECHNICAL,label:'Деталь получена'},
  REPAIR:{event:'START_TEST',to:'TESTING',permission:P.ORDERS_TECHNICAL,label:'Завершить ремонт'},
  TESTING:{event:'REQUEST_PAYMENT',to:'PAYMENT_REQUIRED',permission:P.ORDERS_TECHNICAL,label:'Зафиксировать проверку'},
  PAYMENT_REQUIRED:{event:'CLOSE',to:'CLOSED',permission:P.ORDERS_CLOSE,label:'Проверить и закрыть'}
};
async function current(id){
  return (await q(`SELECT r.*,c.name customer_name,c.phone,eng.name engineer_name FROM requests r JOIN customers c ON c.id=r.customer_id LEFT JOIN users eng ON eng.id=r.engineer_id WHERE r.id=$1 AND r.deleted_at IS NULL`,[id])).rows[0];
}
function stage(request,events){
  if(request.status==='ACCEPTED'&&events.includes('DEPART')&&!events.includes('ARRIVE'))return 'ON_ROUTE';
  return request.status;
}
function allowed(user,request,next){
  if(!next||!can(user.role,next.permission))return false;
  if(next.primaryEngineer&&user.role==='ENGINEER'&&Number(request.engineer_id)!==Number(user.id))return false;
  return true;
}
installOrderAccess(app,pool,'workflow');
app.get('/health',async()=>{await q('SELECT 1');return{ok:true,service:'profi24-workflow',version:'1.3.0'};});
app.get('/api/v1/requests/:id/workflow',{preHandler:auth},async(req,reply)=>{
  const request=await current(req.params.id);
  if(!request)return fail(reply,'NOT_FOUND','Заявка не найдена',404);
  const events=(await q('SELECT e.*,u.name user_name FROM request_stage_events e LEFT JOIN users u ON u.id=e.user_id WHERE request_id=$1 ORDER BY created_at',[request.id])).rows;
  const hold=(await q('SELECT id,hold_type,reason,responsible_id,expected_until,started_at FROM request_holds WHERE request_id=$1 AND resumed_at IS NULL LIMIT 1',[request.id])).rows[0]||null;
  const status=stage(request,events.map(event=>event.event)),next=flow[status];
  return{data:{status,request_status:request.status,operational_state:hold?'HOLD':status,active_hold:hold,total:Number(request.total||0),paid:Number(request.paid||0),balance:Math.max(0,Number(request.total||0)-Number(request.paid||0)),next:!hold&&allowed(req.user,request,next)?{event:next.event,to:next.to,label:next.label}:null,events}};
});
app.post('/api/v1/requests/:id/workflow',{preHandler:auth},async(req,reply)=>{
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const request=(await c.query('SELECT * FROM requests WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[req.params.id])).rows[0];
    if(!request){await c.query('ROLLBACK');return fail(reply,'NOT_FOUND','Заявка не найдена',404);}
    const hold=(await c.query('SELECT id,hold_type,reason FROM request_holds WHERE request_id=$1 AND resumed_at IS NULL LIMIT 1',[request.id])).rows[0];
    if(hold){await c.query('ROLLBACK');return fail(reply,'ORDER_ON_HOLD',`Сначала завершите ожидание ${hold.hold_type}: ${hold.reason}`,409);}
    const events=(await c.query('SELECT event FROM request_stage_events WHERE request_id=$1',[request.id])).rows.map(value=>value.event);
    const state=stage(request,events),next=flow[state],event=req.body?.event;
    if(!next||event!==next.event){await c.query('ROLLBACK');return fail(reply,'INVALID_TRANSITION','Этот этап сейчас недоступен',409);}
    if(!allowed(req.user,request,next)){await c.query('ROLLBACK');return fail(reply,'FORBIDDEN',next.primaryEngineer&&req.user.role==='ENGINEER'?'Этап подтверждает основной ответственный инженер':'Недостаточно прав',403);}
    if(['START_TEST','REQUEST_PAYMENT','CLOSE'].includes(event)){await c.query('ROLLBACK');return fail(reply,'COMPLETION_PROCEDURE_REQUIRED','Продолжите через форму «Завершение ремонта»',409);}
    if(event==='ASSIGN'&&!request.engineer_id){await c.query('ROLLBACK');return fail(reply,'ENGINEER_REQUIRED','Сначала назначьте инженера');}
    if(event==='SEND_APPROVAL'&&!request.diagnosis){await c.query('ROLLBACK');return fail(reply,'DIAGNOSIS_REQUIRED','Сначала заполните диагностику');}
    if(event==='START_REPAIR'){
      const approval=(await c.query("SELECT status FROM customer_approvals WHERE request_id=$1 ORDER BY version DESC LIMIT 1",[request.id])).rows[0];
      if(!approval||approval.status!=='APPROVED'){await c.query('ROLLBACK');return fail(reply,'APPROVAL_REQUIRED','Клиент ещё не согласовал ремонт',409);}
    }
    const dbStatus=event==='DEPART'?'ACCEPTED':next.to;
    await c.query('UPDATE requests SET status=$1,updated_at=now() WHERE id=$2',[dbStatus,request.id]);
    await c.query('INSERT INTO request_stage_events(request_id,stage,event,user_id,note) VALUES($1,$2,$3,$4,$5)',[request.id,state,event,req.user.id,String(req.body?.note||'').slice(0,500)||null]);
    await c.query('INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,$3,$4)',[request.id,req.user.id,'WORKFLOW_'+event,{from:state,to:next.to}]);
    await c.query('COMMIT');
    return{data:{status:next.to,event}};
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
});
app.listen({port:Number(process.env.PORT||8090),host:'0.0.0.0'});
