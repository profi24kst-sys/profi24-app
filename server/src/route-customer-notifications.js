import {buildBranchRouteExecution} from './engineer-route-execution.js';

export const ROUTE_DELAY_THRESHOLD_MINUTES=15;
export const ROUTE_CUSTOMER_NOTICE_WINDOW_MINUTES=120;
export const ROUTE_NOTIFICATION_TEMPLATES=[
 ['CUSTOMER_ENGINEER_DEPARTED','Инженер выехал','CUSTOMER','WHATSAPP','{{customer_name}}, инженер {{engineer_name}} выехал по заявке {{request_number}}. Ожидайте его по согласованному адресу. Плановое время визита: {{scheduled_at}}.'],
 ['CUSTOMER_ROUTE_DELAY','Возможна задержка инженера','CUSTOMER','WHATSAPP','{{customer_name}}, по заявке {{request_number}} возможна задержка инженера примерно на {{delay_minutes}} мин. Текущий прогноз прибытия: {{eta}}. Приносим извинения — визит остаётся под контролем PROFI24KST.']
];

export function routeLocalDate(value=new Date()){
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Qostanay',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
 return `${p.year}-${p.month}-${p.day}`;
}
export function routeNotificationTime(value){
 return value?new Date(value).toLocaleString('ru-RU',{timeZone:'Asia/Qostanay',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'не рассчитано';
}
export function selectRouteDelayAlerts(board,{now=new Date(),windowMinutes=ROUTE_CUSTOMER_NOTICE_WINDOW_MINUTES}={}){
 const nowMs=new Date(now).getTime(),windowMs=Math.max(0,Number(windowMinutes||0))*60000,out=[];
 for(const route of board?.routes||[]){
  if(route?.summary?.route_state!=='ACTIVE'||!route?.plan?.id)continue;
  for(const stop of route.stops||[]){
   const delay=Number(stop.arrival_delay_minutes||0),planned=stop.planned_at?new Date(stop.planned_at).getTime():NaN;
   if(stop.execution_state==='ARRIVED'||!stop.at_risk||delay<=ROUTE_DELAY_THRESHOLD_MINUTES)continue;
   const dueSoon=Number.isFinite(planned)&&planned<=nowMs+windowMs;
   if(stop.execution_state!=='ON_ROUTE'&&!dueSoon)continue;
   out.push({
    plan_id:Number(route.plan.id),plan_revision:Number(route.plan.revision||0),branch_id:Number(route.branch?.id||board?.branch?.id||0),engineer_id:Number(route.engineer?.id||0),
    request_id:Number(stop.request_id),request_number:stop.number,execution_state:stop.execution_state,planned_at:stop.planned_at,projected_arrival_at:stop.projected_arrival_at,
    arrival_delay_minutes:delay,dedupe_key:`route-delay:${route.plan.id}:${stop.request_id}`
   });
  }
 }
 return out;
}

export function createRouteCustomerNotificationSync(pool,{enqueue,requestData,render,vars,routeBuilder=buildBranchRouteExecution,logger=null}={}){
 if(!pool?.query||!enqueue||!requestData||!render||!vars)throw new Error('Route notification sync dependencies are required');
 async function seed(){
  for(const s of ROUTE_NOTIFICATION_TEMPLATES)await pool.query(`INSERT INTO message_templates(code,name,audience,channel,body) VALUES($1,$2,$3,$4,$5) ON CONFLICT(code) DO NOTHING`,s);
 }
 async function sync(now=new Date()){
  const date=routeLocalDate(now),branches=(await pool.query(`SELECT DISTINCT branch_id FROM engineer_route_plans WHERE plan_date=$1::date AND status='PUBLISHED' ORDER BY branch_id`,[date])).rows;
  let candidates=0,queued=0,skipped=0,failed_branches=0;
  for(const b of branches){
   try{
    const board=await routeBuilder(pool,{branchId:Number(b.branch_id),date,now});
    for(const alert of selectRouteDelayAlerts(board,{now})){
     candidates++;
     const x=await requestData(alert.request_id);if(!x){skipped++;continue;}
     const t=(await pool.query(`SELECT body FROM message_templates WHERE code='CUSTOMER_ROUTE_DELAY' AND active=true LIMIT 1`)).rows[0];if(!t){skipped++;continue;}
     const body=render(t.body,{...vars(x),eta:routeNotificationTime(alert.projected_arrival_at),delay_minutes:Math.max(16,Math.round(alert.arrival_delay_minutes))});
     const m=await enqueue({request_id:alert.request_id,template_code:'CUSTOMER_ROUTE_DELAY',audience:'CUSTOMER',dedupe_key:alert.dedupe_key,body});
     if(m)queued++;else skipped++;
    }
   }catch(error){failed_branches++;logger?.error?.({error,branch_id:Number(b.branch_id)},'route customer notification sync failed');}
  }
  return{date,branches:branches.length,candidates,queued,skipped,failed_branches};
 }
 return{seed,sync};
}
