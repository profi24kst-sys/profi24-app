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
const roles=(...a)=>async(req,reply)=>{await auth(req,reply);if(reply.sent)return;if(!a.includes(req.user.role))return err(reply,'FORBIDDEN','Недостаточно прав',403)};

const schema=[
`ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT`,
`CREATE TABLE IF NOT EXISTS message_templates(
 id SERIAL PRIMARY KEY,code TEXT UNIQUE NOT NULL,name TEXT NOT NULL,audience TEXT NOT NULL CHECK(audience IN ('CUSTOMER','ENGINEER')),channel TEXT NOT NULL DEFAULT 'WHATSAPP',body TEXT NOT NULL,active BOOLEAN DEFAULT TRUE,created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now())`,
`CREATE TABLE IF NOT EXISTS message_queue(
 id BIGSERIAL PRIMARY KEY,request_id INT REFERENCES requests(id) ON DELETE SET NULL,history_id INT REFERENCES request_history(id) ON DELETE SET NULL,template_code TEXT,channel TEXT NOT NULL,audience TEXT NOT NULL,recipient TEXT,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'QUEUED',attempts INT NOT NULL DEFAULT 0,provider_message_id TEXT,error_text TEXT,dedupe_key TEXT UNIQUE,created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now(),sent_at TIMESTAMPTZ,delivered_at TIMESTAMPTZ,read_at TIMESTAMPTZ,updated_at TIMESTAMPTZ DEFAULT now())`,
`CREATE INDEX IF NOT EXISTS idx_message_queue_status ON message_queue(status,created_at)`,
`CREATE TABLE IF NOT EXISTS communication_state(id INT PRIMARY KEY DEFAULT 1,last_history_id INT NOT NULL DEFAULT 0,updated_at TIMESTAMPTZ DEFAULT now())`,
`INSERT INTO communication_state(id,last_history_id) VALUES(1,0) ON CONFLICT(id) DO NOTHING`
];
for(const s of schema)await q(s);

const seeds=[
['CUSTOMER_REQUEST_CREATED','Заявка принята','CUSTOMER','WHATSAPP','Здравствуйте, {{customer_name}}! Ваша заявка {{request_number}} принята сервисным центром PROFI24KST. Мы назначим инженера и сообщим время визита.'],
['CUSTOMER_ASSIGNED','Инженер назначен','CUSTOMER','WHATSAPP','{{customer_name}}, по заявке {{request_number}} назначен инженер {{engineer_name}}. Плановое время: {{scheduled_at}}.'],
['CUSTOMER_SCHEDULE_CHANGED','Время визита изменено','CUSTOMER','WHATSAPP','{{customer_name}}, время визита по заявке {{request_number}} изменено: {{scheduled_at}}. Инженер: {{engineer_name}}.'],
['CUSTOMER_APPROVAL','Диагностика завершена','CUSTOMER','WHATSAPP','{{customer_name}}, диагностика по заявке {{request_number}} завершена. Менеджер свяжется с вами для согласования стоимости и работ.'],
['CUSTOMER_CLOSED','Ремонт завершён','CUSTOMER','WHATSAPP','{{customer_name}}, заявка {{request_number}} завершена. Спасибо, что выбрали PROFI24KST. Гарантия и документы доступны в сервисном центре.'],
['ENGINEER_ASSIGNED','Новая заявка','ENGINEER','TELEGRAM','Новая заявка {{request_number}}: {{customer_name}}, {{phone}}, {{address}}. {{equipment}}. Неисправность: {{complaint}}. Время: {{scheduled_at}}.'],
['ENGINEER_SCHEDULE_CHANGED','Изменение расписания','ENGINEER','TELEGRAM','Изменено расписание по {{request_number}}. Новое время: {{scheduled_at}}. Клиент: {{customer_name}}, {{address}}.']
];
for(const s of seeds)await q(`INSERT INTO message_templates(code,name,audience,channel,body) VALUES($1,$2,$3,$4,$5) ON CONFLICT(code) DO NOTHING`,s);

const fmt=v=>v?new Date(v).toLocaleString('ru-RU',{timeZone:'Asia/Almaty',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'не назначено';
const render=(text,data)=>String(text||'').replace(/{{\s*([a-z_]+)\s*}}/g,(_,k)=>data[k]??'');
async function requestData(id){return (await q(`SELECT r.*,c.name customer_name,c.phone,c.address,e.category,e.brand,e.model,eng.name engineer_name,eng.telegram_chat_id FROM requests r JOIN customers c ON c.id=r.customer_id LEFT JOIN equipment e ON e.id=r.equipment_id LEFT JOIN users eng ON eng.id=r.engineer_id WHERE r.id=$1`,[id])).rows[0]}
function vars(x){return{request_number:x.number,customer_name:x.customer_name||'',phone:x.phone||'',address:x.address||'',engineer_name:x.engineer_name||'не назначен',scheduled_at:fmt(x.scheduled_at),equipment:[x.category,x.brand,x.model].filter(Boolean).join(' ')||'Техника',complaint:x.complaint||'',total:x.total||0}}
async function enqueue({request_id,history_id=null,template_code,audience,channel=null,recipient=null,dedupe_key,body=null,created_by=null}){
 const x=request_id?await requestData(request_id):null;if(request_id&&!x)return null;
 const t=template_code?(await q('SELECT * FROM message_templates WHERE code=$1 AND active=true',[template_code])).rows[0]:null;
 if(template_code&&!t)return null;audience=audience||t?.audience;channel=channel||t?.channel;
 recipient=recipient||(audience==='CUSTOMER'?x?.phone:x?.telegram_chat_id)||null;
 body=body||render(t?.body,vars(x||{}));
 const status=recipient?'QUEUED':'WAITING_RECIPIENT';
 return (await q(`INSERT INTO message_queue(request_id,history_id,template_code,channel,audience,recipient,body,status,dedupe_key,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(dedupe_key) DO NOTHING RETURNING *`,[request_id,history_id,template_code||null,channel,audience,recipient,body,status,dedupe_key,created_by])).rows[0]||null;
}

const rules={
 REQUEST_CREATED:[['CUSTOMER_REQUEST_CREATED','CUSTOMER']],
 REQUEST_ASSIGNED:[['CUSTOMER_ASSIGNED','CUSTOMER'],['ENGINEER_ASSIGNED','ENGINEER']],
 SCHEDULE_CHANGED:[['CUSTOMER_SCHEDULE_CHANGED','CUSTOMER'],['ENGINEER_SCHEDULE_CHANGED','ENGINEER']],
 DIAGNOSIS_COMPLETED:[['CUSTOMER_APPROVAL','CUSTOMER']],
 REQUEST_CLOSED:[['CUSTOMER_CLOSED','CUSTOMER']]
};
async function syncHistory(){const state=(await q('SELECT last_history_id FROM communication_state WHERE id=1')).rows[0];const rows=(await q('SELECT * FROM request_history WHERE id>$1 ORDER BY id ASC LIMIT 1000',[state.last_history_id])).rows;let last=state.last_history_id;for(const h of rows){last=Math.max(last,h.id);for(const [code,audience] of rules[h.action]||[])await enqueue({request_id:h.request_id,history_id:h.id,template_code:code,audience,dedupe_key:`history:${h.id}:${code}`})}if(rows.length)await q('UPDATE communication_state SET last_history_id=$1,updated_at=now() WHERE id=1',[last]);return rows.length}

async function sendTelegram(m){const token=process.env.TELEGRAM_BOT_TOKEN;if(!token||!m.recipient)return null;const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:m.recipient,text:m.body})});const j=await r.json().catch(()=>({}));if(!r.ok||!j.ok)throw new Error(j.description||`Telegram HTTP ${r.status}`);return String(j.result?.message_id||'')}
async function sendWhatsApp(m){const token=process.env.WHATSAPP_TOKEN,phoneId=process.env.WHATSAPP_PHONE_NUMBER_ID,version=process.env.WHATSAPP_API_VERSION||'v23.0';if(!token||!phoneId||!m.recipient)return null;const to=String(m.recipient).replace(/\D/g,'').replace(/^8(?=7\d{9}$)/,'7');const r=await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to,type:'text',text:{body:m.body,preview_url:false}})});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error?.message||`WhatsApp HTTP ${r.status}`);return j.messages?.[0]?.id||''}
async function processQueue(limit=30){const rows=(await q(`SELECT * FROM message_queue WHERE status='QUEUED' ORDER BY created_at LIMIT $1`,[limit])).rows;let sent=0;for(const m of rows){try{let id=null;if(m.channel==='TELEGRAM')id=await sendTelegram(m);else if(m.channel==='WHATSAPP')id=await sendWhatsApp(m);if(id===null)continue;await q(`UPDATE message_queue SET status='SENT',provider_message_id=$1,sent_at=now(),updated_at=now(),attempts=attempts+1,error_text=NULL WHERE id=$2`,[id,m.id]);sent++}catch(e){await q(`UPDATE message_queue SET status=CASE WHEN attempts>=2 THEN 'ERROR' ELSE 'QUEUED' END,attempts=attempts+1,error_text=$1,updated_at=now() WHERE id=$2`,[String(e.message).slice(0,500),m.id])}}return sent}

app.get('/health',async()=>{await q('SELECT 1');return{ok:true,service:'profi24-communications',version:'1.0.0',telegram_configured:Boolean(process.env.TELEGRAM_BOT_TOKEN),whatsapp_configured:Boolean(process.env.WHATSAPP_TOKEN&&process.env.WHATSAPP_PHONE_NUMBER_ID)}});
app.get('/api/v1/communications/status',{preHandler:auth},async()=>({data:{telegram_configured:Boolean(process.env.TELEGRAM_BOT_TOKEN),whatsapp_configured:Boolean(process.env.WHATSAPP_TOKEN&&process.env.WHATSAPP_PHONE_NUMBER_ID),queued:Number((await q("SELECT count(*) c FROM message_queue WHERE status='QUEUED'")).rows[0].c),errors:Number((await q("SELECT count(*) c FROM message_queue WHERE status='ERROR'")).rows[0].c)}}));
app.get('/api/v1/communications/templates',{preHandler:auth},async()=>({data:(await q('SELECT * FROM message_templates ORDER BY audience,name')).rows}));
app.patch('/api/v1/communications/templates/:id',{preHandler:roles('OWNER','MANAGER')},async(req,reply)=>{const old=(await q('SELECT * FROM message_templates WHERE id=$1',[req.params.id])).rows[0];if(!old)return err(reply,'NOT_FOUND','Шаблон не найден',404);const b={...old,...req.body};const r=(await q('UPDATE message_templates SET name=$1,channel=$2,body=$3,active=$4,updated_at=now() WHERE id=$5 RETURNING *',[b.name,b.channel,b.body,b.active,req.params.id])).rows[0];return{data:r}});
app.get('/api/v1/communications/queue',{preHandler:auth},async req=>{const status=req.query?.status;const rows=(await q(`SELECT mq.*,r.number request_number,c.name customer_name FROM message_queue mq LEFT JOIN requests r ON r.id=mq.request_id LEFT JOIN customers c ON c.id=r.customer_id ${status?'WHERE mq.status=$1':''} ORDER BY mq.created_at DESC LIMIT 500`,status?[status]:[])).rows;return{data:rows}});
app.post('/api/v1/communications/manual',{preHandler:roles('OWNER','MANAGER')},async(req,reply)=>{const {request_id,template_code,channel,audience,recipient,body}=req.body||{};if(!request_id||(!template_code&&!body))return err(reply,'VALIDATION','Укажите заявку и шаблон или текст');const m=await enqueue({request_id,template_code,audience,channel,recipient,body,dedupe_key:`manual:${Date.now()}:${Math.random()}`,created_by:req.user.id});return reply.code(201).send({data:m})});
app.post('/api/v1/communications/sync',{preHandler:roles('OWNER','MANAGER')},async()=>{const discovered=await syncHistory(),sent=await processQueue();return{data:{discovered,sent}}});
app.post('/api/v1/communications/queue/:id/retry',{preHandler:roles('OWNER','MANAGER')},async(req,reply)=>{const r=(await q("UPDATE message_queue SET status=CASE WHEN recipient IS NULL THEN 'WAITING_RECIPIENT' ELSE 'QUEUED' END,error_text=NULL,updated_at=now() WHERE id=$1 RETURNING *",[req.params.id])).rows[0];if(!r)return err(reply,'NOT_FOUND','Сообщение не найдено',404);return{data:r}});
app.post('/api/v1/communications/queue/:id/cancel',{preHandler:roles('OWNER','MANAGER')},async(req,reply)=>{const r=(await q("UPDATE message_queue SET status='CANCELLED',updated_at=now() WHERE id=$1 AND status NOT IN ('SENT','DELIVERED','READ') RETURNING *",[req.params.id])).rows[0];if(!r)return err(reply,'STATE_CONFLICT','Сообщение уже отправлено или не найдено',409);return{data:r}});

let busy=false;setInterval(async()=>{if(busy)return;busy=true;try{await syncHistory();await processQueue()}catch(e){app.log.error(e)}finally{busy=false}},30000);
await syncHistory();
const close=async()=>{try{await pool.end()}finally{process.exit(0)}};process.on('SIGTERM',close);process.on('SIGINT',close);
app.listen({port:Number(process.env.PORT||8088),host:'0.0.0.0'});
