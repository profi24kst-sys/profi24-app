import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import pg from 'pg';
import {closeOrder,OrderCloseError} from './order-close.js';

const app=Fastify({logger:true});
await app.register(jwt,{secret:process.env.JWT_SECRET||'dev-secret-change-me'});
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:Number(process.env.DB_POOL_MAX||10)});
const q=(s,p=[])=>pool.query(s,p);
const err=(reply,code,message,status=422)=>reply.code(status).send({data:null,error:{code,message}});
const owner=async(req,reply)=>{try{await req.jwtVerify()}catch{return err(reply,'UNAUTHORIZED','Требуется авторизация',401)}if(req.user.role!=='OWNER')return err(reply,'FORBIDDEN','Редактировать закрытые заказы может только руководитель',403)};
const get=async n=>(await q('SELECT * FROM requests WHERE number=$1',[n])).rows[0];
async function log(r,u,action,details){await q('INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,$3,$4)',[r.id,u,action,details||{}])}
app.get('/health',async()=>({ok:true,service:'owner-edit'}));
app.post('/api/v1/orders/:number/reopen',{preHandler:owner},async(req,reply)=>{const r=await get(req.params.number);if(!r)return err(reply,'NOT_FOUND','Заказ не найден',404);if(r.status!=='CLOSED')return err(reply,'NOT_CLOSED','Заказ уже открыт');const reason=String(req.body?.reason||'Корректировка закрытого заказа').slice(0,500);await q("UPDATE requests SET status='PAYMENT_REQUIRED',closed_at=NULL,updated_at=now() WHERE id=$1",[r.id]);await log(r,req.user.id,'OWNER_REOPENED_CLOSED_ORDER',{reason,previous_status:'CLOSED'});return {data:{number:r.number,status:'PAYMENT_REQUIRED',edit_mode:true}}});
app.post('/api/v1/orders/:number/close',{preHandler:owner},async(req,reply)=>{const r=await get(req.params.number);if(!r)return err(reply,'NOT_FOUND','Заказ не найден',404);const reason=String(req.body?.reason||'Корректировка завершена').slice(0,500),c=await pool.connect();try{await c.query('BEGIN');const result=await closeOrder(c,{requestId:r.id,userId:req.user.id});await c.query('INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,$3,$4)',[r.id,req.user.id,'OWNER_CORRECTION_COMPLETED',{reason,total:r.total,paid:r.paid}]);await c.query('COMMIT');return{data:{number:r.number,...result}}}catch(e){await c.query('ROLLBACK');if(e instanceof OrderCloseError)return err(reply,e.code,e.message,e.statusCode);throw e}finally{c.release()}});
const port=Number(process.env.PORT||8103);app.listen({port,host:'0.0.0.0'}).catch(e=>{app.log.error(e);process.exit(1)});
