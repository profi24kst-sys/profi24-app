import {fingerprint,operationKey} from './service.js';
import {receivePayment,refundPayment} from '../order-financial-actions.js';

const deny=(reply,message)=>reply.code(403).send({data:null,error:{code:'FORBIDDEN',message}});
const tx=async(pool,fn)=>{const c=await pool.connect();try{await c.query('BEGIN');const out=await fn(c);await c.query('COMMIT');return out}catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}};

// Compatibility aliases for earlier clients/tests. They intentionally use the same domain
// functions and DB guards as the current core API, so this is not a bypass around RBAC/audit.
export function installFinanceOrderCompatibility(app,pool){
  app.post('/api/v1/requests/:id/payment',async(req,reply)=>{
    if(!['OWNER','MANAGER','ACCOUNTANT'].includes(req.user?.role))return deny(reply,'Эта роль не принимает оплату клиента');
    const body=req.body||{},key=operationKey(req),digest=fingerprint({request:req.params.id,...body});
    const data=await tx(pool,c=>receivePayment(c,{requestId:req.params.id,user:req.user,body,key,digest}));
    return reply.code(201).send({data});
  });

  app.post('/api/v1/requests/:id/refund',async(req,reply)=>{
    if(!['OWNER','ACCOUNTANT'].includes(req.user?.role))return deny(reply,'Возврат оплаты доступен собственнику или бухгалтеру');
    const body=req.body||{},paymentId=body.payment_id,key=operationKey(req),clean={...body};delete clean.payment_id;
    const digest=fingerprint({payment:paymentId,...clean});
    const data=await tx(pool,c=>refundPayment(c,{paymentId,user:req.user,body:clean,key,digest,expectedRequestId:req.params.id}));
    return reply.code(201).send({data});
  });
}
