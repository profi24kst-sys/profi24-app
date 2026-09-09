import {buildSupplierPerformanceAnalytics} from './supplier-performance-analytics.js';

const n=v=>Number(v||0);
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

function preferOffer(a,b){
  if(!a)return b;
  const aa=a.supplier_available_qty,ba=b.supplier_available_qty;
  const aAvailable=aa==null||n(aa)>0,bAvailable=ba==null||n(ba)>0;
  if(aAvailable!==bAvailable)return bAvailable?b:a;
  if(n(b.unit_cost)!==n(a.unit_cost))return n(b.unit_cost)<n(a.unit_cost)?b:a;
  const al=a.lead_time_days==null?99999:Number(a.lead_time_days),bl=b.lead_time_days==null?99999:Number(b.lead_time_days);
  return bl<al?b:a;
}

export async function readSupplierOffers(db,itemIds){
  const byItem=new Map();if(!itemIds.length)return byItem;
  const push=offer=>{const id=Number(offer.item_id);if(!byItem.has(id))byItem.set(id,new Map());const map=byItem.get(id),sid=Number(offer.supplier_id),prev=map.get(sid);map.set(sid,preferOffer(prev,offer))};
  try{
    const rows=(await db.query(`SELECT scl.warehouse_item_id item_id,ci.supplier_id,s.name supplier_name,ci.purchase_price unit_cost,ci.available_qty supplier_available_qty,ci.lead_time_days,COALESCE(ci.currency,'KZT') currency
      FROM supplier_catalog_links scl
      JOIN warehouse_items w ON w.id=scl.warehouse_item_id AND w.branch_id=scl.branch_id
      JOIN supplier_catalog_items ci ON ci.id=scl.catalog_item_id AND ci.active=true
      JOIN suppliers s ON s.id=ci.supplier_id AND s.active=true
      WHERE scl.warehouse_item_id=ANY($1::int[]) AND ci.purchase_price>0
      ORDER BY scl.warehouse_item_id,ci.supplier_id,ci.purchase_price,ci.lead_time_days NULLS LAST,ci.id`,[itemIds])).rows;
    for(const row of rows)push({...row,source:'CATALOG',auto_eligible:String(row.currency||'KZT').toUpperCase()==='KZT',auto_exclusion_reason:String(row.currency||'KZT').toUpperCase()==='KZT'?null:'FOREIGN_CURRENCY'});
  }catch(error){if(!['42P01','42703'].includes(error?.code))throw error}
  const fallback=(await db.query(`SELECT w.id item_id,s.id supplier_id,s.name supplier_name,w.purchase_price unit_cost
    FROM warehouse_items w JOIN suppliers s ON s.active=true AND w.supplier IS NOT NULL AND lower(s.name)=lower(w.supplier)
    WHERE w.id=ANY($1::int[]) AND w.purchase_price>=0 ORDER BY w.id,s.id`,[itemIds])).rows;
  for(const row of fallback){const existing=byItem.get(Number(row.item_id));if(existing?.size)continue;push({...row,supplier_available_qty:null,lead_time_days:null,currency:'KZT',source:'WAREHOUSE_CARD',auto_eligible:true,auto_exclusion_reason:null})}
  const out=new Map();for(const [itemId,map] of byItem)out.set(itemId,[...map.values()].map(x=>({...x,item_id:Number(x.item_id),supplier_id:Number(x.supplier_id),unit_cost:n(x.unit_cost),supplier_available_qty:x.supplier_available_qty==null?null:n(x.supplier_available_qty),lead_time_days:x.lead_time_days==null?null:Number(x.lead_time_days),currency:String(x.currency||'KZT').toUpperCase()})));
  return out;
}

export async function buildSupplierProfilesByBranch(db,branchIds){
  const result=new Map();
  for(const branchId of [...new Set(branchIds.map(Number).filter(Boolean))]){
    const analytics=await buildSupplierPerformanceAnalytics(db,{branchId,days:365});
    result.set(branchId,new Map((analytics.suppliers||[]).map(x=>[Number(x.supplier_id),x])));
  }
  return result;
}

function adjustedHistory(profile){
  if(!profile)return{score:70,rating:null,confidence:'LOW',recommendation_code:'LIMITED_DATA',on_time_rate:null,overdue_open_orders:0};
  const factor=confidenceFactor[profile.confidence]??.35,raw=n(profile.score||70),score=70+(raw-70)*factor;
  return{score:clamp(score,0,100),rating:profile.rating||null,confidence:profile.confidence||'LOW',recommendation_code:profile.recommendation_code||'MONITOR',on_time_rate:profile.on_time_rate==null?null:n(profile.on_time_rate),overdue_open_orders:n(profile.overdue_open_orders)};
}

function leadScore(lead,minLead){
  if(lead==null)return 55;
  if(minLead==null)return 70;
  return clamp(100*((Number(minLead)+2)/(Number(lead)+2)),25,100);
}
function availabilityScore(available,need){
  if(available==null)return 65;
  if(n(available)<=0)return 0;
  if(n(available)>=n(need))return 100;
  return clamp(20+80*n(available)/Math.max(n(need),.001),20,99);
}

function strategyLabel(strategy){
  if(strategy==='SERVICE_CRITICAL')return 'критичный ремонт';
  if(strategy==='STOCK_REPLENISHMENT')return 'пополнение склада';
  if(strategy==='STOCK_WATCH')return 'контроль запаса';
  return 'обычная закупка';
}

export function chooseSupplierOffer({row,offers=[],profiles=new Map()}={}){
  const priority=row?.priority||'NORMAL',need=n(row?.recommended_quantity),w=weights[priority]||weights.NORMAL;
  const all=offers.map(o=>({...o,profile:profiles.get(Number(o.supplier_id))||null})),eligible=all.filter(o=>o.auto_eligible&&n(o.unit_cost)>=0),excluded=all.filter(o=>!o.auto_eligible).map(o=>({...o,selection_score:null,profile:undefined}));
  if(!eligible.length)return{selected:null,alternatives:all.map(o=>({...o,selection_score:null,profile:undefined})),strategy:w.strategy};
  const positivePrices=eligible.map(o=>n(o.unit_cost)).filter(x=>x>0),minPrice=positivePrices.length?Math.min(...positivePrices):0,knownLeads=eligible.map(o=>o.lead_time_days).filter(x=>x!=null).map(Number),minLead=knownLeads.length?Math.min(...knownLeads):null;
  const scored=eligible.map(o=>{
    const history=adjustedHistory(o.profile),priceScore=minPrice>0&&n(o.unit_cost)>0?clamp(100*minPrice/n(o.unit_cost),0,100):70,lScore=leadScore(o.lead_time_days,minLead),aScore=availabilityScore(o.supplier_available_qty,need);
    let penalty=0;if(history.recommendation_code==='DELIVERY_RISK')penalty+=priority==='CRITICAL'?30:10;if(history.overdue_open_orders>=2)penalty+=priority==='CRITICAL'?15:5;if(o.supplier_available_qty!=null&&n(o.supplier_available_qty)<=0)penalty+=priority==='CRITICAL'?20:5;
    const total=clamp(priceScore*w.price+lScore*w.lead+history.score*w.history+aScore*w.availability-penalty,0,100);
    return{...o,selection_score:round(total),price_score:round(priceScore),lead_score:round(lScore),availability_score:round(aScore),supplier_performance_score:round(history.score),supplier_rating:history.rating,supplier_confidence:history.confidence,supplier_recommendation_code:history.recommendation_code,on_time_rate:history.on_time_rate,risk_penalty:penalty,profile:undefined};
  }).sort((a,b)=>b.selection_score-a.selection_score||n(a.unit_cost)-n(b.unit_cost)||(a.lead_time_days??99999)-(b.lead_time_days??99999)||a.supplier_name.localeCompare(b.supplier_name));
  const selected=scored[0],cheapest=[...eligible].sort((a,b)=>n(a.unit_cost)-n(b.unit_cost)||(a.lead_time_days??99999)-(b.lead_time_days??99999))[0],premium=pct(n(selected.unit_cost),n(cheapest.unit_cost));
  const reason=`Автовыбор: ${strategyLabel(w.strategy)}. ${selected.supplier_name}: итог ${round(selected.selection_score,1)}/100, срок ${selected.lead_time_days==null?'не указан':selected.lead_time_days+' дн.'}, рейтинг ${selected.supplier_rating||'—'} (${round(selected.supplier_performance_score,0)}/100, ${selected.supplier_confidence}), цена ${round(selected.unit_cost,2)} KZT${premium>0.01?` (+${round(premium,1)}% к минимуму ${round(cheapest.unit_cost,2)} KZT)`: ' — минимальная среди сопоставимых'}.`;
  return{selected:{...selected,selection_strategy:w.strategy,selection_reason:reason,cheapest_supplier_id:Number(cheapest.supplier_id),cheapest_supplier_name:cheapest.supplier_name,cheapest_unit_cost:n(cheapest.unit_cost),price_premium_pct:round(premium,2),alternatives_count:scored.length},alternatives:[...scored,...excluded],strategy:w.strategy};
}

export async function buildSmartSupplierSelections(db,rows){
  const itemIds=rows.map(x=>Number(x.id)),offerMap=await readSupplierOffers(db,itemIds),profiles=await buildSupplierProfilesByBranch(db,rows.map(x=>Number(x.branch_id))),out=new Map();
  for(const row of rows){const branchProfiles=profiles.get(Number(row.branch_id))||new Map();out.set(Number(row.id),chooseSupplierOffer({row,offers:offerMap.get(Number(row.id))||[],profiles:branchProfiles}))}
  return out;
}
