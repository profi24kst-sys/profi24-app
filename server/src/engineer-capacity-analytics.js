const TZ='Asia/Qostanay';
const ACTIVE_STATUSES=['ASSIGNED','ACCEPTED','DIAGNOSTICS','APPROVAL_REQUIRED','WAITING_PART','REPAIR','TESTING','PAYMENT_REQUIRED'];
const statusWeight={ASSIGNED:.8,ACCEPTED:.9,DIAGNOSTICS:1,APPROVAL_REQUIRED:.3,WAITING_PART:.15,REPAIR:.8,TESTING:.4,PAYMENT_REQUIRED:.1};
const globalRoles=new Set(['OWNER','SUPERVISOR']);
const clamp=(v,min,max)=>Math.min(max,Math.max(min,v));
const n=v=>Number(v||0);
const toMin=s=>{const [h,m]=String(s||'09:00').split(':').map(Number);return h*60+m};
const hhmm=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
const fmtParts=(date)=>Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
const localNow=(date=new Date())=>{const p=fmtParts(date);return{date:`${p.year}-${p.month}-${p.day}`,minutes:Number(p.hour)*60+Number(p.minute)}};
const localDate=date=>localNow(new Date(date)).date;
const businessError=(code,message,statusCode=409,details)=>Object.assign(new Error(message),{code,statusCode,details});
const fail=(reply,error)=>reply.code(error?.statusCode||422).send({data:null,error:{code:error?.code||'VALIDATION',message:error?.message||'Ошибка расчёта загрузки инженеров',details:error?.details}});

export async function resolveEngineerCapacityBranchIds(pool,user){
 if(!user||globalRoles.has(user.role))return null;
 if(user.role!=='MANAGER')return[];
 return(await pool.query('SELECT branch_id FROM user_branches WHERE user_id=$1 ORDER BY branch_id',[user.id])).rows.map(x=>Number(x.branch_id));
}

function scope(alias,branchIds,branchId,params){
 const where=[];
 if(Array.isArray(branchIds)){
  if(!branchIds.length)return{empty:true,where};
  params.push(branchIds.map(Number));where.push(`${alias}.branch_id=ANY($${params.length}::int[])`);
 }
 if(branchId){params.push(Number(branchId));where.push(`${alias}.branch_id=$${params.length}`)}
 return{empty:false,where};
}

function empty(now,date){return{generated_at:now.toISOString(),date,summary:{engineers:0,scheduled_jobs:0,overloaded:0,unassigned:0,overdue_sla:0,missed_visits:0},engineers:[],unassigned:[],methodology:{working_day:'09:00–18:00',slot_minutes:90,max_daily_jobs:6,skill_window_days:180}}}

function nextFreeWindow(times,{date,now=new Date(),slotMinutes=90,startMin=9*60,endMin=18*60}={}){
 const local=localNow(now);let cursor=startMin;
 if(date===local.date)cursor=Math.max(cursor,Math.ceil(local.minutes/30)*30);
 const blocks=(times||[]).map(toMin).filter(Number.isFinite).sort((a,b)=>a-b).map(x=>[x,x+slotMinutes]);
 for(const [s,e] of blocks){if(cursor+slotMinutes<=s)return hhmm(cursor);if(cursor<e)cursor=e}
 return cursor+slotMinutes<=endMin?hhmm(cursor):null;
}

function skillScore(jobs){jobs=n(jobs);if(jobs>=10)return 100;if(jobs>=5)return 85;if(jobs>=2)return 70;if(jobs===1)return 60;return 50}
function availabilityScore(time){if(!time)return 15;const mins=toMin(time),start=9*60,end=18*60;return clamp(100-(mins-start)/(end-start)*45,55,100)}
function loadScore(engineer){return clamp(100-n(engineer.scheduled_jobs)*14-n(engineer.active_weight)*7-n(engineer.overdue_sla)*12-n(engineer.missed_visits)*10,0,100)}

function rankForRequest(request,engineers,skillByEngineer){
 const category=String(request.category||'').trim().toLowerCase(),critical=String(request.priority||'NORMAL')==='CRITICAL';
 return engineers.map(e=>{
  const skill=skillByEngineer.get(Number(e.id))?.get(category)||{jobs:0,avg_cycle_hours:null};
  const ss=skillScore(skill.jobs),ls=loadScore(e),as=availabilityScore(e.next_free_time),score=critical?.35*ls+.30*ss+.35*as:.45*ls+.40*ss+.15*as;
  const reason=`${critical?'Критичная заявка':'Обычная заявка'}: загрузка ${Math.round(ls)}/100, опыт по категории ${skill.jobs||0} закр. заказов (${Math.round(ss)}/100), ${e.next_free_time?'ближайшее окно '+e.next_free_time:'свободного окна сегодня нет'}.`;
  return{engineer_id:Number(e.id),engineer_name:e.name,score:Number(score.toFixed(1)),load_score:Number(ls.toFixed(1)),skill_score:ss,availability_score:Number(as.toFixed(1)),category_jobs:Number(skill.jobs||0),avg_category_cycle_hours:skill.avg_cycle_hours==null?null:Number(Number(skill.avg_cycle_hours).toFixed(1)),next_free_time:e.next_free_time,scheduled_jobs:Number(e.scheduled_jobs),active_orders:Number(e.active_orders),overdue_sla:Number(e.overdue_sla),reason}
 }).sort((a,b)=>b.score-a.score||a.scheduled_jobs-b.scheduled_jobs||a.engineer_name.localeCompare(b.engineer_name,'ru'));
}

export async function buildEngineerCapacityAnalytics(db,{branchIds=null,branchId=null,date,now=new Date()}={}){
 const local=localNow(now);date=String(date||local.date);if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw businessError('VALIDATION','Дата должна быть в формате YYYY-MM-DD',422);
 if(branchId&&Array.isArray(branchIds)&&!branchIds.map(Number).includes(Number(branchId)))throw businessError('FORBIDDEN','Филиал недоступен пользователю',403);
 const engineerScopeIds=branchId?[Number(branchId)]:Array.isArray(branchIds)?branchIds.map(Number):null;
 const engineerParams=[];let engineerWhere="u.role='ENGINEER' AND u.active=true";
 if(engineerScopeIds){if(!engineerScopeIds.length)return empty(now,date);engineerParams.push(engineerScopeIds);engineerWhere+=` AND (u.primary_branch_id=ANY($1::int[]) OR EXISTS(SELECT 1 FROM user_branches ux WHERE ux.user_id=u.id AND ux.branch_id=ANY($1::int[])))`}
 const engineerRows=(await db.query(`SELECT u.id,u.name,u.primary_branch_id FROM users u WHERE ${engineerWhere} ORDER BY u.name`,engineerParams)).rows;
 if(!engineerRows.length)return empty(now,date);
 const engineerIds=engineerRows.map(x=>Number(x.id));
 const activeParams=[engineerIds,ACTIVE_STATUSES],activeScope=scope('r',branchIds,branchId,activeParams);if(activeScope.empty)return empty(now,date);const activeWhere=activeScope.where.length?' AND '+activeScope.where.join(' AND '):'';
 const active=(await db.query(`SELECT r.id,r.number,r.engineer_id,r.branch_id,r.status,r.priority,r.sla_deadline,r.scheduled_at,r.created_at,e.category,TO_CHAR(r.scheduled_at AT TIME ZONE '${TZ}','HH24:MI') scheduled_local_time FROM requests r LEFT JOIN equipment e ON e.id=r.equipment_id WHERE r.deleted_at IS NULL AND r.engineer_id=ANY($1::int[]) AND r.status=ANY($2::text[])${activeWhere}`,activeParams)).rows;
 const dayRows=active.filter(x=>x.scheduled_at&&localDate(x.scheduled_at)===date);
 const historyParams=[engineerIds,new Date(now.getTime()-180*86400000).toISOString()],historyScope=scope('r',branchIds,branchId,historyParams);if(historyScope.empty)return empty(now,date);const historyWhere=historyScope.where.length?' AND '+historyScope.where.join(' AND '):'';
 const skills=(await db.query(`SELECT r.engineer_id,lower(COALESCE(e.category,'')) category,count(*)::int jobs,avg(EXTRACT(EPOCH FROM (r.closed_at-r.created_at))/3600)::numeric avg_cycle_hours FROM requests r LEFT JOIN equipment e ON e.id=r.equipment_id WHERE r.deleted_at IS NULL AND r.status='CLOSED' AND r.closed_at IS NOT NULL AND r.engineer_id=ANY($1::int[]) AND r.closed_at>=$2::timestamptz${historyWhere} GROUP BY r.engineer_id,lower(COALESCE(e.category,''))`,historyParams)).rows;
 const skillByEngineer=new Map();for(const s of skills){const id=Number(s.engineer_id);if(!skillByEngineer.has(id))skillByEngineer.set(id,new Map());skillByEngineer.get(id).set(String(s.category||''),s)}
 const candidateBranches=new Map();for(const e of engineerRows){const ids=[];if(e.primary_branch_id)ids.push(Number(e.primary_branch_id));const more=(await db.query('SELECT branch_id FROM user_branches WHERE user_id=$1',[e.id])).rows.map(x=>Number(x.branch_id));candidateBranches.set(Number(e.id),[...new Set([...ids,...more])])}
 const engineers=[];for(const e of engineerRows){const id=Number(e.id),mine=active.filter(x=>Number(x.engineer_id)===id),today=dayRows.filter(x=>Number(x.engineer_id)===id),overdue=mine.filter(x=>x.sla_deadline&&new Date(x.sla_deadline)<now),missed=mine.filter(x=>x.scheduled_at&&new Date(x.scheduled_at)<now&&['ASSIGNED','ACCEPTED','DIAGNOSTICS'].includes(x.status)),activeWeight=mine.reduce((a,x)=>a+(statusWeight[x.status]||.25),0),times=today.map(x=>x.scheduled_local_time).filter(Boolean),next=nextFreeWindow(times,{date,now}),branches=candidateBranches.get(id)||[],branchForCard=branchId?Number(branchId):(branches[0]||Number(e.primary_branch_id)||0),scheduled=today.length,util=Math.min(150,scheduled/6*100),overloaded=scheduled>=6||activeWeight>=5||overdue.length>=2;engineers.push({id,name:e.name,branch_id:branchForCard,branch_ids:branches,scheduled_jobs:scheduled,active_orders:mine.length,active_weight:Number(activeWeight.toFixed(2)),overdue_sla:overdue.length,missed_visits:missed.length,utilization_pct:Number(util.toFixed(1)),next_free_time:next,overloaded,status:overloaded?'OVERLOADED':next?'AVAILABLE':'FULL'})}
 const unassignedParams=[],unassignedScope=scope('r',branchIds,branchId,unassignedParams);if(unassignedScope.empty)return empty(now,date);const unassignedWhere=unassignedScope.where.length?' AND '+unassignedScope.where.join(' AND '):'';
 const unassigned=(await db.query(`SELECT r.id,r.number,r.branch_id,r.priority,r.status,r.created_at,r.sla_deadline,c.name customer_name,e.category,e.brand,e.model FROM requests r JOIN customers c ON c.id=r.customer_id LEFT JOIN equipment e ON e.id=r.equipment_id WHERE r.deleted_at IS NULL AND r.status NOT IN('CLOSED','CANCELLED') AND r.engineer_id IS NULL${unassignedWhere} ORDER BY CASE WHEN r.priority='CRITICAL' THEN 0 ELSE 1 END,r.created_at`,unassignedParams)).rows.map(r=>{const eligible=engineers.filter(e=>e.branch_ids.includes(Number(r.branch_id))||Number(e.branch_id)===Number(r.branch_id)),ranked=rankForRequest(r,eligible,skillByEngineer);return{...r,candidates:ranked.slice(0,5),recommended_engineer:ranked[0]||null}});
 const summary={engineers:engineers.length,scheduled_jobs:engineers.reduce((a,x)=>a+x.scheduled_jobs,0),overloaded:engineers.filter(x=>x.overloaded).length,unassigned:unassigned.length,overdue_sla:engineers.reduce((a,x)=>a+x.overdue_sla,0),missed_visits:engineers.reduce((a,x)=>a+x.missed_visits,0)};
 return{generated_at:now.toISOString(),date,summary,engineers:engineers.sort((a,b)=>Number(a.overloaded)-Number(b.overloaded)||a.scheduled_jobs-b.scheduled_jobs||a.name.localeCompare(b.name,'ru')),unassigned,methodology:{working_day:'09:00–18:00',slot_minutes:90,max_daily_jobs:6,skill_window_days:180,load:'Загрузка учитывает назначенные выезды, активные заказы, просроченный SLA и пропущенные выезды.',recommendation:'Обычная заявка: 45% загрузка, 40% опыт категории, 15% ближайшее окно. Критичная: 35% загрузка, 30% опыт, 35% ближайшее окно.'}};
}

export function installEngineerCapacityAnalytics(app,pool,{operationsView,branchIds=resolveEngineerCapacityBranchIds}={}){
 app.get('/api/v1/engineer-capacity',{preHandler:operationsView},async(req,reply)=>{
  try{const allowed=await branchIds(pool,req.user),requested=req.query?.branch_id?Number(req.query.branch_id):null;if(requested&&(!Number.isSafeInteger(requested)||requested<1))throw businessError('VALIDATION','Некорректный филиал',422);return{data:await buildEngineerCapacityAnalytics(pool,{branchIds:allowed,branchId:requested,date:req.query?.date})}}catch(error){return fail(reply,error)}
 });
}
