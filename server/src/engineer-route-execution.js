const TZ='Asia/Qostanay';
const LATE_THRESHOLD_MINUTES=15;
const globalRoles=new Set(['OWNER','SUPERVISOR']);
const businessError=(code,message,statusCode=409,details)=>Object.assign(new Error(message),{code,statusCode,details});
const fail=(reply,error)=>reply.code(error?.statusCode||422).send({data:null,error:{code:error?.code||'VALIDATION',message:error?.message||'Ошибка контроля маршрута',details:error?.details}});
const validDate=v=>/^\d{4}-\d{2}-\d{2}$/.test(String(v||''));
const dateMs=v=>v?new Date(v).getTime():null;
const iso=v=>Number.isFinite(v)?new Date(v).toISOString():null;
const minutes=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)?Math.round((a-b)/60000):null;

export async function resolveEngineerRouteExecutionBranchIds(pool,user){
 if(!user||globalRoles.has(user.role))return null;
 if(!['MANAGER','ENGINEER'].includes(user.role))return[];
 return(await pool.query('SELECT branch_id FROM user_branches WHERE user_id=$1 ORDER BY branch_id',[user.id])).rows.map(x=>Number(x.branch_id));
}
function assertScope(branchIds,branchId){
 const id=Number(branchId);
 if(!Number.isSafeInteger(id)||id<1)throw businessError('VALIDATION','Укажите филиал',422);
 if(Array.isArray(branchIds)&&!branchIds.map(Number).includes(id))throw businessError('FORBIDDEN','Филиал недоступен пользователю',403);
}
async function assertEngineer(db,engineerId,branchId){
 const id=Number(engineerId);
 if(!Number.isSafeInteger(id)||id<1)throw businessError('VALIDATION','Укажите инженера',422);
 const row=(await db.query(`SELECT u.id,u.name FROM users u JOIN user_branches ub ON ub.user_id=u.id AND ub.branch_id=$2 WHERE u.id=$1 AND u.role='ENGINEER' AND u.active=true LIMIT 1`,[id,Number(branchId)])).rows[0];
 if(!row)throw businessError('INVALID_ENGINEER','Инженер не относится к выбранному филиалу',422);
 return row;
}
function projectedStops(rows,now){
 const nowMs=now.getTime();let availableAt=null;
 return rows.map((row,index)=>{
  const planned=dateMs(row.planned_at),travel=Math.max(0,Number(row.travel_minutes||0)),duration=Math.max(15,Number(row.duration_minutes||90));
  const plannedDeparture=Number.isFinite(planned)?planned-travel*60000:null;
  const departed=dateMs(row.departed_at),arrived=dateMs(row.arrived_at);
  let state='PENDING',eta=planned;
  if(Number.isFinite(arrived)){state='ARRIVED';eta=arrived;}
  else if(Number.isFinite(departed)){state='ON_ROUTE';eta=departed+travel*60000;}
  else{
   if(Number.isFinite(availableAt)&&Number.isFinite(planned))eta=Math.max(planned,availableAt+travel*60000);
   else if(Number.isFinite(planned)&&nowMs>planned)eta=nowMs;
  }
  if(Number.isFinite(eta))availableAt=eta+duration*60000;
  const arrivalDelay=minutes(eta,planned),departureDelay=minutes(departed,plannedDeparture);
  const overdueUnstarted=state==='PENDING'&&Number.isFinite(planned)&&nowMs>planned+LATE_THRESHOLD_MINUTES*60000;
  const atRisk=state!=='ARRIVED'&&Number(arrivalDelay)>LATE_THRESHOLD_MINUTES;
  return{
   id:Number(row.id),sequence_no:Number(row.sequence_no),request_id:Number(row.request_id),number:row.number||row.snapshot?.number||`#${row.request_id}`,
   request_status:row.request_status,customer_name:row.customer_name||row.snapshot?.customer_name||null,address:row.address||row.snapshot?.address||null,
   planned_at:row.planned_at,planned_departure_at:iso(plannedDeparture),duration_minutes:duration,travel_minutes:travel,
   departed_at:row.departed_at||null,arrived_at:row.arrived_at||null,projected_arrival_at:iso(eta),
   departure_delay_minutes:departureDelay,arrival_delay_minutes:arrivalDelay,execution_state:state,
   overdue_unstarted:overdueUnstarted,at_risk:atRisk,late:Number(arrivalDelay)>LATE_THRESHOLD_MINUTES,
   snapshot:row.snapshot||{},source:'CRM_WORKFLOW_EVENTS',position:index+1
  };
 });
}
function routeSummary(stops){
 const onRoute=stops.filter(x=>x.execution_state==='ON_ROUTE').length,arrived=stops.filter(x=>x.execution_state==='ARRIVED').length,pending=stops.filter(x=>x.execution_state==='PENDING').length;
 return{
  stops:stops.length,started:onRoute+arrived,on_route:onRoute,arrived,pending,
  late:stops.filter(x=>x.late).length,at_risk:stops.filter(x=>x.at_risk).length,
  overdue_unstarted:stops.filter(x=>x.overdue_unstarted).length,
  route_state:stops.length&&arrived===stops.length?'ALL_ARRIVED':onRoute||arrived?'ACTIVE':'PLANNED'
 };
}
export async function buildEngineerRouteExecution(db,{branchIds=null,branchId,engineerId,date,now=new Date()}={}){
 assertScope(branchIds,branchId);if(!validDate(date))throw businessError('VALIDATION','Дата должна быть YYYY-MM-DD',422);const engineer=await assertEngineer(db,engineerId,branchId);
 const branch=(await db.query('SELECT id,code,name,address FROM branches WHERE id=$1 AND active=true',[Number(branchId)])).rows[0];if(!branch)throw businessError('NOT_FOUND','Филиал не найден',404);
 const plan=(await db.query(`SELECT p.* FROM engineer_route_plans p WHERE p.engineer_id=$1 AND p.branch_id=$2 AND p.plan_date=$3::date AND p.status='PUBLISHED' ORDER BY p.revision DESC LIMIT 1`,[Number(engineerId),Number(branchId),date])).rows[0]||null;
 if(!plan)return{generated_at:now.toISOString(),date,branch,engineer,plan:null,summary:routeSummary([]),stops:[],current_stop:null,next_stop:null,methodology:{facts:'Фактические отметки берутся только из событий CRM Workflow DEPART/ARRIVE. GPS не используется.',eta:'ETA следующих визитов пересчитывается от фактического/расчётного прибытия предыдущей точки и опубликованной длительности визита.',risk:`Риск отмечается при прогнозном опоздании более ${LATE_THRESHOLD_MINUTES} минут.`}};
 const rows=(await db.query(`SELECT s.id,s.sequence_no,s.request_id,s.planned_at,s.duration_minutes,s.travel_minutes,s.snapshot,r.number,r.status request_status,c.name customer_name,c.address,
   (SELECT min(e.created_at) FROM request_stage_events e WHERE e.request_id=s.request_id AND e.event='DEPART' AND DATE(e.created_at AT TIME ZONE '${TZ}')=$2::date) departed_at,
   (SELECT min(e.created_at) FROM request_stage_events e WHERE e.request_id=s.request_id AND e.event='ARRIVE' AND DATE(e.created_at AT TIME ZONE '${TZ}')=$2::date) arrived_at
   FROM engineer_route_plan_stops s JOIN requests r ON r.id=s.request_id JOIN customers c ON c.id=r.customer_id
   WHERE s.plan_id=$1 ORDER BY s.sequence_no`,[plan.id,date])).rows;
 const stops=projectedStops(rows,now),summary=routeSummary(stops),started=stops.filter(x=>x.execution_state!=='PENDING'),current=started.length?started[started.length-1]:stops.find(x=>x.execution_state==='PENDING')||null;
 const next=current?stops.find(x=>x.sequence_no>current.sequence_no&&x.execution_state==='PENDING')||null:null;
 return{generated_at:now.toISOString(),date,branch,engineer,plan,summary,stops,current_stop:current,next_stop:next,methodology:{facts:'Фактические отметки берутся только из событий CRM Workflow DEPART/ARRIVE. GPS не используется.',eta:'ETA следующих визитов пересчитывается от фактического/расчётного прибытия предыдущей точки и опубликованной длительности визита.',risk:`Риск отмечается при прогнозном опоздании более ${LATE_THRESHOLD_MINUTES} минут.`}};
}
export async function buildBranchRouteExecution(db,{branchIds=null,branchId,date,engineerId=null,now=new Date()}={}){
 assertScope(branchIds,branchId);if(!validDate(date))throw businessError('VALIDATION','Дата должна быть YYYY-MM-DD',422);
 let ids=[];
 if(engineerId!=null&&String(engineerId)!=='')ids=[Number(engineerId)];
 else ids=(await db.query(`SELECT DISTINCT engineer_id FROM engineer_route_plans WHERE branch_id=$1 AND plan_date=$2::date AND status='PUBLISHED' ORDER BY engineer_id`,[Number(branchId),date])).rows.map(x=>Number(x.engineer_id));
 const routes=[];for(const id of ids){const route=await buildEngineerRouteExecution(db,{branchIds,branchId,engineerId:id,date,now});if(route.plan)routes.push(route)}
 const stops=routes.flatMap(x=>x.stops),branch=(await db.query('SELECT id,code,name,address FROM branches WHERE id=$1 AND active=true',[Number(branchId)])).rows[0]||null;
 return{generated_at:now.toISOString(),date,branch,summary:{routes:routes.length,stops:stops.length,active:routes.filter(x=>x.summary.route_state==='ACTIVE').length,all_arrived:routes.filter(x=>x.summary.route_state==='ALL_ARRIVED').length,on_route:stops.filter(x=>x.execution_state==='ON_ROUTE').length,arrived:stops.filter(x=>x.execution_state==='ARRIVED').length,late:stops.filter(x=>x.late).length,at_risk:stops.filter(x=>x.at_risk).length,overdue_unstarted:stops.filter(x=>x.overdue_unstarted).length},routes};
}
export function installEngineerRouteExecution(app,pool,{operationsView,routeView=operationsView,branchIdsResolver=resolveEngineerRouteExecutionBranchIds}={}){
 app.get('/api/v1/engineer-route/execution',{preHandler:routeView},async(req,reply)=>{try{
  const branches=await branchIdsResolver(pool,req.user),branchId=Number(req.query?.branch_id),date=String(req.query?.date||''),asked=req.query?.engineer_id==null?null:Number(req.query.engineer_id);
  if(req.user?.role==='ENGINEER'){
   if(asked!=null&&Number(req.user.id)!==asked)throw businessError('FORBIDDEN','Инженер видит только свой маршрут',403);
   return{data:await buildBranchRouteExecution(pool,{branchIds:branches,branchId,date,engineerId:Number(req.user.id)})};
  }
  return{data:await buildBranchRouteExecution(pool,{branchIds:branches,branchId,date,engineerId:asked})};
 }catch(e){return fail(reply,e)}});
}
