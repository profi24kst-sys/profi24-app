import { createHash, randomUUID } from 'node:crypto';

export class FinanceError extends Error {
  constructor(message, code='VALIDATION', statusCode=422) { super(message); Object.assign(this,{code,statusCode}); }
}
export const reject = (message,code,status) => { throw new FinanceError(message,code,status); };
export function money(value, {signed=false,zero=false}={}) {
  const text=String(value??'').trim();
  if (!/^-?\d{1,12}(\.\d{1,2})?$/.test(text)) reject('Укажите сумму с точностью до 0,01 ₸');
  const negative=text.startsWith('-'), [whole,fraction='']=text.replace('-','').split('.');
  const cents=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  if ((!signed&&negative)||(!zero&&cents===0n)||cents>=100000000000000n) reject('Некорректная сумма');
  return `${negative&&cents>0n?'-':''}${cents/100n}.${String(cents%100n).padStart(2,'0')}`;
}
export function text(value,label,max=1000) {
  if(typeof value!=='string'||!value.trim()||value.trim().length>max) reject(`Заполните поле «${label}» (до ${max} символов)`);
  return value.trim();
}
export function id(value,label='Счёт') {
  if(!/^\d+$/.test(String(value??''))||!Number.isSafeInteger(Number(value))||Number(value)<1||Number(value)>2147483647) reject(`Выберите: ${label}`);
  return Number(value);
}
export const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Almaty',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export function date(value=today()) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value||value>today()) reject('Укажите существующую дату не позднее сегодняшней');
  return value;
}
export function monthRange(value=today().slice(0,7)) {
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) reject('Некорректный месяц');
  const start=value+'-01', end=new Date(start+'T00:00:00Z');end.setUTCMonth(end.getUTCMonth()+1);
  return [start,end.toISOString().slice(0,10)];
}
const canonical = value => Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
export const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function operationKey(req) {
  const value=req.headers['idempotency-key'];
  if(typeof value!=='string'||!/^[-\w:]{16,160}$/.test(value)) reject('Обновите форму: отсутствует уникальный номер операции','IDEMPOTENCY_REQUIRED');
  return `${req.user.id}:${value}`;
}
export async function transaction(pool,user,fn) {
  const c=await pool.connect();
  try { await c.query('BEGIN');await c.query("SELECT set_config('app.finance_actor',$1,true)",[String(user.id)]);const result=await fn(c);await c.query('COMMIT');return result; }
  catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
export async function lockAccounts(c,ids,user,{active=true}={}) {
  const unique=[...new Set(ids.map(v=>id(v)))].sort((a,b)=>a-b);
  const accounts=(await c.query('SELECT * FROM finance_accounts WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE',[unique])).rows;
  if(accounts.length!==unique.length) reject('Денежный счёт не найден','NOT_FOUND',404);
  for(const a of accounts){if(user.role!=='OWNER'&&Number(a.responsible_id)!==Number(user.id))reject('Нет доступа к этому источнику денег','FORBIDDEN',403);if(active&&!a.is_active)reject('Счёт отключён. Выберите активный источник денег');}
  return accounts;
}
export async function requestAccess(c,requestId,user,{write=false}={}) {
  const request=(await c.query('SELECT * FROM requests WHERE id=$1 FOR UPDATE',[id(requestId,'Заказ')])).rows[0];
  if(!request||request.deleted_at)reject('Заказ не найден','NOT_FOUND',404);
  if(user.role==='ENGINEER'&&Number(request.engineer_id)!==Number(user.id))reject('Заказ назначен другому инженеру','FORBIDDEN',403);
  if(write&&['CLOSED','CANCELLED'].includes(request.status))reject('Сначала откройте заказ для корректировки','ORDER_FINISHED',409);
  return request;
}
export async function insertEntry(c,user,data) {
  const keys=['account_id','type','kind','category','amount','occurred_at','request_id','part_id','transfer_group_id','reversal_of','comment','document_reference','counterparty','idempotency_key','metadata'];
  const values=keys.map(k=>data[k]??(k==='occurred_at'?today():k==='metadata'?{}:null));
  const row=(await c.query(`INSERT INTO finance_transactions(${keys.join(',')},created_by,payment_method) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')},$16,'ACCOUNT') RETURNING *`,[...values,user.id])).rows[0];
  return row;
}
export async function replay(c,key,digest) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
  const row=(await c.query('SELECT * FROM finance_transactions WHERE idempotency_key=$1',[key])).rows[0];
  if(row&&row.metadata?.fingerprint!==digest)reject('Этот номер операции уже использован с другими данными','IDEMPOTENCY_CONFLICT',409);
  return row;
}
export async function recalcParts(c,requestId) {
  await c.query(`UPDATE requests r SET
    direct_cost=COALESCE((SELECT sum(qty*direct_cost) FROM request_works WHERE request_id=r.id),0)+COALESCE((SELECT sum(qty*purchase_price) FROM parts WHERE request_id=r.id AND status<>'CANCELLED'),0),
    total=GREATEST(0,COALESCE((SELECT sum(qty*unit_price) FROM request_works WHERE request_id=r.id),0)+COALESCE((SELECT sum(qty*sale_price) FROM parts WHERE request_id=r.id AND status<>'CANCELLED'),0)-COALESCE(r.discount_amount,0)),updated_at=now() WHERE r.id=$1`,[requestId]);
}
export async function createTransfer(c,user,body,key,digest) {
  const from=id(body.from_account_id),to=id(body.to_account_id);
  if(from===to)reject('Для перевода нужны два разных счёта');
  const amount=money(body.amount),comment=text(body.comment,'Назначение перевода'),occurred_at=date(body.occurred_at),group=randomUUID();
  if(body.request_id)await requestAccess(c,body.request_id,user);
  await lockAccounts(c,[from,to],user);
  await c.query('INSERT INTO finance_transfers(id,from_account_id,to_account_id,amount,created_by,comment) VALUES($1,$2,$3,$4,$5,$6)',[group,from,to,amount,user.id,comment]);
  const common={kind:'TRANSFER',category:'TRANSFER',amount,comment,occurred_at,transfer_group_id:group,request_id:body.request_id||null,metadata:{fingerprint:digest}};
  const out=await insertEntry(c,user,{...common,type:'EXPENSE',account_id:from,idempotency_key:key});
  await insertEntry(c,user,{...common,type:'INCOME',account_id:to,idempotency_key:key+':in'});
  return out;
}
