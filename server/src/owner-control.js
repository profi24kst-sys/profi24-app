import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import pg from 'pg';

const app=Fastify({logger:true});
await app.register(jwt,{secret:process.env.JWT_SECRET||'dev-secret-change-me'});
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:5});
const q=(s,p=[])=>pool.query(s,p);
const fail=(r,code,message,status=422)=>r.code(status).send({data:null,error:{code,message}});
const owner=async(req,reply)=>{try{await req.jwtVerify()}catch{return fail(reply,'UNAUTHORIZED','Требуется авторизация',401)}if(req.user.role!=='OWNER')return fail(reply,'FORBIDDEN','Редактирование закрытых заказов доступно только руководителю',403)};

app.get('/health',async()=>{await q('SELECT 1');return{ok:true,service:'owner-control',version:'1.0.0'}});

app.post('/api/v1/orders/:number/reopen',{preHandler:owner},async(req,reply)=>{
  const number=String(req.params.number||'').trim();
  const reason=String(req.body?.reason||'Корректировка закрытого заказа').trim();
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const current=(await client.query('SELECT id,number,status,total,paid,closed_at FROM requests WHERE number=$1 FOR UPDATE',[number])).rows[0];
    if(!current){await client.query('ROLLBACK');return fail(reply,'NOT_FOUND','Заказ не найден',404)}
    if(current.status!=='CLOSED'){await client.query('ROLLBACK');return fail(reply,'NOT_CLOSED','Заказ уже открыт для работы',409)}
    const row=(await client.query("UPDATE requests SET status='PAYMENT_REQUIRED',closed_at=NULL,updated_at=now() WHERE id=$1 RETURNING id,number,status,total,paid,closed_at",[current.id])).rows[0];
    await client.query("INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,'OWNER_REOPENED_CLOSED_ORDER',$3)",[current.id,req.user.id,{reason,previous_status:'CLOSED',previous_closed_at:current.closed_at,previous_total:current.total,previous_paid:current.paid}]);
    await client.query('COMMIT');
    return{data:{...row,message:'Заказ открыт для редактирования'}};
  }catch(e){await client.query('ROLLBACK');req.log.error(e);return fail(reply,'REOPEN_FAILED','Не удалось открыть заказ для редактирования',500)}finally{client.release()}
});

app.post('/api/v1/orders/:number/close',{preHandler:owner},async(req,reply)=>{
  const number=String(req.params.number||'').trim();
  const reason=String(req.body?.reason||'Корректировка завершена').trim();
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const current=(await client.query('SELECT id,number,status,total,paid FROM requests WHERE number=$1 FOR UPDATE',[number])).rows[0];
    if(!current){await client.query('ROLLBACK');return fail(reply,'NOT_FOUND','Заказ не найден',404)}
    if(current.status==='CLOSED'){await client.query('ROLLBACK');return fail(reply,'ALREADY_CLOSED','Заказ уже закрыт',409)}
    if(Number(current.paid||0)+0.001<Number(current.total||0)){await client.query('ROLLBACK');return fail(reply,'PAYMENT_REQUIRED',`Нельзя закрыть заказ: оплачено ${current.paid||0}, итог ${current.total||0}`,409)}
    const row=(await client.query("UPDATE requests SET status='CLOSED',closed_at=now(),updated_at=now() WHERE id=$1 RETURNING id,number,status,total,paid,closed_at",[current.id])).rows[0];
    await client.query("INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,'OWNER_RECLOSED_ORDER',$3)",[current.id,req.user.id,{reason,total:current.total,paid:current.paid}]);
    await client.query('COMMIT');
    return{data:{...row,message:'Корректировка завершена, заказ закрыт'}};
  }catch(e){await client.query('ROLLBACK');req.log.error(e);return fail(reply,'CLOSE_FAILED','Не удалось закрыть заказ',500)}finally{client.release()}
});

app.listen({port:Number(process.env.PORT||8103),host:'0.0.0.0'});
