import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import pg from 'pg';

const app=Fastify({logger:true});
await app.register(jwt,{secret:process.env.JWT_SECRET||'dev-secret-change-me'});
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:5});
const q=(s,p=[])=>pool.query(s,p);

const weights={SLA:3,ACCEPT:2,VISIT:3,APPROVAL:2,PART:2,REPAIR:2,CONTROL:3};
const labels={SLA:'Просрочен SLA',ACCEPT:'Не принял заявку вовремя',VISIT:'Просрочен выезд',APPROVAL:'Зависло согласование',PART:'Нет движения по запчасти',REPAIR:'Затянувшийся ремонт',CONTROL:'Просрочен контрольный срок'};
const severity=w=>w>=3?'critical':w===2?'warning':'info';

await q(`CREATE TABLE IF NOT EXISTS discipline_incidents(
  id BIGSERIAL PRIMARY KEY,
  request_id INT REFERENCES requests(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id),
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  weight INT NOT NULL DEFAULT 1,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb
)`);
await q(`CREATE UNIQUE INDEX IF NOT EXISTS uq_discipline_open_incident ON discipline_incidents(request_id,user_id,type) WHERE resolved_at IS NULL`);
await q(`CREATE INDEX IF NOT EXISTS idx_discipline_incidents_user_opened ON discipline_incidents(user_id,opened_at DESC)`);

const auth=async(req,reply)=>{try{await req.jwtVerify()}catch{return reply.code(401).send({data:null,error:{message:'Требуется авторизация'}})}};
const management=async(req,reply)=>{await auth(req,reply);if(reply.sent)return;if(!['OWNER','MANAGER'].includes(req.user.role))return reply.code(403).send({data:null,error:{message:'Недостаточно прав'}})};

function detect(r){
  const now=Date.now(),updated=new Date(r.updated_at||r.created_at).getTime(),age=(now-updated)/36e5,scheduled=r.scheduled_at?new Date(r.scheduled_at).getTime():0,out=[];
  if(!r.engineer_id)return out;
  if(r.sla_deadline&&new Date(r.sla_deadline).getTime()<now)out.push('SLA');
  if(r.status==='ASSIGNED'&&age>=2)out.push('ACCEPT');
  if(scheduled&&scheduled<now&&['ASSIGNED','ACCEPTED','DIAGNOSTICS'].includes(r.status))out.push('VISIT');
  if(r.status==='APPROVAL_REQUIRED'&&age>=24)out.push('APPROVAL');
  if(r.status==='WAITING_PART'&&age>=72)out.push('PART');
  if(r.status==='REPAIR'&&age>=48)out.push('REPAIR');
  return out;
}

async function scan(){
  const rows=(await q(`SELECT id,engineer_id,status,created_at,updated_at,scheduled_at,sla_deadline FROM requests WHERE status NOT IN ('CLOSED','CANCELLED')`)).rows,seen=new Set();
  for(const r of rows)for(const type of detect(r)){
    seen.add(`${r.id}:${r.engineer_id}:${type}`);
    const weight=weights[type];
    await q(`INSERT INTO discipline_incidents(request_id,user_id,type,label,weight,last_seen_at,meta) VALUES($1,$2,$3,$4,$5,now(),$6)
      ON CONFLICT(request_id,user_id,type) WHERE resolved_at IS NULL DO UPDATE SET last_seen_at=now(),label=EXCLUDED.label,weight=EXCLUDED.weight,meta=EXCLUDED.meta`,
      [r.id,r.engineer_id,type,labels[type],weight,{status:r.status,scheduled_at:r.scheduled_at,sla_deadline:r.sla_deadline,severity:severity(weight)}]);
  }
  const controls=(await q(`SELECT request_id,owner_id,control_due_at,reason FROM dispatch_controls WHERE status='OPEN' AND owner_id IS NOT NULL AND control_due_at<now()`)).rows;
  for(const c of controls){
    seen.add(`${c.request_id}:${c.owner_id}:CONTROL`);
    await q(`INSERT INTO discipline_incidents(request_id,user_id,type,label,weight,last_seen_at,meta) VALUES($1,$2,'CONTROL',$3,$4,now(),$5)
      ON CONFLICT(request_id,user_id,type) WHERE resolved_at IS NULL DO UPDATE SET last_seen_at=now(),weight=EXCLUDED.weight,meta=EXCLUDED.meta`,
      [c.request_id,c.owner_id,labels.CONTROL,weights.CONTROL,{control_due_at:c.control_due_at,reason:c.reason,severity:'critical'}]);
  }
  const open=(await q(`SELECT id,request_id,user_id,type FROM discipline_incidents WHERE resolved_at IS NULL`)).rows;
  for(const i of open)if(!seen.has(`${i.request_id}:${i.user_id}:${i.type}`))await q(`UPDATE discipline_incidents SET resolved_at=now(),last_seen_at=now() WHERE id=$1`,[i.id]);
}

app.setErrorHandler((e,req,reply)=>{req.log.error(e);reply.code(500).send({data:null,error:{message:'Ошибка сервиса дисциплины',code:e.code||'DISCIPLINE_ERROR'}})});
app.get('/health',async()=>{await q('SELECT 1');return{ok:true,service:'discipline',version:2}});

app.get('/api/discipline/summary',{preHandler:management},async req=>{
  await scan();
  const days=Math.min(90,Math.max(1,Number(req.query?.days||7)));
  const users=(await q(`SELECT id,name,role FROM users WHERE active=true AND role IN ('ENGINEER','MANAGER') ORDER BY name`)).rows;
  const current=(await q(`WITH cases AS (SELECT user_id,COALESCE(request_id::bigint,-id) case_id,MAX(weight)::int effective_weight,COUNT(*)::int signals FROM discipline_incidents WHERE resolved_at IS NULL GROUP BY user_id,COALESCE(request_id::bigint,-id)) SELECT user_id,COUNT(*)::int cases,COALESCE(SUM(signals),0)::int signals,COALESCE(SUM(effective_weight),0)::int effective_weight FROM cases GROUP BY user_id`)).rows;
  const period=(await q(`WITH cases AS (SELECT user_id,COALESCE(request_id::bigint,-id) case_id,MAX(weight)::int effective_weight,COUNT(*)::int signals FROM discipline_incidents WHERE opened_at>=now()-($1::int * interval '1 day') GROUP BY user_id,COALESCE(request_id::bigint,-id)) SELECT user_id,COUNT(*)::int cases,COALESCE(SUM(signals),0)::int signals,COALESCE(SUM(effective_weight),0)::int effective_weight FROM cases GROUP BY user_id`,[days])).rows;
  const prev=(await q(`WITH cases AS (SELECT user_id,COALESCE(request_id::bigint,-id) case_id,MAX(weight)::int effective_weight FROM discipline_incidents WHERE opened_at<now()-($1::int * interval '1 day') AND opened_at>=now()-($1::int * 2 * interval '1 day') GROUP BY user_id,COALESCE(request_id::bigint,-id)) SELECT user_id,COUNT(*)::int cases,COALESCE(SUM(effective_weight),0)::int effective_weight FROM cases GROUP BY user_id`,[days])).rows;
  const active=(await q(`SELECT engineer_id user_id,COUNT(*)::int active FROM requests WHERE status NOT IN ('CLOSED','CANCELLED') AND engineer_id IS NOT NULL GROUP BY engineer_id`)).rows;
  let acceptance=[];
  try{acceptance=(await q(`WITH h AS (SELECT action,request_id,created_at,lead(created_at) OVER(PARTITION BY request_id ORDER BY created_at) next_at,lead(action) OVER(PARTITION BY request_id ORDER BY created_at) next_action FROM request_history WHERE created_at>=now()-($1::int * interval '1 day') AND action IN ('REQUEST_ASSIGNED','REQUEST_ACCEPTED')),pairs AS (SELECT request_id,created_at assigned_at,next_at accepted_at FROM h WHERE action='REQUEST_ASSIGNED' AND next_action='REQUEST_ACCEPTED') SELECT r.engineer_id user_id,COUNT(*)::int accepted,round(avg(extract(epoch FROM(p.accepted_at-p.assigned_at))/60))::int avg_minutes,round(100.0*COUNT(*) FILTER(WHERE p.accepted_at-p.assigned_at<=interval '2 hours')/NULLIF(COUNT(*),0))::int within_target FROM pairs p JOIN requests r ON r.id=p.request_id WHERE r.engineer_id IS NOT NULL GROUP BY r.engineer_id`,[days])).rows}catch(e){req.log.warn({err:e},'acceptance metrics unavailable')}
  const map=a=>new Map(a.map(x=>[Number(x.user_id),x])),cm=map(current),pm=map(period),vm=map(prev),am=map(active),acm=map(acceptance);
  const data=users.map(u=>{const c=cm.get(Number(u.id))||{},p=pm.get(Number(u.id))||{},v=vm.get(Number(u.id))||{},a=am.get(Number(u.id))||{},ac=acm.get(Number(u.id))||{};const openCases=Number(c.cases||0),openSignals=Number(c.signals||0),openWeight=Number(c.effective_weight||0),periodCases=Number(p.cases||0),periodSignals=Number(p.signals||0),periodWeight=Number(p.effective_weight||0),previousCases=Number(v.cases||0),currentPenalty=openWeight*8,historyPenalty=Math.min(20,periodWeight*2),rating=Math.max(0,100-currentPenalty-historyPenalty);return{id:u.id,name:u.name,role:u.role,active:Number(a.active||0),open_cases:openCases,open_incidents:openSignals,open_weight:openWeight,period_cases:periodCases,period_incidents:periodSignals,period_weight:periodWeight,previous_cases:previousCases,trend:periodCases-previousCases,rating,rating_current_penalty:currentPenalty,rating_history_penalty:historyPenalty,avg_accept_minutes:ac.avg_minutes==null?null:Number(ac.avg_minutes),accept_within_target_pct:ac.within_target==null?null:Number(ac.within_target)}});
  return{data:{days,generated_at:new Date().toISOString(),scoring:{dedupe:'max_weight_per_order',current_weight_multiplier:8,history_weight_multiplier:2,history_penalty_cap:20},users:data}};
});

app.get('/api/discipline/incidents',{preHandler:management},async req=>{
  await scan();
  const days=Math.min(90,Math.max(1,Number(req.query?.days||30))),userId=Number(req.query?.user_id||0),p=[days],where=[`(di.resolved_at IS NULL OR di.opened_at>=now()-($1::int * interval '1 day'))`];
  if(userId){p.push(userId);where.push(`di.user_id=$${p.length}`)}
  const rows=(await q(`SELECT di.*,r.number,c.name customer_name,CASE WHEN di.weight>=3 THEN 'critical' WHEN di.weight=2 THEN 'warning' ELSE 'info' END severity FROM discipline_incidents di LEFT JOIN requests r ON r.id=di.request_id LEFT JOIN customers c ON c.id=r.customer_id WHERE ${where.join(' AND ')} ORDER BY di.resolved_at NULLS FIRST,di.opened_at DESC LIMIT 500`,p)).rows;
  return{data:rows};
});

setInterval(()=>scan().catch(e=>app.log.error(e)),300000);scan().catch(e=>app.log.error(e));
const close=async()=>{await pool.end();process.exit(0)};process.on('SIGTERM',close);process.on('SIGINT',close);
app.listen({port:Number(process.env.PORT||8102),host:'0.0.0.0'});
