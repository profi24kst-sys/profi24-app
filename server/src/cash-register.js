import {authenticate} from './access.js';
import {can,PERMISSIONS} from './rbac.js';
import {transaction,lockAccounts,money} from './finance/service.js';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import pg from 'pg';

const app=Fastify({logger:true});
await app.register(jwt,{secret:process.env.JWT_SECRET||'dev-secret-change-me'});
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:5});
const q=(s,p=[])=>pool.query(s,p);
const fail=(reply,code,message,status=422)=>reply.code(status).send({data:null,error:{code,message}});
const auth=async(req,reply)=>{if(!await authenticate(req,reply,pool))return;};
const permit=permission=>async(req,reply)=>{await auth(req,reply);if(reply.sent)return;if(!can(req.user.role,permission))return fail(reply,'FORBIDDEN','Недостаточно прав',403)};
const id=v=>{const n=Number(v);return Number.isSafeInteger(n)&&n>0?n:null};
const note=v=>String(v||'').trim().slice(0,1000);
const globalView=role=>['OWNER','ACCOUNTANT','SUPERVISOR'].includes(role);

app.setErrorHandler((e,req,reply)=>{
  const status=({P2400:422,P2401:409,P2403:403,P2409:409,23505:409,23503:409})[e.code]||e.statusCode||500;
  if(status>=500)req.log.error(e);
  return reply.code(status).send({data:null,error:{code:e.code||'INTERNAL_ERROR',message:status>=500?'Не удалось выполнить кассовую операцию':e.message}});
});

async function cashAccountAccess(user,accountId){
  const params=[user.role,user.id,accountId];
  const row=(await q(`SELECT a.*,b.name branch_name,u.name responsible_name FROM finance_account_balances a JOIN branches b ON b.id=a.branch_id LEFT JOIN users u ON u.id=a.responsible_id WHERE a.id=$3 AND a.type='CASH' AND ($1::text IN ('OWNER','ACCOUNTANT','SUPERVISOR') OR (a.responsible_id=$2 AND EXISTS(SELECT 1 FROM user_branches ub WHERE ub.user_id=$2 AND ub.branch_id=a.branch_id)))`,params)).rows[0];
  if(!row)throw Object.assign(new Error('Нет доступа к этой кассе'),{code:'FORBIDDEN',statusCode:403});
  return row;
}

app.get('/health',async()=>{await q('SELECT 1');return{ok:true,service:'cash-register',version:'1.0.0'}});

app.get('/api/v1/accounts',{preHandler:permit(PERMISSIONS.CASH_SHIFTS_VIEW)},async req=>{
  const rows=globalView(req.user.role)
    ?(await q(`SELECT a.*,b.code branch_code,b.name branch_name,u.name responsible_name,s.id open_shift_id,s.opened_at,s.opened_by,s.opening_variance FROM finance_account_balances a JOIN branches b ON b.id=a.branch_id LEFT JOIN users u ON u.id=a.responsible_id LEFT JOIN finance_cash_shifts s ON s.account_id=a.id AND s.status='OPEN' WHERE a.type='CASH' ORDER BY a.is_active DESC,b.name,a.name`)).rows
    :(await q(`SELECT a.*,b.code branch_code,b.name branch_name,u.name responsible_name,s.id open_shift_id,s.opened_at,s.opened_by,s.opening_variance FROM finance_account_balances a JOIN branches b ON b.id=a.branch_id LEFT JOIN users u ON u.id=a.responsible_id LEFT JOIN finance_cash_shifts s ON s.account_id=a.id AND s.status='OPEN' WHERE a.type='CASH' AND a.responsible_id=$1 AND EXISTS(SELECT 1 FROM user_branches ub WHERE ub.user_id=$1 AND ub.branch_id=a.branch_id) ORDER BY a.is_active DESC,b.name,a.name`,[req.user.id])).rows;
  return{data:rows};
});

app.get('/api/v1/shifts',{preHandler:permit(PERMISSIONS.CASH_SHIFTS_VIEW)},async req=>{
  const limit=Math.min(500,Math.max(1,Number(req.query?.limit)||100));
  const where=globalView(req.user.role)?'TRUE':`a.responsible_id=$2 AND EXISTS(SELECT 1 FROM user_branches ub WHERE ub.user_id=$2 AND ub.branch_id=a.branch_id)`;
  const rows=(await q(`SELECT s.*,a.name account_name,b.name branch_name,op.name opened_by_name,cl.name closed_by_name FROM finance_cash_shifts s JOIN finance_accounts a ON a.id=s.account_id JOIN branches b ON b.id=s.branch_id LEFT JOIN users op ON op.id=s.opened_by LEFT JOIN users cl ON cl.id=s.closed_by WHERE ${where} ORDER BY s.id DESC LIMIT $1`,[limit,req.user.id])).rows;
  return{data:rows};
});

app.post('/api/v1/accounts/:id/open',{preHandler:permit(PERMISSIONS.CASH_SHIFTS_OPERATE)},async(req,reply)=>{
  const accountId=id(req.params.id);if(!accountId)return fail(reply,'VALIDATION','Некорректная касса');
  const actual=money(req.body?.actual_opening_balance??0,{zero:true}),openingNote=note(req.body?.note);
  const row=await transaction(pool,req.user,async c=>{
    const [account]=await lockAccounts(c,[accountId],req.user);
    if(account.type!=='CASH')throw Object.assign(new Error('Выбранный счёт не является кассой'),{code:'VALIDATION',statusCode:422});
    const balance=(await c.query('SELECT balance FROM finance_account_balances WHERE id=$1',[accountId])).rows[0]?.balance??0;
    return (await c.query('INSERT INTO finance_cash_shifts(account_id,branch_id,opening_balance,actual_opening_balance,opened_by,opening_note) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[account.id,account.branch_id,balance,actual,req.user.id,openingNote])).rows[0];
  });
  return reply.code(201).send({data:row});
});

app.post('/api/v1/shifts/:id/close',{preHandler:permit(PERMISSIONS.CASH_SHIFTS_OPERATE)},async(req,reply)=>{
  const shiftId=id(req.params.id);if(!shiftId)return fail(reply,'VALIDATION','Некорректная смена');
  const actual=money(req.body?.actual_closing_balance??0,{zero:true}),closingNote=note(req.body?.note);
  const row=await transaction(pool,req.user,async c=>{
    const shift=(await c.query('SELECT * FROM finance_cash_shifts WHERE id=$1 FOR UPDATE',[shiftId])).rows[0];if(!shift)throw Object.assign(new Error('Кассовая смена не найдена'),{code:'NOT_FOUND',statusCode:404});
    if(shift.status!=='OPEN')throw Object.assign(new Error('Кассовая смена уже закрыта'),{code:'STATE_CONFLICT',statusCode:409});
    const [account]=await lockAccounts(c,[shift.account_id],req.user,{active:false});
    const expected=(await c.query('SELECT balance FROM finance_account_balances WHERE id=$1',[account.id])).rows[0]?.balance??0;
    const closed=(await c.query("UPDATE finance_cash_shifts SET status='CLOSED',expected_closing_balance=$1,actual_closing_balance=$2,closed_by=$3,closing_note=$4 WHERE id=$5 RETURNING *",[expected,actual,req.user.id,closingNote,shift.id])).rows[0];
    if(Math.abs(Number(closed.variance||0))>=0.01){
      const controller=(await c.query("SELECT id FROM users WHERE active=true AND role='SUPERVISOR' ORDER BY id LIMIT 1")).rows[0]||(await c.query("SELECT id FROM users WHERE active=true AND role='OWNER' ORDER BY id LIMIT 1")).rows[0];
      if(controller)await c.query(`INSERT INTO tasks(title,assigned_to,priority,status,due_at,created_by) VALUES($1,$2,'HIGH','OPEN',now()+interval '4 hours',$3)`,[`Сверить расхождение кассы «${account.name}»: ${closed.variance} ₸`,controller.id,req.user.id]);
    }
    return closed;
  });
  return{data:row};
});

app.get('/api/v1/shifts/:id/transactions',{preHandler:permit(PERMISSIONS.CASH_SHIFTS_VIEW)},async(req,reply)=>{
  const shiftId=id(req.params.id);if(!shiftId)return fail(reply,'VALIDATION','Некорректная смена');
  const shift=(await q('SELECT * FROM finance_cash_shifts WHERE id=$1',[shiftId])).rows[0];if(!shift)return fail(reply,'NOT_FOUND','Кассовая смена не найдена',404);
  await cashAccountAccess(req.user,shift.account_id);
  const rows=(await q(`SELECT f.*,r.number request_number,u.name created_by_name FROM finance_transactions f LEFT JOIN requests r ON r.id=f.request_id LEFT JOIN users u ON u.id=f.created_by WHERE f.cash_shift_id=$1 ORDER BY f.id`,[shiftId])).rows;
  const events=(await q('SELECT * FROM finance_cash_shift_events WHERE shift_id=$1 ORDER BY id',[shiftId])).rows;
  return{data:{shift,transactions:rows,events}};
});

const close=async()=>{try{await pool.end()}finally{process.exit(0)}};process.on('SIGTERM',close);process.on('SIGINT',close);
app.listen({port:Number(process.env.PORT||8107),host:'0.0.0.0'});
