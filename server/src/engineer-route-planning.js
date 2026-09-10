const TZ='Asia/Qostanay';
const METHOD='route-v1-fixed-appointments';
const ROAD_FACTOR=1.25;
const AVG_CITY_SPEED_KMH=28;
const SERVICE_MINUTES=90;
const globalRoles=new Set(['OWNER','SUPERVISOR']);
const clamp=(v,min,max)=>Math.min(max,Math.max(min,v));
const businessError=(code,message,statusCode=409,details)=>Object.assign(new Error(message),{code,statusCode,details});
const fail=(reply,error)=>reply.code(error?.statusCode||422).send({data:null,error:{code:error?.code||'VALIDATION',message:error?.message||'Ошибка построения маршрута',details:error?.details}});
const validDate=v=>/^\d{4}-\d{2}-\d{2}$/.test(String(v||''));
const coord=v=>v==null||v===''?null:Number(v);
const hasCoord=x=>Number.isFinite(coord(x?.latitude))&&Number.isFinite(coord(x?.longitude));
const rad=x=>x*Math.PI/180;
function localDate(value){const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`}

function haversineKm(a,b){
 if(!hasCoord(a)||!hasCoord(b))return null;
 const lat1=rad(coord(a.latitude)),lat2=rad(coord(b.latitude)),dLat=lat2-lat1,dLon=rad(coord(b.longitude)-coord(a.longitude));
 const h=Math.sin(dLat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
 return 6371*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h))*ROAD_FACTOR;
}
function travelMinutes(km){if(km==null)return null;if(km<=0.05)return 0;return Math.max(5,Math.ceil(km/AVG_CITY_SPEED_KMH*60))}
function priorityScore(x,now){
 let score=String(x.priority||'NORMAL')==='CRITICAL'?100:String(x.priority||'NORMAL')==='HIGH'?70:40;
 if(x.original_request_id)score+=20;
 if(x.sla_deadline){const h=(new Date(x.sla_deadline)-now)/36e5;if(h<0)score+=50;else if(h<=4)score+=30;else if(h<=12)score+=15}
 if(x.status==='ACCEPTED'||x.status==='DIAGNOSTICS')score+=10;
 return score;
}
function reasonFor(x,score,now){const bits=[`время выезда ${new Date(x.scheduled_at).toLocaleTimeString('ru-RU',{timeZone:TZ,hour:'2-digit',minute:'2-digit'})}`];if(x.priority==='CRITICAL')bits.push('критичный приоритет');else if(x.priority==='HIGH')bits.push('высокий приоритет');if(x.original_request_id)bits.push('повторный/связанный ремонт');if(x.sla_deadline&&new Date(x.sla_deadline)<now)bits.push('SLA просрочен');return `${bits.join(', ')}; приоритет ${score}.`}

async function allowedBranches(pool,user){
 if(!user||globalRoles.has(user.role))return null;
 if(!['MANAGER','ENGINEER'].includes(user.role))return[];
 return(await pool.query('SELECT branch_id FROM user_branches WHERE user_id=$1 ORDER BY branch_id',[user.id])).rows.map(x=>Number(x.branch_id));
}
function assertScope(branchIds,branchId){if(!Number.isSafeInteger(Number(branchId))||Number(branchId)<1)throw businessError('VALIDATION','Укажите филиал',422);if(Array.isArray(branchIds)&&!branchIds.map(Number).includes(Number(branchId)))throw businessError('FORBIDDEN','Филиал недоступен пользователю',403)}
async function assertEngineer(db,engineerId,branchId){
 const id=Number(engineerId);if(!Number.isSafeInteger(id)||id<1)throw businessError('VALIDATION','Укажите инженера',422);
 const row=(await db.query(`SELECT u.id,u.name FROM users u JOIN user_branches ub ON ub.user_id=u.id AND ub.branch_id=$2 WHERE u.id=$1 AND u.role='ENGINEER' AND u.active=true LIMIT 1`,[id,Number(branchId)])).rows[0];
 if(!row)throw businessError('INVALID_ENGINEER','Инженер не относится к выбранному филиалу',422);return row;
}

export async function buildEngineerRouteSuggestion(db,{branchIds=null,branchId,engineerId,date,now=new Date()}={}){
 assertScope(branchIds,branchId);if(!validDate(date))throw businessError('VALIDATION','Дата должна быть YYYY-MM-DD',422);const engineer=await assertEngineer(db,engineerId,branchId);
 const branch=(await db.query('SELECT id,code,name,address,latitude,longitude FROM branches WHERE id=$1 AND active=true',[Number(branchId)])).rows[0];if(!branch)throw businessError('NOT_FOUND','Филиал не найден',404);
 const rows=(await db.query(`SELECT r.id,r.number,r.status,r.priority,r.scheduled_at,r.sla_deadline,r.original_request_id,r.complaint,r.visit_type,c.id customer_id,c.name customer_name,c.phone,c.address,c.latitude,c.longitude,c.location_verified_at,e.category,e.brand,e.model
   FROM requests r JOIN customers c ON c.id=r.customer_id LEFT JOIN equipment e ON e.id=r.equipment_id
   WHERE r.deleted_at IS NULL AND r.engineer_id=$1 AND r.branch_id=$2 AND r.status NOT IN('CLOSED','CANCELLED')
     AND COALESCE(r.visit_type,'FIELD')='FIELD' AND r.scheduled_at IS NOT NULL
     AND DATE(r.scheduled_at AT TIME ZONE '${TZ}')=$3::date
   ORDER BY r.scheduled_at,r.id`,[Number(engineerId),Number(branchId),date])).rows;
 const backlog=(await db.query(`SELECT r.id,r.number,r.status,r.priority,r.sla_deadline,r.original_request_id,r.created_at,r.complaint,c.id customer_id,c.name customer_name,c.address,c.latitude,c.longitude,e.category,e.brand,e.model
   FROM requests r JOIN customers c ON c.id=r.customer_id LEFT JOIN equipment e ON e.id=r.equipment_id
   WHERE r.deleted_at IS NULL AND r.engineer_id=$1 AND r.branch_id=$2 AND r.status NOT IN('CLOSED','CANCELLED')
     AND COALESCE(r.visit_type,'FIELD')='FIELD' AND r.scheduled_at IS NULL
   ORDER BY CASE WHEN r.priority='CRITICAL' THEN 0 WHEN r.priority='HIGH' THEN 1 ELSE 2 END,r.created_at LIMIT 50`,[Number(engineerId),Number(branchId)])).rows;
 let prev=hasCoord(branch)?branch:null,totalDistance=0,totalTravel=0,unresolved=0,previousEnd=null;
 const stops=rows.map((x,i)=>{
   const score=priorityScore(x,now),resolved=hasCoord(x),km=prev&&resolved?haversineKm(prev,x):null,travel=travelMinutes(km),planned=new Date(x.scheduled_at),arrivalRisk=previousEnd&&travel!=null?new Date(previousEnd.getTime()+travel*60000)>planned:false;
   if(km!=null)totalDistance+=km;if(travel!=null)totalTravel+=travel;if(!resolved)unresolved++;
   const stop={sequence_no:i+1,request_id:Number(x.id),number:x.number,status:x.status,priority:x.priority,customer_id:Number(x.customer_id),customer_name:x.customer_name,phone:x.phone,address:x.address,category:x.category,brand:x.brand,model:x.model,planned_at:x.scheduled_at,duration_minutes:SERVICE_MINUTES,latitude:coord(x.latitude),longitude:coord(x.longitude),location_status:resolved?'RESOLVED':'UNRESOLVED',location_verified_at:x.location_verified_at,fixed_appointment:true,distance_from_previous_km:km==null?0:Number(km.toFixed(2)),travel_minutes:travel||0,travel_estimate_available:km!=null,arrival_risk:arrivalRisk,priority_score:score,reason:reasonFor(x,score,now)};
   previousEnd=new Date(planned.getTime()+SERVICE_MINUTES*60000);prev=resolved?x:null;return stop;
 });
 const routePoints=[branch,...stops].filter(hasCoord);
 const backlogCandidates=backlog.map(x=>{const score=priorityScore(x,now),distances=routePoints.map(p=>haversineKm(p,x)).filter(v=>v!=null),near=distances.length?Math.min(...distances):null,rank=score+(near==null?0:clamp(30-near*2,0,30));return{request_id:Number(x.id),number:x.number,priority:x.priority,customer_name:x.customer_name,address:x.address,category:x.category,latitude:coord(x.latitude),longitude:coord(x.longitude),location_status:hasCoord(x)?'RESOLVED':'UNRESOLVED',nearest_route_km:near==null?null:Number(near.toFixed(2)),candidate_score:Number(rank.toFixed(1)),reason:`Не назначено время. ${near==null?'Нет координат для оценки близости.':`До ближайшей точки маршрута примерно ${near.toFixed(1)} км.`} Требуется согласовать время с клиентом перед добавлением.`}}).sort((a,b)=>b.candidate_score-a.candidate_score).slice(0,8);
 const latest=(await db.query(`SELECT id,revision,created_at,total_distance_km,total_travel_minutes,unresolved_locations FROM engineer_route_plans WHERE engineer_id=$1 AND branch_id=$2 AND plan_date=$3::date ORDER BY revision DESC LIMIT 1`,[Number(engineerId),Number(branchId),date])).rows[0]||null;
 return{generated_at:now.toISOString(),method_version:METHOD,date,branch,engineer,summary:{stops:stops.length,total_distance_km:Number(totalDistance.toFixed(2)),total_travel_minutes:totalTravel,unresolved_locations:unresolved,arrival_risks:stops.filter(x=>x.arrival_risk).length,backlog_candidates:backlogCandidates.length},stops,backlog_candidates:backlogCandidates,latest_published:latest,methodology:{appointments:'Назначенное клиенту scheduled_at считается фиксированным: CRM не переставляет его молча.',distance:'Расстояние — расчётная географическая оценка: haversine × 1.25. Это не дорожный трафик и не заменяет навигатор.',travel:`Расчётное время движения использует среднюю городскую скорость ${AVG_CITY_SPEED_KMH} км/ч и минимум 5 минут между разными точками.`,backlog:'Заявки без времени показываются только как кандидаты на дозагрузку; перед добавлением нужно согласовать время с клиентом.'}};
}

async function tx(pool,fn){const c=await pool.connect();try{await c.query('BEGIN');const out=await fn(c);await c.query('COMMIT');return out}catch(e){try{await c.query('ROLLBACK')}catch{}throw e}finally{c.release()}}
export async function publishEngineerRoutePlan(pool,{branchIds=null,branchId,engineerId,date,actorId,now=new Date()}={}){
 return tx(pool,async c=>{
   assertScope(branchIds,branchId);if(!validDate(date))throw businessError('VALIDATION','Дата должна быть YYYY-MM-DD',422);await assertEngineer(c,engineerId,branchId);
   await c.query(`SELECT id FROM requests WHERE engineer_id=$1 AND branch_id=$2 AND deleted_at IS NULL AND status NOT IN('CLOSED','CANCELLED') AND COALESCE(visit_type,'FIELD')='FIELD' FOR UPDATE`,[Number(engineerId),Number(branchId)]);
   await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[Number(engineerId)]);
   const suggestion=await buildEngineerRouteSuggestion(c,{branchIds,branchId,engineerId,date,now});if(!suggestion.stops.length)throw businessError('NO_STOPS','На выбранный день нет назначенных выездов',409);
   const current=(await c.query('SELECT id,revision FROM engineer_route_plans WHERE engineer_id=$1 AND branch_id=$2 AND plan_date=$3::date ORDER BY revision DESC LIMIT 1 FOR UPDATE',[Number(engineerId),Number(branchId),date])).rows[0];const rev=Number(current?.revision||0)+1;
   const snapshot={generated_at:suggestion.generated_at,method_version:suggestion.method_version,request_ids:suggestion.stops.map(x=>x.request_id),scheduled_at:suggestion.stops.map(x=>[x.request_id,x.planned_at])};
   const plan=(await c.query(`INSERT INTO engineer_route_plans(plan_date,engineer_id,branch_id,revision,method_version,total_distance_km,total_travel_minutes,unresolved_locations,generated_by,source_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[date,Number(engineerId),Number(branchId),rev,METHOD,suggestion.summary.total_distance_km,suggestion.summary.total_travel_minutes,suggestion.summary.unresolved_locations,Number(actorId),snapshot])).rows[0];
   for(const s of suggestion.stops)await c.query(`INSERT INTO engineer_route_plan_stops(plan_id,sequence_no,request_id,planned_at,duration_minutes,latitude,longitude,location_status,fixed_appointment,distance_from_previous_km,travel_minutes,priority_score,reason,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[plan.id,s.sequence_no,s.request_id,s.planned_at,s.duration_minutes,s.latitude,s.longitude,s.location_status,true,s.distance_from_previous_km,s.travel_minutes,s.priority_score,s.reason,{number:s.number,status:s.status,priority:s.priority,customer_name:s.customer_name,address:s.address,category:s.category,brand:s.brand,model:s.model,arrival_risk:s.arrival_risk}]);
   return{plan,stops:suggestion.stops};
 });
}

export async function updateRouteCustomerLocation(pool,{branchIds=null,branchId,customerId,latitude,longitude,actorId}={}){
 assertScope(branchIds,branchId);const id=Number(customerId),lat=Number(latitude),lng=Number(longitude);if(!Number.isSafeInteger(id)||id<1||!Number.isFinite(lat)||lat<-90||lat>90||!Number.isFinite(lng)||lng<-180||lng>180)throw businessError('VALIDATION','Некорректные координаты',422);
 return tx(pool,async c=>{const allowed=(await c.query('SELECT 1 FROM requests WHERE customer_id=$1 AND branch_id=$2 AND deleted_at IS NULL LIMIT 1',[id,Number(branchId)])).rows[0];if(!allowed)throw businessError('FORBIDDEN','Клиент не относится к выбранному филиалу',403);const before=(await c.query('SELECT id,name,address,latitude,longitude,location_source,location_verified_at FROM customers WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id])).rows[0];if(!before)throw businessError('NOT_FOUND','Клиент не найден',404);const row=(await c.query(`UPDATE customers SET latitude=$1,longitude=$2,location_source='MANUAL',location_verified_at=now(),updated_at=now() WHERE id=$3 RETURNING id,name,address,latitude,longitude,location_source,location_verified_at`,[lat,lng,id])).rows[0];await c.query('INSERT INTO engineer_route_location_audit(customer_id,branch_id,actor_id,before_location,after_location) VALUES($1,$2,$3,$4,$5)',[id,Number(branchId),Number(actorId),{latitude:before.latitude,longitude:before.longitude,source:before.location_source,verified_at:before.location_verified_at},{latitude:row.latitude,longitude:row.longitude,source:row.location_source,verified_at:row.location_verified_at}]);return row})
}

export function installEngineerRoutePlanning(app,pool,{operationsView,routeView=operationsView,branchIdsResolver=allowedBranches}={}){
 app.get('/api/v1/engineer-route/suggest',{preHandler:operationsView},async(req,reply)=>{try{const branches=await branchIdsResolver(pool,req.user);return{data:await buildEngineerRouteSuggestion(pool,{branchIds:branches,branchId:Number(req.query?.branch_id),engineerId:Number(req.query?.engineer_id),date:req.query?.date})}}catch(e){return fail(reply,e)}});
 app.get('/api/v1/engineer-route/published',{preHandler:routeView},async(req,reply)=>{try{const branches=await branchIdsResolver(pool,req.user),branchId=Number(req.query?.branch_id),engineerId=Number(req.query?.engineer_id),date=String(req.query?.date||'');if(req.user?.role==='ENGINEER'&&Number(req.user.id)!==engineerId)throw businessError('FORBIDDEN','Инженер может просматривать только свой маршрут',403);assertScope(branches,branchId);if(!validDate(date))throw businessError('VALIDATION','Дата должна быть YYYY-MM-DD',422);await assertEngineer(pool,engineerId,branchId);const plan=(await pool.query('SELECT * FROM engineer_route_plans WHERE engineer_id=$1 AND branch_id=$2 AND plan_date=$3::date ORDER BY revision DESC LIMIT 1',[engineerId,branchId,date])).rows[0];if(!plan)return{data:null};const stops=(await pool.query('SELECT * FROM engineer_route_plan_stops WHERE plan_id=$1 ORDER BY sequence_no',[plan.id])).rows;return{data:{plan,stops}}}catch(e){return fail(reply,e)}});
 app.post('/api/v1/engineer-route/publish',{preHandler:operationsView},async(req,reply)=>{try{const branches=await branchIdsResolver(pool,req.user),branchId=Number(req.body?.branch_id),engineerId=Number(req.body?.engineer_id),date=String(req.body?.date||'');const data=await publishEngineerRoutePlan(pool,{branchIds:branches,branchId,engineerId,date,actorId:req.user.id});return reply.code(201).send({data})}catch(e){return fail(reply,e)}});
 app.put('/api/v1/engineer-route/customers/:id/location',{preHandler:operationsView},async(req,reply)=>{try{const branches=await branchIdsResolver(pool,req.user),data=await updateRouteCustomerLocation(pool,{branchIds:branches,branchId:Number(req.body?.branch_id),customerId:Number(req.params.id),latitude:req.body?.latitude,longitude:req.body?.longitude,actorId:req.user.id});return{data}}catch(e){return fail(reply,e)}});
}

export {allowedBranches as resolveEngineerRouteBranchIds,haversineKm,travelMinutes,localDate};
