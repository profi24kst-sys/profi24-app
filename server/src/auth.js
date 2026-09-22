import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import {isKnownRole} from './rbac.js';
import {runSchemaStatements} from './schema-retry.js';
import {accessTtlSeconds,buildRefreshCookie,createRefreshToken,hashRefreshToken,readRefreshToken,refreshTtlDays,secureCookieForRequest} from './auth-session.js';

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
const ACCESS_TTL_SECONDS=accessTtlSeconds();
const REFRESH_TTL_DAYS=refreshTtlDays();

await runSchemaStatements(pool,[
`CREATE TABLE IF NOT EXISTS auth_login_events(
  id BIGSERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  success BOOLEAN NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
'CREATE INDEX IF NOT EXISTS idx_auth_login_events_created ON auth_login_events(created_at DESC)',
'CREATE INDEX IF NOT EXISTS idx_auth_login_events_email ON auth_login_events(lower(email),created_at DESC)',
`CREATE TABLE IF NOT EXISTS auth_login_state(
  email TEXT PRIMARY KEY,
  failed_count INT NOT NULL DEFAULT 0,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  blocked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
'CREATE INDEX IF NOT EXISTS idx_auth_login_state_blocked ON auth_login_state(blocked_until)',
`CREATE TABLE IF NOT EXISTS auth_refresh_sessions(
  id BIGSERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  ip TEXT,
  user_agent TEXT
)`,
'CREATE INDEX IF NOT EXISTS idx_auth_refresh_sessions_user ON auth_refresh_sessions(user_id,expires_at DESC)',
'CREATE INDEX IF NOT EXISTS idx_auth_refresh_sessions_expiry ON auth_refresh_sessions(expires_at)'
],{logger:app.log});
await q("DELETE FROM auth_login_events WHERE created_at < now()-interval '180 days'");
await q("DELETE FROM auth_login_state WHERE updated_at < now()-interval '30 days' AND (blocked_until IS NULL OR blocked_until<now())");
await q("DELETE FROM auth_refresh_sessions WHERE expires_at < now()-interval '30 days' OR revoked_at < now()-interval '30 days'");

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
function publicUser(user){return{id:user.id,name:user.name,email:user.email,role:user.role};}
function issueAccessToken(user){return app.jwt.sign(publicUser(user),{expiresIn:ACCESS_TTL_SECONDS});}
function setSessionCookie(req,reply,token,maxAgeSeconds){
  reply.header('Set-Cookie',buildRefreshCookie(token,{secure:secureCookieForRequest(req),maxAgeSeconds}));
}
function clearSessionCookie(req,reply){
  reply.header('Set-Cookie',buildRefreshCookie('',{secure:secureCookieForRequest(req),clear:true}));
}
async function createRefreshSession(req,reply,user){
  const token=createRefreshToken();
  await q(`INSERT INTO auth_refresh_sessions(user_id,token_hash,expires_at,ip,user_agent)
    VALUES($1,$2,now()+($3::int*interval '1 day'),$4,$5)`,[
    user.id,hashRefreshToken(token),REFRESH_TTL_DAYS,requestIp(req),String(req.headers['user-agent']||'').slice(0,255)
  ]);
  setSessionCookie(req,reply,token,REFRESH_TTL_DAYS*86400);
}

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
  const accessToken=issueAccessToken(user);
  await createRefreshSession(req,reply,user);
  reply.header('Cache-Control','no-store');
  return{data:{access_token:accessToken,user:publicUser(user)}};
});

app.post('/api/v1/auth/refresh',{config:{rateLimit:{max:60,timeWindow:'1 minute'}}},async(req,reply)=>{
  const token=readRefreshToken(req.headers.cookie);
  if(!token){
    clearSessionCookie(req,reply);
    return fail(reply,'SESSION_EXPIRED','Сессия истекла. Войдите снова.',401);
  }
  const tokenHash=hashRefreshToken(token);
  const c=await pool.connect();
  let row;
  try{
    await c.query('BEGIN');
    row=(await c.query(`SELECT s.id AS session_id,s.user_id AS id,s.expires_at,s.revoked_at,u.name,u.email,u.role,u.active
      FROM auth_refresh_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$1 FOR UPDATE OF s`,[tokenHash])).rows[0];
    const expired=!row||row.revoked_at||new Date(row.expires_at).getTime()<=Date.now();
    const invalidUser=!row?.active||!isKnownRole(row?.role);
    if(expired||invalidUser){
      if(row&&!row.revoked_at)await c.query('UPDATE auth_refresh_sessions SET revoked_at=now() WHERE id=$1',[row.session_id]);
      await c.query('COMMIT');
      clearSessionCookie(req,reply);
      return fail(reply,'SESSION_EXPIRED','Сессия истекла. Войдите снова.',401);
    }
    await c.query('UPDATE auth_refresh_sessions SET last_used_at=now(),ip=$1,user_agent=$2 WHERE id=$3',[
      requestIp(req),String(req.headers['user-agent']||'').slice(0,255),row.session_id
    ]);
    await c.query('COMMIT');
  }catch(error){
    try{await c.query('ROLLBACK')}catch{}
    throw error;
  }finally{c.release();}
  const remaining=Math.max(1,Math.floor((new Date(row.expires_at).getTime()-Date.now())/1000));
  setSessionCookie(req,reply,token,remaining);
  reply.header('Cache-Control','no-store');
  return{data:{access_token:issueAccessToken(row),user:publicUser(row)}};
});

app.post('/api/v1/auth/logout',async(req,reply)=>{
  const token=readRefreshToken(req.headers.cookie);
  if(token)await q('UPDATE auth_refresh_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE token_hash=$1',[hashRefreshToken(token)]);
  clearSessionCookie(req,reply);
  reply.header('Cache-Control','no-store');
  return{data:{logged_out:true}};
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
