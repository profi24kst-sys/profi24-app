import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import { financeRoutes } from './routes.js';
import { pnlRoute } from './pnl.js';

export async function buildFinanceApp(pool,{logger=true,secret=process.env.JWT_SECRET||'dev-secret-change-me'}={}) {
  const app=Fastify({logger});
  await app.register(cors,{origin:(process.env.CORS_ORIGIN||'http://localhost:5173').split(',').map(x=>x.trim()),credentials:true});
  await app.register(helmet,{contentSecurityPolicy:false});
  await app.register(rateLimit,{max:300,timeWindow:'1 minute'});
  await app.register(jwt,{secret});
  app.setErrorHandler((error,req,reply)=>{
    const sqlCodes={P2400:422,P2401:409,P2403:403,P2409:409};
    const status=sqlCodes[error.code]||error.statusCode;
    if(status&&status<500)return reply.code(status).send({data:null,error:{code:error.code||'VALIDATION',message:error.message}});
    if(['23505','23503','23514','22003','22P02'].includes(error.code))return reply.code(409).send({data:null,error:{code:'CONFLICT',message:'Операция уже существует или данные нарушают ограничения учёта'}});
    req.log.error(error);return reply.code(500).send({data:null,error:{code:'INTERNAL_ERROR',message:'Не удалось провести операцию. Данные не изменены.'}});
  });
  await financeRoutes(app,pool);
  await pnlRoute(app,pool);
  return app;
}
