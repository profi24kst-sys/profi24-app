import {authenticate} from './access.js';
import {can,PERMISSIONS} from './rbac.js';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import pg from 'pg';

const app=Fastify({logger:true});
await app.register(jwt,{secret:process.env.JWT_SECRET||'dev-secret-change-me'});
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:5});
const q=(s,p=[])=>pool.query(s,p);
const fail=(reply,code,message,status=422)=>reply.code(status).send({data:null,error:{code,message}});
const tx=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const out=await fn(c);await c.query('COMMIT');return out}catch(e){try{await c.query('ROLLBACK')}catch{}throw e}finally{c.release()}};
const auth=async(req,reply)=>{if(!await authenticate(req,reply,pool))return;};
const permit=permission=>async(req,reply)=>{await auth(req,reply);if(reply.sent)return;if(!can(req.user.role,permission))return fail(reply,'FORBIDDEN','Недостаточно прав',403)};
const branchId=v=>{const n=Number(v);return Number.isSafeInteger(n)&&n>0?n:null};
const cleanCode=v=>String(v||'').trim().toUpperCase();
const cleanText=(v,max=300)=>String(v||'').trim().slice(0,max);
const cleanTimezone=v=>cleanText(v||'Asia/Qostanay',80);
const validTimezone=v=>/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+$/.test(v);
const audit=(c,{branch_id=null,user_id=null,actor_id,action,details={}})=>c.query('INSERT INTO branch_audit_log(branch_id,user_id,actor_id,action,details) VALUES($1,$2,$3,$4,$5)',[branch_id,user_id,actor_id,action,details]);

app.setErrorHandler((e,req,reply)=>{
  const status=({P2400:422,P2401:409,P2403:403,23505:409,23503:409})[e.code]||e.statusCode||500;
  if(status>=500)req.log.error(e);
  return reply.code(status).send({data:null,error:{code:e.code||'INTERNAL_ERROR',message:status>=500?'Не удалось выполнить действие':e.message}});
});

app.get('/health',async()=>{await q('SELECT 1');return{ok:true,service:'branch-admin',version:'1.0.0'}});

app.get('/api/v1/branches',{preHandler:permit(PERMISSIONS.BRANCHES_VIEW)},async req=>{
  const global=can(req.user.role,PERMISSIONS.BRANCHES_MANAGE)||req.user.role==='ACCOUNTANT';
  const rows=global
    ?(await q(`SELECT b.*,(SELECT count(*) FROM user_branches ub JOIN users u ON u.id=ub.user_id WHERE ub.branch_id=b.id AND u.active=true)::int active_users,(SELECT count(*) FROM requests r WHERE r.branch_id=b.id AND r.deleted_at IS NULL AND r.status NOT IN ('CLOSED','CANCELLED'))::int active_orders FROM branches b ORDER BY b.active DESC,b.name`)).rows
    :(await q(`SELECT b.*,(SELECT count(*) FROM user_branches x JOIN users u ON u.id=x.user_id WHERE x.branch_id=b.id AND u.active=true)::int active_users,(SELECT count(*) FROM requests r WHERE r.branch_id=b.id AND r.deleted_at IS NULL AND r.status NOT IN ('CLOSED','CANCELLED'))::int active_orders FROM branches b JOIN user_branches ub ON ub.branch_id=b.id WHERE ub.user_id=$1 AND b.active=true ORDER BY ub.is_primary DESC,b.name`,[req.user.id])).rows;
  return{data:rows};
});

app.post('/api/v1/branches',{preHandler:permit(PERMISSIONS.BRANCHES_MANAGE)},async(req,reply)=>{
  const code=cleanCode(req.body?.code),name=cleanText(req.body?.name,120),address=cleanText(req.body?.address,300)||null,timezone=cleanTimezone(req.body?.timezone);
  if(!/^[A-Z0-9_-]{2,12}$/.test(code))return fail(reply,'VALIDATION','Код филиала: 2–12 символов A-Z, 0-9, _ или -');
  if(name.length<2)return fail(reply,'VALIDATION','Укажите название филиала');
  if(!validTimezone(timezone))return fail(reply,'VALIDATION','Некорректный часовой пояс');
  const row=await tx(async c=>{const b=(await c.query('INSERT INTO branches(code,name,address,timezone,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',[code,name,address,timezone,req.user.id])).rows[0];await audit(c,{branch_id:b.id,actor_id:req.user.id,action:'BRANCH_CREATED',details:{code,name,address,timezone}});return b});
  return reply.code(201).send({data:row});
});

app.patch('/api/v1/branches/:id',{preHandler:permit(PERMISSIONS.BRANCHES_MANAGE)},async(req,reply)=>{
  const id=branchId(req.params.id);if(!id)return fail(reply,'VALIDATION','Некорректный филиал');
  const row=await tx(async c=>{
    const old=(await c.query('SELECT * FROM branches WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!old)throw Object.assign(new Error('Филиал не найден'),{code:'NOT_FOUND',statusCode:404});
    const name=req.body?.name===undefined?old.name:cleanText(req.body.name,120),address=req.body?.address===undefined?old.address:(cleanText(req.body.address,300)||null),timezone=req.body?.timezone===undefined?old.timezone:cleanTimezone(req.body.timezone),active=req.body?.active===undefined?old.active:Boolean(req.body.active);
    if(name.length<2)throw Object.assign(new Error('Укажите название филиала'),{code:'VALIDATION',statusCode:422});
    if(!validTimezone(timezone))throw Object.assign(new Error('Некорректный часовой пояс'),{code:'VALIDATION',statusCode:422});
    if(old.active&&!active){
      const activeOrders=Number((await c.query("SELECT count(*) c FROM requests WHERE branch_id=$1 AND deleted_at IS NULL AND status NOT IN ('CLOSED','CANCELLED')",[id])).rows[0].c);
      if(activeOrders>0)throw Object.assign(new Error(`В филиале ${activeOrders} активных заказов`),{code:'BRANCH_IN_USE',statusCode:409});
      const activeUsers=Number((await c.query('SELECT count(*) c FROM users WHERE primary_branch_id=$1 AND active=true',[id])).rows[0].c);
      if(activeUsers>0)throw Object.assign(new Error(`Филиал основной для ${activeUsers} активных сотрудников`),{code:'BRANCH_IN_USE',statusCode:409});
    }
    const updated=(await c.query('UPDATE branches SET name=$1,address=$2,timezone=$3,active=$4,updated_at=now() WHERE id=$5 RETURNING *',[name,address,timezone,active,id])).rows[0];
    await audit(c,{branch_id:id,actor_id:req.user.id,action:'BRANCH_UPDATED',details:{before:{name:old.name,address:old.address,timezone:old.timezone,active:old.active},after:{name,address,timezone,active}}});
    return updated;
  });
  return{data:row};
});

app.get('/api/v1/users/:id/branches',{preHandler:auth},async(req,reply)=>{
  const target=branchId(req.params.id);if(!target)return fail(reply,'VALIDATION','Некорректный сотрудник');
  if(Number(req.user.id)!==target&&!can(req.user.role,PERMISSIONS.BRANCHES_MANAGE)&&!can(req.user.role,PERMISSIONS.STAFF_MANAGE))return fail(reply,'FORBIDDEN','Недостаточно прав',403);
  const user=(await q('SELECT id,name,role,active,primary_branch_id FROM users WHERE id=$1',[target])).rows[0];if(!user)return fail(reply,'NOT_FOUND','Сотрудник не найден',404);
  const rows=(await q(`SELECT b.id,b.code,b.name,b.address,b.timezone,b.active,ub.is_primary,ub.created_at FROM user_branches ub JOIN branches b ON b.id=ub.branch_id WHERE ub.user_id=$1 ORDER BY ub.is_primary DESC,b.name`,[target])).rows;
  return{data:{user,branches:rows}};
});

app.put('/api/v1/users/:id/branches',{preHandler:permit(PERMISSIONS.BRANCHES_MANAGE)},async(req,reply)=>{
  const target=branchId(req.params.id);if(!target)return fail(reply,'VALIDATION','Некорректный сотрудник');
  const ids=[...new Set((Array.isArray(req.body?.branch_ids)?req.body.branch_ids:[]).map(branchId).filter(Boolean))],primary=branchId(req.body?.primary_branch_id);
  if(!ids.length||ids.length>50||!primary||!ids.includes(primary))return fail(reply,'VALIDATION','Укажите доступные филиалы и один основной филиал из этого списка');
  const result=await tx(async c=>{
    const user=(await c.query('SELECT id,name,role,active,primary_branch_id FROM users WHERE id=$1 FOR UPDATE',[target])).rows[0];if(!user)throw Object.assign(new Error('Сотрудник не найден'),{code:'NOT_FOUND',statusCode:404});
    const branches=(await c.query('SELECT id,code,name,active FROM branches WHERE id=ANY($1::int[]) ORDER BY id',[ids])).rows;
    if(branches.length!==ids.length||branches.some(x=>!x.active))throw Object.assign(new Error('Один из филиалов не найден или отключён'),{code:'VALIDATION',statusCode:422});
    const before=(await c.query('SELECT branch_id,is_primary FROM user_branches WHERE user_id=$1 ORDER BY branch_id',[target])).rows;
    await c.query('DELETE FROM user_branches WHERE user_id=$1',[target]);
    await c.query('UPDATE users SET primary_branch_id=$1 WHERE id=$2',[primary,target]);
    for(const id of ids){if(id===primary)continue;await c.query('INSERT INTO user_branches(user_id,branch_id,is_primary,assigned_by) VALUES($1,$2,false,$3) ON CONFLICT(user_id,branch_id) DO UPDATE SET is_primary=false,assigned_by=$3',[target,id,req.user.id]);}
    await c.query('UPDATE user_branches SET assigned_by=$1 WHERE user_id=$2',[req.user.id,target]);
    const after=(await c.query('SELECT branch_id,is_primary FROM user_branches WHERE user_id=$1 ORDER BY branch_id',[target])).rows;
    await audit(c,{branch_id:primary,user_id:target,actor_id:req.user.id,action:'USER_BRANCHES_CHANGED',details:{before,after,primary_branch_id:primary}});
    return{user_id:target,primary_branch_id:primary,branches:after};
  });
  return{data:result};
});

app.get('/api/v1/audit',{preHandler:permit(PERMISSIONS.BRANCHES_MANAGE)},async req=>{
  const limit=Math.min(500,Math.max(1,Number(req.query?.limit)||100));
  const rows=(await q(`SELECT a.*,b.name branch_name,u.name user_name,actor.name actor_name FROM branch_audit_log a LEFT JOIN branches b ON b.id=a.branch_id LEFT JOIN users u ON u.id=a.user_id LEFT JOIN users actor ON actor.id=a.actor_id ORDER BY a.id DESC LIMIT $1`,[limit])).rows;
  return{data:rows};
});

const close=async()=>{try{await pool.end()}finally{process.exit(0)}};process.on('SIGTERM',close);process.on('SIGINT',close);
app.listen({port:Number(process.env.PORT||8106),host:'0.0.0.0'});
