import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import {isKnownRole} from './rbac.js';

const app=Fastify({logger:true,bodyLimit:64*1024,trustProxy:true});
await app.register(cors,{origin:(process.env.CORS_ORIGIN||'http://localhost:5173').split(',').map(x=>x.trim()),credentials:true});
await app.register(helmet,{contentSecurityPolicy:false});
await app.register(rateLimit,{max:Number(process.env.AUTH_RATE_LIMIT_PER_MINUTE||30),timeWindow:'1 minute'});
await app.register(jwt,{secret:process.env.JWT_SECRET||'dev-secret-change-me'});

const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:Math.max(2,Math.min(5,Number(process.env.DB_POOL_MAX||10)))});
const q=(sql,params=[])=>pool.query(sql,params);
const fail=(reply,code,message,status)=>reply.code(status).send({data:null,error:{code,message}});

await q(`CREATE TABLE IF NOT EXISTS auth_login_events(
  id BIGSERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  success BOOLEAN NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`);
await q('CREATE INDEX IF NOT EXISTS idx_auth_login_events_created ON auth_login_events(created_at DESC)');
await q('CREATE INDEX IF NOT EXISTS idx_auth_login_events_email ON auth_login_events(lower(email),created_at DESC)');
await q("DELETE FROM auth_login_events WHERE created_at < now()-interval '180 days'");

function normalizedEmail(value){return String(value||'').trim().toLowerCase().slice(0,254);}
function requestIp(req){return String(req.ip||req.headers['x-real-ip']||'').slice(0,80);}
async function audit(req,email,userId,success){
  try{
    await q('INSERT INTO auth_login_events(user_id,email,success,ip,user_agent) VALUES($1,$2,$3,$4,$5)',[
      userId||null,email,Boolean(success),requestIp(req),String(req.headers['user-agent']||'').slice(0,255)
    ]);
  }catch(error){req.log.warn(error,'auth audit write failed');}
}

app.get('/health',async()=>{await q('SELECT 1');return{ok:true,service:'profi24-auth'}});

app.post('/api/v1/auth/login',async(req,reply)=>{
  const email=normalizedEmail(req.body?.email);
  const password=String(req.body?.password||'');
  if(!email||!password){
    await audit(req,email||'(empty)',null,false);
    return fail(reply,'INVALID_CREDENTIALS','Неверный логин или пароль',401);
  }
  const user=(await q('SELECT id,name,email,password_hash,role,active FROM users WHERE lower(email)=lower($1) LIMIT 1',[email])).rows[0];
  const valid=Boolean(user?.active&&isKnownRole(user?.role)&&await bcrypt.compare(password,user.password_hash));
  await audit(req,email,user?.id,valid);
  if(!valid)return fail(reply,'INVALID_CREDENTIALS','Неверный логин или пароль',401);
  const accessToken=app.jwt.sign({id:user.id,role:user.role,name:user.name,email:user.email},{expiresIn:process.env.AUTH_TOKEN_TTL||'12h'});
  return{data:{access_token:accessToken,user:{id:user.id,name:user.name,email:user.email,role:user.role}}};
});

app.get('/api/v1/auth/security-events',async(req,reply)=>{
  try{await req.jwtVerify();}catch{return fail(reply,'UNAUTHORIZED','Требуется авторизация',401);}
  const actor=(await q('SELECT id,role,active FROM users WHERE id=$1',[req.user.id])).rows[0];
  if(!actor?.active||actor.role!=='OWNER')return fail(reply,'FORBIDDEN','Доступно только владельцу',403);
  const limit=Math.max(1,Math.min(500,Number(req.query?.limit||100)));
  const rows=(await q(`SELECT id,user_id,email,success,ip,user_agent,created_at FROM auth_login_events ORDER BY created_at DESC LIMIT $1`,[limit])).rows;
  return{data:rows};
});

app.listen({port:Number(process.env.PORT||8109),host:'0.0.0.0'});
