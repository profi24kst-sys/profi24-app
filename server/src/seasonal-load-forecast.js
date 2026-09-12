const GLOBAL_ROLES=new Set(['OWNER','SUPERVISOR']);
const DEFAULT_HISTORY_MONTHS=24;
const DEFAULT_HORIZON_MONTHS=3;
const WORKING_DAYS_PER_MONTH=22;
const MAX_DAILY_JOBS=6;
const CAPACITY_WINDOW_MONTHS=12;
const round=(value,digits=1)=>Number(Number(value||0).toFixed(digits));
const n=value=>Number(value||0);
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
const businessError=(code,message,statusCode=422)=>Object.assign(new Error(message),{code,statusCode});
const fail=(reply,error)=>reply.code(error?.statusCode||422).send({data:null,error:{code:error?.code||'VALIDATION',message:error?.message||'Ошибка сезонного прогноза'}});

function monthStart(date){return new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1))}
function addMonths(date,months){return new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+months,1))}
function monthKey(date){return date.toISOString().slice(0,7)}
function average(values){return values.length?values.reduce((sum,value)=>sum+n(value),0)/values.length:0}
function integer(value,{name,min,max,fallback}){if(value===undefined||value===null||value==='')return fallback;const parsed=Number(value);if(!Number.isSafeInteger(parsed)||parsed<min||parsed>max)throw businessError('VALIDATION',`${name}: допустимо от ${min} до ${max}`);return parsed}
function dateValue(value,now){if(!value)return now;const date=/^\d{4}-\d{2}-\d{2}$/.test(String(value))?new Date(`${value}T00:00:00Z`):new Date(value);if(Number.isNaN(date.getTime()))throw businessError('VALIDATION','Некорректная дата as_of');return date}
function key(branchId,category){return `${Number(branchId)}\u0000${String(category)}`}

function forecastPoint(values,targetIndex){
 const history=values.slice(0,targetIndex),recent=average(history.slice(-3)),seasonal=targetIndex>=12?n(values[targetIndex-12]):null;
 return Math.max(0,Math.round(seasonal===null?recent:seasonal*.65+recent*.35));
}

function errorMetrics(points){
 const count=points.length,absoluteError=points.reduce((sum,x)=>sum+Math.abs(x.forecast-x.actual),0),actual=points.reduce((sum,x)=>sum+x.actual,0);
 const wape=actual?absoluteError/actual*100:null,mae=count?absoluteError/count:null;
 return{points:count,mae:mae===null?null:round(mae),wape_pct:wape===null?null:round(wape),accuracy_pct:wape===null?null:round(clamp(100-wape,0,100))};
}

function confidence({months,total,error}){
 if(months>=18&&total>=24&&error.points>=4&&error.wape_pct!==null&&error.wape_pct<=30)return'HIGH';
 if(months>=12&&total>=12&&error.points>=3&&error.wape_pct!==null&&error.wape_pct<=60)return'MEDIUM';
 return'LOW';
}

function scopeSql(alias,branchIds,branchId,params){
 const where=[];
 if(Array.isArray(branchIds)){if(!branchIds.length)return{empty:true,where};params.push(branchIds.map(Number));where.push(`${alias}.branch_id=ANY($${params.length}::int[])`)}
 if(branchId){params.push(Number(branchId));where.push(`${alias}.branch_id=$${params.length}`)}
 return{empty:false,where};
}

function emptyResult({now,asOf,historyStart,forecastStart,historyMonths,horizonMonths}){
 const months=Array.from({length:horizonMonths},(_,index)=>({month:monthKey(addMonths(forecastStart,index)),forecast_orders:0,monthly_capacity:0,gap:0,utilization_pct:0,risk:'OK'}));
 return{generated_at:now.toISOString(),as_of:asOf.toISOString(),history:{from:historyStart.toISOString(),to_exclusive:forecastStart.toISOString(),complete_months:historyMonths,orders:0},horizon_months:horizonMonths,summary:{forecast_orders:0,monthly_capacity:0,projected_gap:0,overloaded_specialties:0,backtest:{points:0,mae:null,wape_pct:null,accuracy_pct:null},data_quality:'LOW'},months,specialties:[],capacity:{classified_engineers:0,unclassified_engineers:0},methodology:methodology()};
}

function methodology(){return{
 demand:'Спрос — созданные в CRM, не удалённые и не отменённые заявки по месяцу, филиалу и категории техники.',
 forecast:'65% спроса того же месяца прошлого года + 35% среднего за последние 3 полных месяца. Текущий неполный месяц не используется как факт.',
 error:'WAPE и MAE рассчитаны обратной проверкой на последних 6 полных месяцах. Accuracy = max(0, 100 − WAPE).',
 capacity:`Мощность: ${WORKING_DAYS_PER_MONTH} рабочих дня × ${MAX_DAILY_JOBS} заказов в день на активного инженера; распределяется между категориями и филиалами пропорционально его закрытым заказам за ${CAPACITY_WINDOW_MONTHS} месяцев.`,
 warning:'LOW означает недостаток истории, объёма или высокую ошибку. Такой прогноз нельзя использовать как единственное основание для найма.'
}}

export async function resolveSeasonalForecastBranchIds(pool,user){
 if(!user||GLOBAL_ROLES.has(user.role))return null;
 if(user.role!=='MANAGER')return[];
 return(await pool.query('SELECT branch_id FROM user_branches WHERE user_id=$1 ORDER BY branch_id',[user.id])).rows.map(row=>Number(row.branch_id));
}

export async function buildSeasonalLoadForecast(db,{branchIds=null,branchId=null,asOf,historyMonths=DEFAULT_HISTORY_MONTHS,horizonMonths=DEFAULT_HORIZON_MONTHS,now=new Date()}={}){
 historyMonths=integer(historyMonths,{name:'history_months',min:12,max:36,fallback:DEFAULT_HISTORY_MONTHS});
 horizonMonths=integer(horizonMonths,{name:'horizon_months',min:1,max:12,fallback:DEFAULT_HORIZON_MONTHS});
 if(branchId&&(!Number.isSafeInteger(Number(branchId))||Number(branchId)<1))throw businessError('VALIDATION','Некорректный филиал');
 if(branchId&&Array.isArray(branchIds)&&!branchIds.map(Number).includes(Number(branchId)))throw businessError('FORBIDDEN','Филиал недоступен пользователю',403);
 const resolvedAsOf=dateValue(asOf,now),forecastStart=monthStart(resolvedAsOf),historyStart=addMonths(forecastStart,-historyMonths),capacityStart=addMonths(forecastStart,-CAPACITY_WINDOW_MONTHS);
 const demandParams=[historyStart.toISOString(),forecastStart.toISOString()],demandScope=scopeSql('r',branchIds,branchId,demandParams);
 if(demandScope.empty)return emptyResult({now,asOf:resolvedAsOf,historyStart,forecastStart,historyMonths,horizonMonths});
 const demandWhere=demandScope.where.length?' AND '+demandScope.where.join(' AND '):'';
 const demandRows=(await db.query(`SELECT r.branch_id,b.name branch_name,COALESCE(NULLIF(trim(e.category),''),'Без категории') category,r.created_at FROM requests r JOIN branches b ON b.id=r.branch_id LEFT JOIN equipment e ON e.id=r.equipment_id WHERE r.deleted_at IS NULL AND r.status<>'CANCELLED' AND r.created_at>=$1::timestamptz AND r.created_at<$2::timestamptz${demandWhere}` ,demandParams)).rows;
 const capacityParams=[capacityStart.toISOString(),forecastStart.toISOString()],capacityScope=scopeSql('r',branchIds,branchId,capacityParams),capacityWhere=capacityScope.where.length?' AND '+capacityScope.where.join(' AND '):'';
 const capacityRows=capacityScope.empty?[]:(await db.query(`SELECT r.branch_id,b.name branch_name,r.engineer_id,u.name engineer_name,COALESCE(NULLIF(trim(e.category),''),'Без категории') category,count(*)::int jobs FROM requests r JOIN branches b ON b.id=r.branch_id JOIN users u ON u.id=r.engineer_id AND u.role='ENGINEER' AND u.active=true LEFT JOIN equipment e ON e.id=r.equipment_id WHERE r.deleted_at IS NULL AND r.status='CLOSED' AND r.closed_at>=$1::timestamptz AND r.closed_at<$2::timestamptz${capacityWhere} GROUP BY r.branch_id,b.name,r.engineer_id,u.name,COALESCE(NULLIF(trim(e.category),''),'Без категории')`,capacityParams)).rows;
 const engineerParams=[],engineerScope=[];
 if(Array.isArray(branchIds)){engineerParams.push(branchIds.map(Number));engineerScope.push(`COALESCE(ub.branch_id,u.primary_branch_id)=ANY($${engineerParams.length}::int[])`)}
 if(branchId){engineerParams.push(Number(branchId));engineerScope.push(`COALESCE(ub.branch_id,u.primary_branch_id)=$${engineerParams.length}`)}
 const engineerRows=(await db.query(`SELECT DISTINCT u.id,COALESCE(ub.branch_id,u.primary_branch_id) branch_id FROM users u LEFT JOIN user_branches ub ON ub.user_id=u.id WHERE u.role='ENGINEER' AND u.active=true AND COALESCE(ub.branch_id,u.primary_branch_id) IS NOT NULL${engineerScope.length?' AND '+engineerScope.join(' AND '):''}`,engineerParams)).rows;

 const historyKeys=Array.from({length:historyMonths},(_,index)=>monthKey(addMonths(historyStart,index))),series=new Map();
 for(const row of demandRows){const category=String(row.category),seriesKey=key(row.branch_id,category),month=monthKey(new Date(row.created_at));if(!series.has(seriesKey))series.set(seriesKey,{branch_id:Number(row.branch_id),branch_name:row.branch_name,category,counts:new Map()});const current=series.get(seriesKey);current.counts.set(month,n(current.counts.get(month))+1)}
 const capacityBySeries=new Map(),engineerTotals=new Map(),classifiedEngineers=new Set();
 for(const row of capacityRows){const engineerId=Number(row.engineer_id),jobs=n(row.jobs);classifiedEngineers.add(engineerId);engineerTotals.set(engineerId,n(engineerTotals.get(engineerId))+jobs)}
 for(const row of capacityRows){const engineerId=Number(row.engineer_id),share=n(row.jobs)/Math.max(1,n(engineerTotals.get(engineerId))),seriesKey=key(row.branch_id,row.category),entry=capacityBySeries.get(seriesKey)||{monthly_capacity:0,engineers:new Set(),branch_id:Number(row.branch_id),branch_name:row.branch_name,category:String(row.category)};entry.monthly_capacity+=WORKING_DAYS_PER_MONTH*MAX_DAILY_JOBS*share;entry.engineers.add(engineerId);capacityBySeries.set(seriesKey,entry);if(!series.has(seriesKey))series.set(seriesKey,{branch_id:Number(row.branch_id),branch_name:row.branch_name,category:String(row.category),counts:new Map()})}
 const scopedEngineerIds=new Set(engineerRows.map(row=>Number(row.id)));
 if(!series.size){const result=emptyResult({now,asOf:resolvedAsOf,historyStart,forecastStart,historyMonths,horizonMonths});result.capacity.unclassified_engineers=scopedEngineerIds.size;return result}

 const specialties=[],allBacktest=[];
 for(const [seriesKey,item] of series){
  const values=historyKeys.map(month=>n(item.counts.get(month))),total=values.reduce((sum,value)=>sum+value,0),backtest=[];
  for(let index=Math.max(3,values.length-6);index<values.length;index++)backtest.push({month:historyKeys[index],forecast:forecastPoint(values,index),actual:values[index]});
  allBacktest.push(...backtest);const error=errorMetrics(backtest),forecastValues=[];
  for(let offset=0;offset<horizonMonths;offset++){const prediction=forecastPoint([...values,...forecastValues],values.length+offset);forecastValues.push(prediction)}
  const capacityEntry=capacityBySeries.get(seriesKey),monthlyCapacity=round(capacityEntry?.monthly_capacity||0),forecast=forecastValues.map((orders,index)=>{const gap=Math.max(0,orders-monthlyCapacity),utilization=monthlyCapacity?orders/monthlyCapacity*100:(orders?999:0);return{month:monthKey(addMonths(forecastStart,index)),orders,monthly_capacity:monthlyCapacity,gap:round(gap),utilization_pct:round(utilization),risk:gap>0?'SHORTAGE':utilization>=85?'WATCH':'OK'}});
  specialties.push({branch_id:item.branch_id,branch_name:item.branch_name,category:item.category,history_orders:total,history_months:historyMonths,engineer_count:capacityEntry?.engineers.size||0,monthly_capacity:monthlyCapacity,confidence:confidence({months:historyMonths,total,error}),backtest:error,forecast});
 }
 specialties.sort((a,b)=>(b.forecast[0]?.gap||0)-(a.forecast[0]?.gap||0)||(b.forecast[0]?.orders||0)-(a.forecast[0]?.orders||0)||a.category.localeCompare(b.category,'ru'));
 const months=Array.from({length:horizonMonths},(_,index)=>{const rows=specialties.map(item=>item.forecast[index]),forecastOrders=rows.reduce((sum,item)=>sum+n(item?.orders),0),monthlyCapacity=rows.reduce((sum,item)=>sum+n(item?.monthly_capacity),0),gap=rows.reduce((sum,item)=>sum+n(item?.gap),0),utilization=monthlyCapacity?forecastOrders/monthlyCapacity*100:(forecastOrders?999:0);return{month:monthKey(addMonths(forecastStart,index)),forecast_orders:forecastOrders,monthly_capacity:round(monthlyCapacity),gap:round(gap),utilization_pct:round(utilization),risk:gap>0?'SHORTAGE':utilization>=85?'WATCH':'OK'}});
 const backtest=errorMetrics(allBacktest),first=months[0],unclassified=[...scopedEngineerIds].filter(id=>!classifiedEngineers.has(id)).length,dataQuality=confidence({months:historyMonths,total:demandRows.length,error:backtest});
 return{generated_at:now.toISOString(),as_of:resolvedAsOf.toISOString(),history:{from:historyStart.toISOString(),to_exclusive:forecastStart.toISOString(),complete_months:historyMonths,orders:demandRows.length},horizon_months:horizonMonths,summary:{forecast_orders:first?.forecast_orders||0,monthly_capacity:first?.monthly_capacity||0,projected_gap:first?.gap||0,overloaded_specialties:specialties.filter(item=>item.forecast.some(point=>point.risk==='SHORTAGE')).length,backtest,data_quality:dataQuality},months,specialties,capacity:{classified_engineers:classifiedEngineers.size,unclassified_engineers:unclassified},methodology:methodology()};
}

export function installSeasonalLoadForecast(app,pool,{preHandler,branchIds=resolveSeasonalForecastBranchIds}={}){
 app.get('/api/v1/seasonal-load-forecast',{preHandler},async(req,reply)=>{try{const allowed=await branchIds(pool,req.user);return{data:await buildSeasonalLoadForecast(pool,{branchIds:allowed,branchId:req.query?.branch_id?Number(req.query.branch_id):null,asOf:req.query?.as_of,historyMonths:req.query?.history_months,horizonMonths:req.query?.horizon_months})}}catch(error){return fail(reply,error)}});
}
