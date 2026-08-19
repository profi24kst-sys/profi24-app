import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import pg from 'pg';

const app=Fastify({logger:true});
await app.register(cors,{origin:true,credentials:true});
await app.register(helmet,{contentSecurityPolicy:false});
await app.register(jwt,{secret:process.env.JWT_SECRET||'dev-secret-change-me'});
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:Number(process.env.DB_POOL_MAX||10)});
const q=(s,p=[])=>pool.query(s,p);
const err=(reply,code,message,status=422)=>reply.code(status).send({data:null,error:{code,message}});
const auth=async(req,reply)=>{try{await req.jwtVerify()}catch{return err(reply,'UNAUTHORIZED','Требуется авторизация',401)}};

const schema=[
`CREATE TABLE IF NOT EXISTS notification_events(
 id BIGSERIAL PRIMARY KEY,
 event_key TEXT UNIQUE NOT NULL,
 request_id INT REFERENCES requests(id) ON DELETE CASCADE,
 task_id INT REFERENCES tasks(id) ON DELETE CASCADE,
 severity TEXT NOT NULL CHECK(severity IN ('info','warning','critical')),
 type TEXT NOT NULL,
 title TEXT NOT NULL,
 subtitle TEXT,
 detail TEXT,
 audience TEXT NOT NULL DEFAULT 'OPS',
 target_user_id INT REFERENCES users(id),
 source_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ DEFAULT now(),
 updated_at TIMESTAMPTZ DEFAULT now(),
 resolved_at TIMESTAMPTZ
)`,
`CREATE INDEX IF NOT EXISTS idx_notification_events_active ON notification_events(resolved_at,audience,target_user_id,created_at DESC)`,
`CREATE TABLE IF NOT EXISTS notification_reads(
 notification_id BIGINT REFERENCES notification_events(id) ON DELETE CASCADE,
 user_id INT REFERENCES users(id) ON DELETE CASCADE,
 read_at TIMESTAMPTZ DEFAULT now(),
 PRIMARY KEY(notification_id,user_id)
)`,
`CREATE TABLE IF NOT EXISTS notification_delivery(
 id BIGSERIAL PRIMARY KEY,
 notification_id BIGINT REFERENCES notification_events(id) ON DELETE CASCADE,
 channel TEXT NOT NULL,
 recipient TEXT,
 status TEXT NOT NULL DEFAULT 'QUEUED',
 provider_message_id TEXT,
 error_text TEXT,
 queued_at TIMESTAMPTZ DEFAULT now(),
 sent_at TIMESTAMPTZ,
 delivered_at TIMESTAMPTZ,
 read_at TIMESTAMPTZ
)`
];
for(const s of schema)await q(s);

const dt=v=>new Date(v).toLocaleString('ru-RU',{timeZone:'Asia/Almaty',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
function alert(event_key,severity,type,title,subtitle,detail,{request_id=null,task_id=null,audience='OPS',target_user_id=null,source_at=null}={}){return{event_key,severity,type,title,subtitle,detail,request_id,task_id,audience,target_user_id,source_at}}

async function computeAlerts(){
 const now=Date.now(),out=[];
 const requests=(await q(`SELECT r.*,c.name customer_name,eng.name engineer_name FROM requests r JOIN customers c ON c.id=r.customer_id LEFT JOIN users eng ON eng.id=r.engineer_id WHERE r.status NOT IN ('CLOSED','CANCELLED')`)).rows;
 for(const x of requests){
  const sla=x.sla_deadline?new Date(x.sla_deadline).getTime():0,scheduled=x.scheduled_at?new Date(x.scheduled_at).getTime():0,created=new Date(x.created_at).getTime(),updated=new Date(x.updated_at||x.created_at).getTime();
  if(sla&&sla<now)out.push(alert(`sla:${x.id}:${x.sla_deadline}`,'critical','SLA_OVERDUE','SLA просрочен',`${x.number} · ${x.customer_name}`,`Срок SLA истёк ${dt(x.sla_deadline)}`,{request_id:x.id,source_at:x.sla_deadline}));
  else if(sla&&sla-now<=30*60000)out.push(alert(`sla-soon:${x.id}:${x.sla_deadline}`,'warning','SLA_SOON','SLA заканчивается',`${x.number} · ${x.customer_name}`,`До SLA осталось ${Math.max(1,Math.ceil((sla-now)/60000))} мин`,{request_id:x.id,source_at:x.sla_deadline}));
  if(!x.engineer_id&&now-created>15*60000)out.push(alert(`unassigned:${x.id}`,'warning','UNASSIGNED','Заявка без инженера',`${x.number} · ${x.customer_name}`,'Заявка не распределена более 15 минут',{request_id:x.id,source_at:x.created_at}));
  if(x.status==='ASSIGNED'&&x.engineer_id&&now-updated>20*60000)out.push(alert(`not-accepted:${x.id}:${x.engineer_id}`,'warning','NOT_ACCEPTED','Инженер не принял заявку',`${x.number} · ${x.engineer_name||'Инженер'}`,'Назначение ожидает принятия более 20 минут',{request_id:x.id,audience:'ENGINEER',target_user_id:x.engineer_id,source_at:x.updated_at}));
  if(scheduled&&scheduled>now&&scheduled-now<=60*60000&&x.engineer_id)out.push(alert(`visit-soon:${x.id}:${x.scheduled_at}`,'info','VISIT_SOON','Скоро выезд',`${x.number} · ${x.customer_name}`,`${x.engineer_name||'Инженер'} · ${dt(x.scheduled_at)}`,{request_id:x.id,audience:'ENGINEER',target_user_id:x.engineer_id,source_at:x.scheduled_at}));
  if(scheduled&&scheduled<now&&now-scheduled>20*60000&&!['PAYMENT_REQUIRED'].includes(x.status))out.push(alert(`visit-late:${x.id}:${x.scheduled_at}`,'critical','VISIT_LATE','Просрочка по расписанию',`${x.number} · ${x.customer_name}`,`Выезд был назначен на ${dt(x.scheduled_at)}`,{request_id:x.id,source_at:x.scheduled_at}));
  if(x.status==='APPROVAL_REQUIRED'&&now-updated>30*60000)out.push(alert(`approval:${x.id}`,'warning','APPROVAL_STUCK','Зависло согласование',`${x.number} · ${x.customer_name}`,'Стоимость/работы ожидают согласования более 30 минут',{request_id:x.id,source_at:x.updated_at}));
 }
 const tasks=(await q(`SELECT t.*,r.number request_number FROM tasks t LEFT JOIN requests r ON r.id=t.request_id WHERE t.status='OPEN' AND t.due_at IS NOT NULL AND t.due_at<now()`)).rows;
 for(const t of tasks)out.push(alert(`task:${t.id}:${t.due_at}`,'warning','TASK_OVERDUE','Просрочена задача',t.title,`Срок: ${dt(t.due_at)}${t.request_number?' · '+t.request_number:''}`,{request_id:t.request_id,task_id:t.id,audience:'USER',target_user_id:t.assigned_to,source_at:t.due_at}));
 return out;
}

async function refresh(){
 const alerts=await computeAlerts();
 const keys=alerts.map(x=>x.event_key);
 const c=await pool.connect();
 try{await c.query('BEGIN');
  for(const a of alerts)await c.query(`INSERT INTO notification_events(event_key,request_id,task_id,severity,type,title,subtitle,detail,audience,target_user_id,source_at,resolved_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL)
   ON CONFLICT(event_key) DO UPDATE SET severity=EXCLUDED.severity,title=EXCLUDED.title,subtitle=EXCLUDED.subtitle,detail=EXCLUDED.detail,updated_at=now(),resolved_at=NULL`,[a.event_key,a.request_id,a.task_id,a.severity,a.type,a.title,a.subtitle,a.detail,a.audience,a.target_user_id,a.source_at]);
  if(keys.length)await c.query(`UPDATE notification_events SET resolved_at=now(),updated_at=now() WHERE resolved_at IS NULL AND event_key<>ALL($1::text[])`,[keys]);
  else await c.query(`UPDATE notification_events SET resolved_at=now(),updated_at=now() WHERE resolved_at IS NULL`);
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}

app.get('/health',async()=>{await q('SELECT 1');return{ok:true,service:'profi24-notifications',version:'1.0.0'}});
app.get('/api/v1/notifications',{preHandler:auth},async req=>{await refresh();const p=[req.user.id];let access;if(req.user.role==='ENGINEER')access=`((n.audience='ENGINEER' OR n.audience='USER') AND n.target_user_id=$1)`;else access=`(n.audience='OPS' OR n.target_user_id=$1)`;const rows=(await q(`SELECT n.*,nr.read_at AS user_read_at FROM notification_events n LEFT JOIN notification_reads nr ON nr.notification_id=n.id AND nr.user_id=$1 WHERE n.resolved_at IS NULL AND ${access} ORDER BY CASE n.severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END DESC,n.created_at DESC LIMIT 300`,p)).rows;return{data:rows}});
app.get('/api/v1/notifications/history',{preHandler:auth},async req=>{const p=[req.user.id];let access;if(req.user.role==='ENGINEER')access=`((n.audience='ENGINEER' OR n.audience='USER') AND n.target_user_id=$1)`;else access=`(n.audience='OPS' OR n.target_user_id=$1)`;const rows=(await q(`SELECT n.*,nr.read_at AS user_read_at FROM notification_events n LEFT JOIN notification_reads nr ON nr.notification_id=n.id AND nr.user_id=$1 WHERE ${access} ORDER BY n.created_at DESC LIMIT 500`,p)).rows;return{data:rows}});
app.post('/api/v1/notifications/:id/read',{preHandler:auth},async(req,reply)=>{const n=(await q('SELECT id FROM notification_events WHERE id=$1',[req.params.id])).rows[0];if(!n)return err(reply,'NOT_FOUND','Уведомление не найдено',404);await q('INSERT INTO notification_reads(notification_id,user_id) VALUES($1,$2) ON CONFLICT(notification_id,user_id) DO UPDATE SET read_at=now()',[req.params.id,req.user.id]);return{data:{ok:true}}});
app.post('/api/v1/notifications/read-all',{preHandler:auth},async req=>{await refresh();const p=[req.user.id];let access;if(req.user.role==='ENGINEER')access=`((audience='ENGINEER' OR audience='USER') AND target_user_id=$1)`;else access=`(audience='OPS' OR target_user_id=$1)`;await q(`INSERT INTO notification_reads(notification_id,user_id) SELECT id,$1 FROM notification_events WHERE resolved_at IS NULL AND ${access} ON CONFLICT(notification_id,user_id) DO UPDATE SET read_at=now()`,p);return{data:{ok:true}}});
app.get('/api/v1/notifications/:id/delivery',{preHandler:auth},async req=>({data:(await q('SELECT * FROM notification_delivery WHERE notification_id=$1 ORDER BY queued_at DESC',[req.params.id])).rows}));

const close=async()=>{try{await pool.end()}finally{process.exit(0)}};process.on('SIGTERM',close);process.on('SIGINT',close);
app.listen({port:Number(process.env.PORT||8087),host:'0.0.0.0'});
