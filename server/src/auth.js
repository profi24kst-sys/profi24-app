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
const FAILURE_LIMIT=Math.max(3,Math.min(20,Number(process.env.AUTH_FAILURE_LIMIT||10)));
const FAILURE_WINDOW_MINUTES=Math.max(1,Math.min(60,Number(process.env.AUTH_FAILURE_WINDOW_MINUTES||10)));
const LOCK_MINUTES=Math.max(1,Math.min(120,Number(process.env.AUTH_LOCK_MINUTES||15)));
const dummyHash=await bcrypt.hash('invalid-password-placeholder-2026',10);

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
await q(`CREATE TABLE IF NOT EXISTS auth_login_state(
  email TEXT PRIMARY KEY,
  failed_count INT NOT NULL DEFAULT 0,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  blocked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`);
await q('CREATE INDEX IF NOT EXISTS idx_auth_login_state_blocked ON auth_login_state(blocked_until)');
await q("DELETE FROM auth_login_events WHERE created_at < now()-interval '180 days'");
await q("DELETE FROM auth_login_state WHERE updated_at < now()-interval '30 days' AND (blocked_until IS NULL OR blocked_until<now())");

function normalizedEmail(value){return String(value||'').trim().toLowerCase().slice(0,254);}
function requestIp(req){return String(req.ip||req.headers['x-real-ip']||'').slice(0,80);}
async function audit(req,email,userId,success){
  try{
    await q('INSERT INTO auth_login_events(user_id,email,success,ip,user_agent) VALUES($1,$2,$3,$4,$5)',[
      userId||null,email,Boolean(success),requestIp(req),String(req.headers['user-agent']||'').slice(0,255)
    ]);
  }catch(error){req.log.warn(error,'auth audit write failed');}
}
async function currentLock(email){
  const row=(await q('SELECT failed_count,window_started_at,blocked_until FROM auth_login_state WHERE email=$1',[email])).rows[0];
  if(!row?.blocked_until)return null;
  return new Date(row.blocked_until)>new Date()?row:null;
}
async function recordFailure(email){
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    let row=(await c.query('SELECT failed_count,window_started_at,blocked_until FROM auth_login_state WHERE email=$1 FOR UPDATE',[email])).rows[0];
    const now=new Date();
    const windowExpired=!row||new Date(row.window_started_at).getTime()<now.getTime()-FAILURE_WINDOW_MINUTES*60000;
    const failedCount=windowExpired?1:Number(row.failed_count||0)+1;
    const windowStarted=windowExpired?now:new Date(row.window_started_at);
    const blockedUntil=failedCount>=FAILURE_LIMIT?new Date(now.getTime()+LOCK_MINUTES*60000):null;
    row=(await c.query(`INSERT INTO auth_login_state(email,failed_count,window_started_at,blocked_until,updated_at)
      VALUES($1,$2,$3,$4,now())
      ON CONFLICT(email) DO UPDATE SET failed_count=EXCLUDED.failed_count,window_started_at=EXCLUDED.window_started_at,blocked_until=EXCLUDED.blocked_until,updated_at=now()
      RETURNING failed_count,window_started_at,blocked_until`,[email,failedCount,windowStarted,blockedUntil])).rows[0];
    await c.query('COMMIT');
    return row;
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
async function clearFailures(email){await q('DELETE FROM auth_login_state WHERE email=$1',[email]);}

app.get('/health',async()=>{await q('SELECT 1');return{ok:true,service:'profi24-auth'}});

app.post('/api/v1/auth/login',async(req,reply)=>{
  const email=normalizedEmail(req.body?.email);
  const password=String(req.body?.password||'');
  if(!email||!password){
    await audit(req,email||'(empty)',null,false);
    return fail(reply,'INVALID_CREDENTIALS','Неверный логин или пароль',401);
  }
  const lock=await currentLock(email);
  if(lock){
    await audit(req,email,null,false);
    return fail(reply,'AUTH_TEMPORARILY_LOCKED','Слишком много неверных попыток. Повторите вход позже.',429);
  }
  const user=(await q('SELECT id,name,email,password_hash,role,active FROM users WHERE lower(email)=lower($1) LIMIT 1',[email])).rows[0];
  const passwordOk=await bcrypt.compare(password,user?.password_hash||dummyHash);
  const valid=Boolean(user?.active&&isKnownRole(user?.role)&&passwordOk);
  await audit(req,email,user?.id,valid);
  if(!valid){
    const state=await recordFailure(email);
    if(state.blocked_until)return fail(reply,'AUTH_TEMPORARILY_LOCKED','Слишком много неверных попыток. Повторите вход позже.',429);
    return fail(reply,'INVALID_CREDENTIALS','Неверный логин или пароль',401);
  }
  await clearFailures(email);
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
