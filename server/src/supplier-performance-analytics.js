const DAY=86400000;
const n=v=>Number(v||0);
const clamp=(v,min,max)=>Math.min(max,Math.max(min,v));
const monthKey=d=>`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
const dateOnly=d=>new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()));
const globalRoles=new Set(['OWNER','SUPERVISOR','ACCOUNTANT']);
const businessError=(code,message,statusCode=409,details)=>Object.assign(new Error(message),{code,statusCode,details});
const fail=(reply,error)=>reply.code(error?.statusCode||422).send({data:null,error:{code:error?.code||'VALIDATION',message:error?.message||'Ошибка аналитики поставщиков',details:error?.details}});

const methodology={
 price:'Фактическая цена сравнивается с лучшей реально купленной ценой той же складской позиции в том же календарном месяце. Сравнение считается только когда в месяце есть минимум два поставщика.',
 delivery:'Срок поставки = дата завершения RECEIVED минус дата создания PO. В срок = RECEIVED не позже expected_at.',
 score:'40% цена + 40% поставка в срок + 20% текущая операционная дисциплина. При нехватке истории используются текущие сравнимые прайсы и нейтральные компоненты; confidence показывает надёжность рейтинга.',
 concentration:'Доля закупок и HHI считаются по стоимости неотменённых PO за выбранный период.'
};

function emptyResult(now,days){return{generated_at:now.toISOString(),period_days:days,methodology,summary:{suppliers:0,orders:0,spend:0,received_value:0,possible_savings:0,overdue_open_orders:0,overdue_open_value:0,on_time_rate:null,avg_lead_days:null,top_supplier_share:0,top3_supplier_share:0,hhi:0,catalog_comparisons:0},suppliers:[],price_opportunities:[],overdue_orders:[],monthly:[]}}

export async function resolveSupplierPerformanceBranchIds(pool,user){
 if(!user||globalRoles.has(user.role))return null;
 return(await pool.query('SELECT branch_id FROM user_branches WHERE user_id=$1',[user.id])).rows.map(x=>Number(x.branch_id));
}

function addScope(alias,branchIds,branchId,params){
 const where=[];
 if(Array.isArray(branchIds)){
  if(!branchIds.length)return{empty:true,where};
  params.push(branchIds.map(Number));where.push(`${alias}.branch_id=ANY($${params.length}::int[])`);
 }
 if(branchId){params.push(Number(branchId));where.push(`${alias}.branch_id=$${params.length}`)}
 return{empty:false,where};
}

async function readCatalog(db,{branchIds,branchId}){
 const params=[],scope=addScope('l',branchIds,branchId,params);if(scope.empty)return[];
 try{
  return(await db.query(`SELECT l.branch_id,l.warehouse_item_id,ci.supplier_id,s.name supplier_name,ci.purchase_price,ci.available_qty,ci.lead_time_days,ci.updated_at,w.name item_name,w.sku,w.oem_code
   FROM supplier_catalog_links l
   JOIN supplier_catalog_items ci ON ci.id=l.catalog_item_id AND ci.active=true
   JOIN suppliers s ON s.id=ci.supplier_id AND s.active=true
   JOIN warehouse_items w ON w.id=l.warehouse_item_id
   WHERE ${scope.where.length?scope.where.join(' AND ')+' AND ':''}ci.purchase_price>0`,params)).rows;
 }catch(error){if(['42P01','42703'].includes(error?.code))return[];throw error}
}

function supplierState(id,name){return{supplier_id:Number(id)||0,supplier_name:name||'Не указан',orders:0,received_orders:0,open_orders:0,cancelled_orders:0,spend:0,received_value:0,ordered_value_for_fill:0,received_value_for_fill:0,eta_orders:0,eta_received_orders:0,on_time_orders:0,lead_days_total:0,late_days_total:0,late_received_orders:0,overdue_open_orders:0,overdue_open_value:0,overdue_days_total:0,stale_without_eta:0,comparable_lines:0,price_wins:0,comparable_baseline:0,possible_savings:0,catalog_comparisons:0,catalog_wins:0,catalog_premium_sum:0,last_order_at:null,last_received_at:null,monthly:new Map()}}

export async function buildSupplierPerformanceAnalytics(db,{branchIds=null,branchId=null,days=365,now=new Date()}={}){
 days=clamp(Math.round(Number(days)||365),30,730);const start=new Date(now.getTime()-days*DAY);
 const params=[start.toISOString(),now.toISOString()],scope=addScope('po',branchIds,branchId,params);if(scope.empty)return emptyResult(now,days);
 const periodWhere=[`po.created_at>=$1::timestamptz`,`po.created_at<$2::timestamptz`,...scope.where].join(' AND ');
 const orders=(await db.query(`SELECT po.id,po.number,po.supplier_id,COALESCE(s.name,'Не указан') supplier_name,po.branch_id,b.name branch_name,b.code branch_code,po.status,po.expected_at,po.created_at,po.updated_at,
   count(i.id)::int positions,COALESCE(sum(i.qty*i.unit_cost),0)::numeric ordered_value,COALESCE(sum(i.received_qty*i.unit_cost),0)::numeric received_value,
   COALESCE(sum(i.qty),0)::numeric ordered_qty,COALESCE(sum(i.received_qty),0)::numeric received_qty,COALESCE(sum(GREATEST(i.qty-i.received_qty,0)*i.unit_cost),0)::numeric remaining_value
   FROM purchase_orders po JOIN branches b ON b.id=po.branch_id LEFT JOIN suppliers s ON s.id=po.supplier_id LEFT JOIN purchase_order_items i ON i.purchase_order_id=po.id
   WHERE ${periodWhere} GROUP BY po.id,s.name,b.name,b.code ORDER BY po.created_at DESC`,params)).rows;
 const lines=(await db.query(`SELECT po.id purchase_order_id,po.number purchase_order_number,po.supplier_id,COALESCE(s.name,'Не указан') supplier_name,po.branch_id,b.name branch_name,b.code branch_code,po.status,po.created_at,
   i.item_id,w.name item_name,w.sku,w.oem_code,i.qty,i.received_qty,i.unit_cost
   FROM purchase_orders po JOIN branches b ON b.id=po.branch_id LEFT JOIN suppliers s ON s.id=po.supplier_id JOIN purchase_order_items i ON i.purchase_order_id=po.id LEFT JOIN warehouse_items w ON w.id=i.item_id
   WHERE ${periodWhere} ORDER BY po.created_at,i.id`,params)).rows;
 const openParams=[],openScope=addScope('po',branchIds,branchId,openParams);
 const currentOpen=openScope.empty?[]:(await db.query(`SELECT po.id,po.number,po.supplier_id,COALESCE(s.name,'Не указан') supplier_name,po.branch_id,b.name branch_name,b.code branch_code,po.status,po.expected_at,po.created_at,
   COALESCE(sum(GREATEST(i.qty-i.received_qty,0)*i.unit_cost),0)::numeric remaining_value
   FROM purchase_orders po JOIN branches b ON b.id=po.branch_id LEFT JOIN suppliers s ON s.id=po.supplier_id LEFT JOIN purchase_order_items i ON i.purchase_order_id=po.id
   WHERE po.status NOT IN('RECEIVED','CANCELLED')${openScope.where.length?' AND '+openScope.where.join(' AND '):''}
   GROUP BY po.id,s.name,b.name,b.code ORDER BY po.created_at`,openParams)).rows;
 const catalog=await readCatalog(db,{branchIds,branchId});if(!orders.length&&!catalog.length)return emptyResult(now,days);
 const states=new Map();const ensure=(id,name)=>{const key=Number(id)||0;if(!states.has(key))states.set(key,supplierState(key,name));const s=states.get(key);if(name&&s.supplier_name==='Не указан')s.supplier_name=name;return s};

 for(const o of orders){
  const s=ensure(o.supplier_id,o.supplier_name),status=String(o.status||''),value=n(o.ordered_value),received=n(o.received_value);s.orders++;if(!s.last_order_at||new Date(o.created_at)>new Date(s.last_order_at))s.last_order_at=o.created_at;
  if(status==='CANCELLED'){s.cancelled_orders++;continue}
  s.spend+=value;s.received_value+=received;s.ordered_value_for_fill+=value;s.received_value_for_fill+=received;if(o.expected_at)s.eta_orders++;
  if(status==='RECEIVED'){
   s.received_orders++;if(!s.last_received_at||new Date(o.updated_at)>new Date(s.last_received_at))s.last_received_at=o.updated_at;s.lead_days_total+=Math.max(0,(new Date(o.updated_at)-new Date(o.created_at))/DAY);
   if(o.expected_at){s.eta_received_orders++;const late=Math.max(0,(dateOnly(new Date(o.updated_at))-dateOnly(new Date(o.expected_at)))/DAY);if(late===0)s.on_time_orders++;else{s.late_received_orders++;s.late_days_total+=late}}
  }else s.open_orders++;
  const m=monthKey(new Date(o.created_at));if(!s.monthly.has(m))s.monthly.set(m,{month:m,orders:0,spend:0,possible_savings:0,comparable_baseline:0});const mm=s.monthly.get(m);mm.orders++;mm.spend+=value;
 }
 const today=dateOnly(now);for(const o of currentOpen){const s=ensure(o.supplier_id,o.supplier_name),expected=o.expected_at?dateOnly(new Date(o.expected_at)):null,overdue=expected?expected<today:false,overdueDays=overdue?(today-expected)/DAY:0,stale=!expected&&new Date(o.created_at)<new Date(now.getTime()-7*DAY);o.overdue=overdue;o.overdue_days=overdueDays;o.stale_without_eta=stale;if(overdue){s.overdue_open_orders++;s.overdue_open_value+=n(o.remaining_value);s.overdue_days_total+=overdueDays}if(stale)s.stale_without_eta++}

 const lineGroups=new Map();for(const l of lines){if(String(l.status)==='CANCELLED'||n(l.qty)<=0||n(l.unit_cost)<=0||!l.item_id||!l.supplier_id)continue;const key=`${l.item_id}:${monthKey(new Date(l.created_at))}`;if(!lineGroups.has(key))lineGroups.set(key,[]);lineGroups.get(key).push(l)}
 const opportunities=new Map();
 for(const group of lineGroups.values()){
  if(new Set(group.map(x=>Number(x.supplier_id))).size<2)continue;const best=Math.min(...group.map(x=>n(x.unit_cost))),bestNames=[...new Set(group.filter(x=>Math.abs(n(x.unit_cost)-best)<0.005).map(x=>x.supplier_name))];
  for(const l of group){
   const s=ensure(l.supplier_id,l.supplier_name),qty=n(l.qty),cost=n(l.unit_cost),baseline=best*qty,gap=Math.max(0,(cost-best)*qty);s.comparable_lines++;s.comparable_baseline+=baseline;s.possible_savings+=gap;if(Math.abs(cost-best)<0.005)s.price_wins++;
   const m=monthKey(new Date(l.created_at));if(!s.monthly.has(m))s.monthly.set(m,{month:m,orders:0,spend:0,possible_savings:0,comparable_baseline:0});const mm=s.monthly.get(m);mm.possible_savings+=gap;mm.comparable_baseline+=baseline;
   if(gap>0.01){const key=`${l.supplier_id}:${l.item_id}:${m}:${l.branch_id}`,cur=opportunities.get(key)||{supplier_id:Number(l.supplier_id),supplier_name:l.supplier_name,item_id:Number(l.item_id),item_name:l.item_name,sku:l.sku,oem_code:l.oem_code,branch_id:Number(l.branch_id),branch_name:l.branch_name,branch_code:l.branch_code,month:m,quantity:0,spend:0,baseline:0,possible_saving:0,best_unit_cost:best,best_supplier_names:bestNames,purchase_orders:[]};cur.quantity+=qty;cur.spend+=cost*qty;cur.baseline+=baseline;cur.possible_saving+=gap;if(!cur.purchase_orders.includes(l.purchase_order_number))cur.purchase_orders.push(l.purchase_order_number);opportunities.set(key,cur)}
  }
 }

 const cheapestCatalogBySupplier=new Map();for(const row of catalog){const key=`${row.branch_id}:${row.warehouse_item_id}:${row.supplier_id}`,prev=cheapestCatalogBySupplier.get(key);if(!prev||n(row.purchase_price)<n(prev.purchase_price))cheapestCatalogBySupplier.set(key,row)}
 const catalogGroups=new Map();for(const row of cheapestCatalogBySupplier.values()){const key=`${row.branch_id}:${row.warehouse_item_id}`;if(!catalogGroups.has(key))catalogGroups.set(key,[]);catalogGroups.get(key).push(row)}
 for(const group of catalogGroups.values()){if(new Set(group.map(x=>Number(x.supplier_id))).size<2)continue;const best=Math.min(...group.map(x=>n(x.purchase_price)));for(const row of group){const s=ensure(row.supplier_id,row.supplier_name),price=n(row.purchase_price);s.catalog_comparisons++;if(Math.abs(price-best)<0.005)s.catalog_wins++;s.catalog_premium_sum+=best>0?(price-best)/best*100:0}}

 const suppliers=[...states.values()],totalSpend=suppliers.reduce((a,x)=>a+x.spend,0),spendingSuppliers=suppliers.filter(x=>x.spend>0).length;
 const allEtaReceived=suppliers.reduce((a,x)=>a+x.eta_received_orders,0),allOnTime=suppliers.reduce((a,x)=>a+x.on_time_orders,0),allReceived=suppliers.reduce((a,x)=>a+x.received_orders,0),allLead=suppliers.reduce((a,x)=>a+x.lead_days_total,0),globalMonthly=new Map();
 for(const s of suppliers){
  const premium=s.comparable_baseline?s.possible_savings/s.comparable_baseline*100:null,winRate=s.comparable_lines?s.price_wins/s.comparable_lines*100:null,catalogWin=s.catalog_comparisons?s.catalog_wins/s.catalog_comparisons*100:null,catalogPremium=s.catalog_comparisons?s.catalog_premium_sum/s.catalog_comparisons:null;
  const priceScore=s.comparable_lines>=2?0.6*winRate+0.4*Math.max(0,100-premium*4):s.catalog_comparisons>=2?0.7*catalogWin+0.3*Math.max(0,100-catalogPremium*4):70,onTime=s.eta_received_orders?s.on_time_orders/s.eta_received_orders*100:null,deliveryScore=onTime??70,avgOverdue=s.overdue_open_orders?s.overdue_days_total/s.overdue_open_orders:0,opsScore=Math.max(0,100-s.overdue_open_orders*20-s.stale_without_eta*10-Math.min(30,avgOverdue*1.5)),score=0.4*priceScore+0.4*deliveryScore+0.2*opsScore,confidence=(s.received_orders>=5&&s.comparable_lines>=5)||s.orders>=10?'HIGH':s.received_orders>=2||s.comparable_lines>=3||s.catalog_comparisons>=3?'MEDIUM':'LOW',share=totalSpend?s.spend/totalSpend*100:0;
  let recommendation_code='MONITOR',recommendation='Контролировать по обычному циклу закупок';if(s.overdue_open_orders>=2||(s.eta_received_orders>=3&&onTime<60)){recommendation_code='DELIVERY_RISK';recommendation='Высокий риск срыва сроков — ограничить критичные заказы и потребовать план поставки'}else if(premium!==null&&premium>10&&s.possible_savings>0){recommendation_code='PRICE_REVIEW';recommendation='Цена выше сравнимых закупок — пересогласовать условия или перераспределить объём'}else if(share>=60&&spendingSuppliers>1){recommendation_code='DEPENDENCY_RISK';recommendation='Высокая концентрация закупок — подготовить второго поставщика'}else if(score>=85&&confidence!=='LOW'){recommendation_code='PREFERRED';recommendation='Сильные цена и дисциплина поставок — кандидат в приоритетные поставщики'}else if(confidence==='LOW'){recommendation_code='LIMITED_DATA';recommendation='Недостаточно истории для устойчивого рейтинга'}
  const monthly=[...s.monthly.values()].sort((a,b)=>a.month.localeCompare(b.month)).map(m=>({...m,price_premium_pct:m.comparable_baseline?m.possible_savings/m.comparable_baseline*100:null}));for(const m of monthly){if(!globalMonthly.has(m.month))globalMonthly.set(m.month,{month:m.month,spend:0,possible_savings:0});const g=globalMonthly.get(m.month);g.spend+=m.spend;g.possible_savings+=m.possible_savings}
  Object.assign(s,{spend_share:share,fill_rate:s.ordered_value_for_fill?s.received_value_for_fill/s.ordered_value_for_fill*100:null,on_time_rate:onTime,avg_lead_days:s.received_orders?s.lead_days_total/s.received_orders:null,avg_late_days:s.late_received_orders?s.late_days_total/s.late_received_orders:0,eta_coverage_rate:(s.received_orders+s.open_orders)?s.eta_orders/(s.received_orders+s.open_orders)*100:null,price_premium_pct:premium,price_win_rate:winRate,current_catalog_win_rate:catalogWin,current_catalog_premium_pct:catalogPremium,price_score:priceScore,delivery_score:deliveryScore,operational_score:opsScore,score,rating:score>=85?'A':score>=70?'B':score>=55?'C':'D',confidence,recommendation_code,recommendation,monthly});
  delete s.lead_days_total;delete s.late_days_total;delete s.overdue_days_total;delete s.comparable_baseline;delete s.catalog_premium_sum;delete s.ordered_value_for_fill;delete s.received_value_for_fill;
 }
 suppliers.sort((a,b)=>b.score-a.score||b.spend-a.spend||a.supplier_name.localeCompare(b.supplier_name));
 const shares=totalSpend?suppliers.filter(x=>x.spend>0).map(x=>x.spend/totalSpend).sort((a,b)=>b-a):[],overdueOrders=currentOpen.filter(x=>x.overdue||x.stale_without_eta).map(x=>({...x,remaining_value:n(x.remaining_value),overdue_days:n(x.overdue_days)}));
 const summary={suppliers:suppliers.length,orders:orders.filter(x=>String(x.status)!=='CANCELLED').length,spend:totalSpend,received_value:suppliers.reduce((a,x)=>a+x.received_value,0),possible_savings:suppliers.reduce((a,x)=>a+x.possible_savings,0),overdue_open_orders:overdueOrders.filter(x=>x.overdue).length,overdue_open_value:overdueOrders.filter(x=>x.overdue).reduce((a,x)=>a+x.remaining_value,0),on_time_rate:allEtaReceived?allOnTime/allEtaReceived*100:null,avg_lead_days:allReceived?allLead/allReceived:null,top_supplier_share:(shares[0]||0)*100,top3_supplier_share:shares.slice(0,3).reduce((a,x)=>a+x,0)*100,hhi:shares.reduce((a,x)=>a+x*x,0),catalog_comparisons:suppliers.reduce((a,x)=>a+x.catalog_comparisons,0)};
 const priceOpportunities=[...opportunities.values()].map(x=>({...x,actual_unit_cost:x.quantity?x.spend/x.quantity:0,price_premium_pct:x.baseline?x.possible_saving/x.baseline*100:0})).sort((a,b)=>b.possible_saving-a.possible_saving).slice(0,100);
 return{generated_at:now.toISOString(),period_days:days,methodology,summary,suppliers,price_opportunities:priceOpportunities,overdue_orders:overdueOrders,monthly:[...globalMonthly.values()].sort((a,b)=>a.month.localeCompare(b.month))};
}

export function installSupplierPerformanceAnalytics(app,pool,{procurementView,branchIds=resolveSupplierPerformanceBranchIds}={}){
 if(!procurementView)throw new Error('procurementView preHandler is required');
 app.get('/api/v1/supplier-performance',{preHandler:procurementView},async(req,reply)=>{
  try{
   const scope=await branchIds(pool,req.user),branchId=req.query?.branch_id?Number(req.query.branch_id):null;if(branchId&&Array.isArray(scope)&&!scope.map(Number).includes(branchId))throw businessError('FORBIDDEN','Нет доступа к аналитике закупок этого филиала',403);
   const data=await buildSupplierPerformanceAnalytics(pool,{branchIds:scope,branchId,days:req.query?.days||365}),supplierId=req.query?.supplier_id?Number(req.query.supplier_id):null;if(supplierId){data.suppliers=data.suppliers.filter(x=>Number(x.supplier_id)===supplierId);data.price_opportunities=data.price_opportunities.filter(x=>Number(x.supplier_id)===supplierId);data.overdue_orders=data.overdue_orders.filter(x=>Number(x.supplier_id)===supplierId)}return{data};
  }catch(error){return fail(reply,error)}
 });
}
