const n=v=>Number(v||0);
const DAY=86400000;
const clamp=(v,min,max)=>Math.min(max,Math.max(min,v));
const confidenceFactor={HIGH:1,MEDIUM:.75,LOW:.35};
const weights={
  CRITICAL:{price:.20,lead:.30,history:.35,availability:.15,strategy:'SERVICE_CRITICAL'},
  HIGH:{price:.65,lead:.10,history:.20,availability:.05,strategy:'STOCK_REPLENISHMENT'},
  MEDIUM:{price:.50,lead:.15,history:.25,availability:.10,strategy:'STOCK_WATCH'},
  NORMAL:{price:.60,lead:.10,history:.20,availability:.10,strategy:'ROUTINE'}
};

const round=(v,d=2)=>Number(Number(v||0).toFixed(d));
const pct=(a,b)=>b>0?(a-b)/b*100:0;
const monthKey=d=>`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
const dateOnly=d=>new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()));

function preferOffer(a,b){
  if(!a)return b;
  const aa=a.supplier_available_qty,ba=b.supplier_available_qty;
  const aAvailable=aa==null||n(aa)>0,bAvailable=ba==null||n(ba)>0;
  if(aAvailable!==bAvailable)return bAvailable?b:a;
  if(n(b.unit_cost)!==n(a.unit_cost))return n(b.unit_cost)<n(a.unit_cost)?b:a;
  const al=a.lead_time_days==null?99999:Number(a.lead_time_days),bl=b.lead_time_days==null?99999:Number(b.lead_time_days);
  return bl<al?b:a;
}

async function supplierCatalogReady(db){
  const row=(await db.query(`SELECT count(*)::int n FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN('supplier_catalog_items','supplier_catalog_links')`)).rows[0];
  return Number(row?.n)===2;
}

export async function readSupplierOffers(db,itemIds){
  const byItem=new Map();if(!itemIds.length)return byItem;
  const push=offer=>{const id=Number(offer.item_id);if(!byItem.has(id))byItem.set(id,new Map());const map=byItem.get(id),sid=Number(offer.supplier_id),prev=map.get(sid);map.set(sid,preferOffer(prev,offer))};
  if(await supplierCatalogReady(db)){
    const rows=(await db.query(`SELECT scl.warehouse_item_id item_id,ci.supplier_id,s.name supplier_name,ci.purchase_price unit_cost,ci.available_qty supplier_available_qty,ci.lead_time_days,COALESCE(ci.currency,'KZT') currency
      FROM supplier_catalog_links scl
      JOIN warehouse_items w ON w.id=scl.warehouse_item_id AND w.branch_id=scl.branch_id
      JOIN supplier_catalog_items ci ON ci.id=scl.catalog_item_id AND ci.active=true
      JOIN suppliers s ON s.id=ci.supplier_id AND s.active=true
      WHERE scl.warehouse_item_id=ANY($1::int[]) AND ci.purchase_price>0
      ORDER BY scl.warehouse_item_id,ci.supplier_id,ci.purchase_price,ci.lead_time_days NULLS LAST,ci.id`,[itemIds])).rows;
    for(const row of rows)push({...row,source:'CATALOG',auto_eligible:String(row.currency||'KZT').toUpperCase()==='KZT',auto_exclusion_reason:String(row.currency||'KZT').toUpperCase()==='KZT'?null:'FOREIGN_CURRENCY'});
  }
  const fallback=(await db.query(`SELECT w.id item_id,s.id supplier_id,s.name supplier_name,w.purchase_price unit_cost
    FROM warehouse_items w JOIN suppliers s ON s.active=true AND w.supplier IS NOT NULL AND lower(s.name)=lower(w.supplier)
    WHERE w.id=ANY($1::int[]) AND w.purchase_price>=0 ORDER BY w.id,s.id`,[itemIds])).rows;
  for(const row of fallback){const existing=byItem.get(Number(row.item_id));if(existing?.size)continue;push({...row,supplier_available_qty:null,lead_time_days:null,currency:'KZT',source:'WAREHOUSE_CARD',auto_eligible:true,auto_exclusion_reason:null})}
  const out=new Map();for(const [itemId,map] of byItem)out.set(itemId,[...map.values()].map(x=>({...x,item_id:Number(x.item_id),supplier_id:Number(x.supplier_id),unit_cost:n(x.unit_cost),supplier_available_qty:x.supplier_available_qty==null?null:n(x.supplier_available_qty),lead_time_days:x.lead_time_days==null?null:Number(x.lead_time_days),currency:String(x.currency||'KZT').toUpperCase()})));
  return out;
}

function scoreProfiles(orderRows,lineRows,openRows,now=new Date()){
  const stats=new Map(),ensure=(id,name)=>{const key=Number(id);if(!stats.has(key))stats.set(key,{supplier_id:key,supplier_name:name||'',orders:0,received_orders:0,eta_received_orders:0,on_time_orders:0,lead_days_total:0,overdue_open_orders:0,overdue_days_total:0,comparable_lines:0,price_wins:0,comparable_baseline:0,possible_savings:0});return stats.get(key)};
  const today=dateOnly(now);
  for(const o of orderRows){if(String(o.status)==='CANCELLED'||!o.supplier_id)continue;const s=ensure(o.supplier_id,o.supplier_name);s.orders++;if(String(o.status)==='RECEIVED'){s.received_orders++;s.lead_days_total+=Math.max(0,(new Date(o.updated_at)-new Date(o.created_at))/DAY);if(o.expected_at){s.eta_received_orders++;if(dateOnly(new Date(o.updated_at))<=dateOnly(new Date(o.expected_at)))s.on_time_orders++}}}
  for(const o of openRows){if(!o.supplier_id)continue;const s=ensure(o.supplier_id,o.supplier_name);if(o.expected_at&&dateOnly(new Date(o.expected_at))<today){s.overdue_open_orders++;s.overdue_days_total+=Math.max(0,(today-dateOnly(new Date(o.expected_at)))/DAY)}}
  const groups=new Map();for(const l of lineRows){if(!l.supplier_id||!l.item_id||n(l.qty)<=0||n(l.unit_cost)<=0)continue;const key=`${l.item_id}:${monthKey(new Date(l.created_at))}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(l)}
  for(const group of groups.values()){if(new Set(group.map(x=>Number(x.supplier_id))).size<2)continue;const best=Math.min(...group.map(x=>n(x.unit_cost)));for(const l of group){const s=ensure(l.supplier_id,l.supplier_name),qty=n(l.qty),cost=n(l.unit_cost),baseline=best*qty;s.comparable_lines++;s.comparable_baseline+=baseline;s.possible_savings+=Math.max(0,(cost-best)*qty);if(Math.abs(cost-best)<0.005)s.price_wins++}}
  const result=new Map();for(const s of stats.values()){
    const premium=s.comparable_baseline>0?s.possible_savings/s.comparable_baseline*100:null,win=s.comparable_lines?s.price_wins/s.comparable_lines*100:null,priceScore=s.comparable_lines>=2?.6*win+.4*Math.max(0,100-premium*4):70,onTime=s.eta_received_orders?s.on_time_orders/s.eta_received_orders*100:null,deliveryScore=onTime??70,avgOverdue=s.overdue_open_orders?s.overdue_days_total/s.overdue_open_orders:0,opsScore=Math.max(0,100-s.overdue_open_orders*20-Math.min(30,avgOverdue*1.5)),score=.4*priceScore+.4*deliveryScore+.2*opsScore;
    const confidence=(s.received_orders>=5&&s.comparable_lines>=5)||s.orders>=10?'HIGH':s.received_orders>=2||s.comparable_lines>=3?'MEDIUM':'LOW';
    let recommendation_code='MONITOR';if(s.overdue_open_orders>=2||(s.eta_received_orders>=3&&onTime<60))recommendation_code='DELIVERY_RISK';else if(score>=85&&confidence!=='LOW')recommendation_code='PREFERRED';
    result.set(s.supplier_id,{supplier_id:s.supplier_id,supplier_name:s.supplier_name,score,rating:score>=85?'A':score>=70?'B':score>=55?'C':'D',confidence,recommendation_code,on_time_rate:onTime,avg_lead_days:s.received_orders?s.lead_days_total/s.received_orders:null,overdue_open_orders:s.overdue_open_orders,price_premium_pct:premium,price_win_rate:win});
  }return result;
}

export async function buildSupplierProfilesByBranch(db,branchIds){
  const result=new Map(),since=new Date(Date.now()-365*DAY);
  for(const branchId of [...new Set(branchIds.map(Number).filter(Boolean))]){
    const orders=(await db.query(`SELECT po.id,po.supplier_id,s.name supplier_name,po.status,po.expected_at,po.created_at,po.updated_at FROM purchase_orders po LEFT JOIN suppliers s ON s.id=po.supplier_id WHERE po.branch_id=$1 AND po.created_at>=$2::timestamptz`,[branchId,since.toISOString()])).rows;
    const lines=(await db.query(`SELECT po.supplier_id,s.name supplier_name,po.created_at,i.item_id,i.qty,i.unit_cost FROM purchase_orders po LEFT JOIN suppliers s ON s.id=po.supplier_id JOIN purchase_order_items i ON i.purchase_order_id=po.id WHERE po.branch_id=$1 AND po.status<>'CANCELLED' AND po.created_at>=$2::timestamptz`,[branchId,since.toISOString()])).rows;
    const open=(await db.query(`SELECT po.supplier_id,s.name supplier_name,po.expected_at,po.created_at FROM purchase_orders po LEFT JOIN suppliers s ON s.id=po.supplier_id WHERE po.branch_id=$1 AND po.status NOT IN('RECEIVED','CANCELLED')`,[branchId])).rows;
    result.set(branchId,scoreProfiles(orders,lines,open));
  }
  return result;
}

function adjustedHistory(profile){
  if(!profile)return{score:70,rating:null,confidence:'LOW',recommendation_code:'LIMITED_DATA',on_time_rate:null,overdue_open_orders:0};
  const factor=confidenceFactor[profile.confidence]??.35,raw=n(profile.score||70),score=70+(raw-70)*factor;
  return{score:clamp(score,0,100),rating:profile.rating||null,confidence:profile.confidence||'LOW',recommendation_code:profile.recommendation_code||'MONITOR',on_time_rate:profile.on_time_rate==null?null:n(profile.on_time_rate),overdue_open_orders:n(profile.overdue_open_orders)};
}

function leadScore(lead,minLead){if(lead==null)return 55;if(minLead==null)return 70;return clamp(100*((Number(minLead)+2)/(Number(lead)+2)),25,100)}
function availabilityScore(available,need){if(available==null)return 65;if(n(available)<=0)return 0;if(n(available)>=n(need))return 100;return clamp(20+80*n(available)/Math.max(n(need),.001),20,99)}
function strategyLabel(strategy){if(strategy==='SERVICE_CRITICAL')return 'критичный ремонт';if(strategy==='STOCK_REPLENISHMENT')return 'пополнение склада';if(strategy==='STOCK_WATCH')return 'контроль запаса';return 'обычная закупка'}

export function chooseSupplierOffer({row,offers=[],profiles=new Map()}={}){
  const priority=row?.priority||'NORMAL',need=n(row?.recommended_quantity),w=weights[priority]||weights.NORMAL;
  const all=offers.map(o=>({...o,profile:profiles.get(Number(o.supplier_id))||null})),eligible=all.filter(o=>o.auto_eligible&&n(o.unit_cost)>=0),excluded=all.filter(o=>!o.auto_eligible).map(o=>({...o,selection_score:null,profile:undefined}));
  if(!eligible.length)return{selected:null,alternatives:all.map(o=>({...o,selection_score:null,profile:undefined})),strategy:w.strategy};
  const positivePrices=eligible.map(o=>n(o.unit_cost)).filter(x=>x>0),minPrice=positivePrices.length?Math.min(...positivePrices):0,knownLeads=eligible.map(o=>o.lead_time_days).filter(x=>x!=null).map(Number),minLead=knownLeads.length?Math.min(...knownLeads):null;
  const scored=eligible.map(o=>{const history=adjustedHistory(o.profile),priceScore=minPrice>0&&n(o.unit_cost)>0?clamp(100*minPrice/n(o.unit_cost),0,100):70,lScore=leadScore(o.lead_time_days,minLead),aScore=availabilityScore(o.supplier_available_qty,need);let penalty=0;if(history.recommendation_code==='DELIVERY_RISK')penalty+=priority==='CRITICAL'?30:10;if(history.overdue_open_orders>=2)penalty+=priority==='CRITICAL'?15:5;if(o.supplier_available_qty!=null&&n(o.supplier_available_qty)<=0)penalty+=priority==='CRITICAL'?20:5;const total=clamp(priceScore*w.price+lScore*w.lead+history.score*w.history+aScore*w.availability-penalty,0,100);return{...o,selection_score:round(total),price_score:round(priceScore),lead_score:round(lScore),availability_score:round(aScore),supplier_performance_score:round(history.score),supplier_rating:history.rating,supplier_confidence:history.confidence,supplier_recommendation_code:history.recommendation_code,on_time_rate:history.on_time_rate,risk_penalty:penalty,profile:undefined}}).sort((a,b)=>b.selection_score-a.selection_score||n(a.unit_cost)-n(b.unit_cost)||(a.lead_time_days??99999)-(b.lead_time_days??99999)||a.supplier_name.localeCompare(b.supplier_name));
  const selected=scored[0],cheapest=[...eligible].sort((a,b)=>n(a.unit_cost)-n(b.unit_cost)||(a.lead_time_days??99999)-(b.lead_time_days??99999))[0],premium=pct(n(selected.unit_cost),n(cheapest.unit_cost));
  const reason=`Автовыбор: ${strategyLabel(w.strategy)}. ${selected.supplier_name}: итог ${round(selected.selection_score,1)}/100, срок ${selected.lead_time_days==null?'не указан':selected.lead_time_days+' дн.'}, рейтинг ${selected.supplier_rating||'—'} (${round(selected.supplier_performance_score,0)}/100, ${selected.supplier_confidence}), цена ${round(selected.unit_cost,2)} KZT${premium>0.01?` (+${round(premium,1)}% к минимуму ${round(cheapest.unit_cost,2)} KZT)`: ' — минимальная среди сопоставимых'}.`;
  return{selected:{...selected,selection_strategy:w.strategy,selection_reason:reason,cheapest_supplier_id:Number(cheapest.supplier_id),cheapest_supplier_name:cheapest.supplier_name,cheapest_unit_cost:n(cheapest.unit_cost),price_premium_pct:round(premium,2),alternatives_count:scored.length},alternatives:[...scored,...excluded],strategy:w.strategy};
}

export async function buildSmartSupplierSelections(db,rows){
  const itemIds=rows.map(x=>Number(x.id)),offerMap=await readSupplierOffers(db,itemIds),profiles=await buildSupplierProfilesByBranch(db,rows.map(x=>Number(x.branch_id))),out=new Map();
  for(const row of rows){const branchProfiles=profiles.get(Number(row.branch_id))||new Map();out.set(Number(row.id),chooseSupplierOffer({row,offers:offerMap.get(Number(row.id))||[],profiles:branchProfiles}))}
  return out;
}
