const n=v=>Number(v||0);
const DAY=86400000;
const globalRoles=new Set(['OWNER','SUPERVISOR','ACCOUNTANT']);
const businessError=(code,message,statusCode=409,details)=>Object.assign(new Error(message),{code,statusCode,details});
const fail=(reply,error)=>reply.code(error?.statusCode||422).send({data:null,error:{code:error?.code||'VALIDATION',message:error?.message||'Ошибка аналитики склада',details:error?.details}});

function monthKey(date){return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}`}
function completeMonthKeys(now=new Date(),count=6){const out=[];for(let i=count;i>=1;i--){const d=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-i,1));out.push(monthKey(d))}return out}
function movementDelta(m){const q=n(m.quantity);switch(m.movement_type){case'RECEIPT':case'RETURN':case'TRANSFER_IN':return q;case'ISSUE':case'WRITE_OFF':case'TRANSFER_OUT':return-q;case'INSTALL':return m.engineer_id?0:-q;case'ADJUSTMENT':{const c=String(m.comment||'');if(c.includes('Излишек'))return q;if(c.includes('Недостача'))return-q;return 0}default:return 0}}
function averageInventory(current,movements,createdAt,now=new Date()){
  const yearStart=new Date(now.getTime()-365*DAY),created=new Date(createdAt||yearStart),start=created>yearStart?created:yearStart;
  if(start>=now)return{average:n(current),accuracy:'FULL'};
  let balance=n(current),cursor=now,weighted=0,seconds=0,unknown=false;
  for(const m of movements){const at=new Date(m.created_at);if(at>now)continue;if(at<start)break;const span=Math.max(0,(cursor-at)/1000);weighted+=balance*span;seconds+=span;const delta=movementDelta(m);if(m.movement_type==='ADJUSTMENT'&&delta===0)unknown=true;balance-=delta;cursor=at}
  const tail=Math.max(0,(cursor-start)/1000);weighted+=balance*tail;seconds+=tail;
  return{average:seconds?Math.max(0,weighted/seconds):n(current),accuracy:unknown?'ESTIMATED':'FULL'};
}
function xyz(values){const mean=values.reduce((s,x)=>s+x,0)/(values.length||1);if(mean<=0.000001)return{class:'Z',cv:null,mean:0};const variance=values.reduce((s,x)=>s+(x-mean)**2,0)/values.length,cv=Math.sqrt(variance)/mean;return{class:cv<=0.5?'X':cv<=1?'Y':'Z',cv,mean}}
function matchKey(row){const o=String(row.oem_code||'').trim().toLowerCase(),s=String(row.sku||'').trim().toLowerCase();return o?`oem:${o}`:s?`sku:${s}`:null}
function daysBetween(a,b){return Math.max(0,Math.floor((new Date(a)-new Date(b))/DAY))}

export async function resolveWarehouseBranchIds(pool,user){
  if(!user||globalRoles.has(user.role))return null;
  return(await pool.query('SELECT branch_id FROM user_branches WHERE user_id=$1',[user.id])).rows.map(x=>Number(x.branch_id));
}

export async function buildWarehouseStockAnalytics(db,{branchIds=null,branchId=null,search='',now=new Date()}={}){
  const params=[],where=['w.active=true'];
  if(Array.isArray(branchIds)){if(!branchIds.length)return{summary:{positions:0,stock_value:0,excess_value:0,dead_stock_value:0,turnover:0,days_inventory:null,no_consumption_90:0,no_consumption_180:0,no_consumption_365:0,transfer_opportunities:0},rows:[],abc:{A:0,B:0,C:0},xyz:{X:0,Y:0,Z:0},generated_at:now.toISOString()};params.push(branchIds.map(Number));where.push(`w.branch_id=ANY($${params.length}::int[])`)}
  if(branchId){params.push(Number(branchId));where.push(`w.branch_id=$${params.length}`)}
  const term=String(search||'').trim();if(term){params.push(`%${term}%`);where.push(`(w.name ILIKE $${params.length} OR COALESCE(w.sku,'') ILIKE $${params.length} OR COALESCE(w.oem_code,'') ILIKE $${params.length} OR COALESCE(w.supplier,'') ILIKE $${params.length})`)}
  const nowParam=params.length+1;
  const rows=(await db.query(`WITH reserved AS(
      SELECT sr.item_id,COALESCE(sum(sr.quantity),0)::numeric qty FROM stock_reservations sr
      LEFT JOIN requests r ON r.id=sr.request_id WHERE sr.status='ACTIVE' AND (r.id IS NULL OR (r.deleted_at IS NULL AND r.status NOT IN('CLOSED','CANCELLED'))) GROUP BY sr.item_id
    ), demand AS(
      SELECT d.item_id,COALESCE(sum(d.qty),0)::numeric qty FROM part_demands d JOIN requests r ON r.id=d.request_id
      WHERE d.status<>'RESOLVED' AND r.deleted_at IS NULL AND r.status NOT IN('CLOSED','CANCELLED') GROUP BY d.item_id
    ), pending AS(
      SELECT i.item_id,COALESCE(sum(GREATEST(i.qty-i.received_qty,0)),0)::numeric qty FROM purchase_order_items i JOIN purchase_orders po ON po.id=i.purchase_order_id
      WHERE po.status NOT IN('RECEIVED','CANCELLED') GROUP BY i.item_id
    ), activity AS(
      SELECT m.item_id,max(m.created_at) last_movement_at,max(m.created_at) FILTER(WHERE m.movement_type='INSTALL') last_consumption_at,
        COALESCE(sum(m.quantity) FILTER(WHERE m.movement_type='INSTALL' AND m.created_at>=$${nowParam}::timestamptz-interval '365 days'),0)::numeric usage_qty_365,
        COALESCE(sum(m.quantity*CASE WHEN m.unit_cost>0 THEN m.unit_cost ELSE w2.purchase_price END) FILTER(WHERE m.movement_type='INSTALL' AND m.created_at>=$${nowParam}::timestamptz-interval '365 days'),0)::numeric usage_value_365
      FROM warehouse_movements m JOIN warehouse_items w2 ON w2.id=m.item_id GROUP BY m.item_id
    )
    SELECT w.id,w.branch_id,b.code branch_code,b.name branch_name,w.name,w.sku,w.oem_code,w.supplier,w.location,w.purchase_price,w.sale_price,w.quantity,w.min_quantity,w.created_at,w.updated_at,
      COALESCE(r.qty,0)::numeric reserved_quantity,COALESCE(d.qty,0)::numeric service_demand_quantity,COALESCE(p.qty,0)::numeric pending_order_quantity,
      a.last_movement_at,a.last_consumption_at,COALESCE(a.usage_qty_365,0)::numeric usage_qty_365,COALESCE(a.usage_value_365,0)::numeric usage_value_365
    FROM warehouse_items w JOIN branches b ON b.id=w.branch_id LEFT JOIN reserved r ON r.item_id=w.id LEFT JOIN demand d ON d.item_id=w.id LEFT JOIN pending p ON p.item_id=w.id LEFT JOIN activity a ON a.item_id=w.id
    WHERE ${where.join(' AND ')} ORDER BY b.name,w.name,w.id`,[...params,now.toISOString()])).rows;
  if(!rows.length)return{summary:{positions:0,stock_value:0,excess_value:0,dead_stock_value:0,turnover:0,days_inventory:null,no_consumption_90:0,no_consumption_180:0,no_consumption_365:0,transfer_opportunities:0},rows:[],abc:{A:0,B:0,C:0},xyz:{X:0,Y:0,Z:0},generated_at:now.toISOString()};
  const ids=rows.map(x=>Number(x.id));
  const moves=(await db.query(`SELECT id,item_id,movement_type,quantity,engineer_id,unit_cost,comment,created_at FROM warehouse_movements WHERE item_id=ANY($1::int[]) AND created_at>=$2::timestamptz-interval '365 days' ORDER BY item_id,created_at DESC,id DESC`,[ids,now.toISOString()])).rows;
  const byItem=new Map();for(const m of moves){const id=Number(m.item_id);if(!byItem.has(id))byItem.set(id,[]);byItem.get(id).push(m)}
  const months=completeMonthKeys(now,6),monthly=new Map();for(const id of ids)monthly.set(id,Object.fromEntries(months.map(k=>[k,0])));for(const m of moves){if(m.movement_type!=='INSTALL')continue;const k=monthKey(new Date(m.created_at)),bucket=monthly.get(Number(m.item_id));if(bucket&&Object.prototype.hasOwnProperty.call(bucket,k))bucket[k]+=n(m.quantity)}
  const decorated=rows.map(row=>{const id=Number(row.id),qty=n(row.quantity),cost=n(row.purchase_price),reserved=n(row.reserved_quantity),service=n(row.service_demand_quantity),pending=n(row.pending_order_quantity),minimum=n(row.min_quantity),free=qty-reserved,target=minimum+reserved+service,excess=Math.max(0,qty-target),need=Math.max(0,target-qty-pending),usageQty=n(row.usage_qty_365),usageValue=n(row.usage_value_365),avg=averageInventory(qty,byItem.get(id)||[],row.created_at,now),avgValue=avg.average*cost,turnover=avgValue>0?usageValue/avgValue:0,daysInventory=turnover>0?365/turnover:null,ageDays=daysBetween(now,row.created_at),lastMovement=row.last_movement_at||row.created_at,lastConsumption=row.last_consumption_at||null,noMovement=daysBetween(now,lastMovement),noConsumption=lastConsumption?daysBetween(now,lastConsumption):ageDays,xyzClass=xyz(months.map(k=>monthly.get(id)[k]||0));return{...row,id,quantity:qty,purchase_price:cost,reserved_quantity:reserved,service_demand_quantity:service,pending_order_quantity:pending,min_quantity:minimum,free_quantity:free,target_quantity:target,excess_quantity:excess,replenishment_need_quantity:need,stock_value:qty*cost,excess_value:excess*cost,usage_qty_365:usageQty,usage_value_365:usageValue,average_inventory_qty_365:avg.average,average_inventory_value_365:avgValue,inventory_reconstruction_accuracy:avg.accuracy,turnover_365:turnover,days_inventory:daysInventory,item_age_days:ageDays,days_no_movement:noMovement,days_no_consumption:noConsumption,xyz:xyzClass.class,xyz_cv:xyzClass.cv,avg_monthly_usage_6m:xyzClass.mean,monthly_usage_6m:months.map(k=>({month:k,quantity:monthly.get(id)[k]||0})),abc:null,transfer_opportunity:null,recommendation_code:'KEEP',recommendation:'Оставить текущий уровень запаса'}});
  const totalUsage=decorated.reduce((s,x)=>s+x.usage_value_365,0),abcSorted=[...decorated].sort((a,b)=>b.usage_value_365-a.usage_value_365||a.id-b.id);let cum=0;for(const row of abcSorted){const before=totalUsage?cum/totalUsage:1;cum+=row.usage_value_365;row.abc=totalUsage<=0?'C':before<0.8?'A':before<0.95?'B':'C'}
  const groups=new Map();for(const row of decorated){const key=matchKey(row);if(!key)continue;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row)}
  for(const group of groups.values())for(const src of group.filter(x=>x.excess_quantity>0.000001)){const destinations=group.filter(x=>x.id!==src.id&&x.branch_id!==src.branch_id&&x.replenishment_need_quantity>0.000001).sort((a,b)=>b.service_demand_quantity-a.service_demand_quantity||b.replenishment_need_quantity-a.replenishment_need_quantity);if(destinations.length){const d=destinations[0],quantity=Math.min(src.excess_quantity,d.replenishment_need_quantity);src.transfer_opportunity={branch_id:d.branch_id,branch_code:d.branch_code,branch_name:d.branch_name,item_id:d.id,quantity}}}
  for(const row of decorated){const protectedDemand=row.reserved_quantity+row.service_demand_quantity;if(row.transfer_opportunity){row.recommendation_code='TRANSFER';row.recommendation=`Переместить до ${row.transfer_opportunity.quantity} в ${row.transfer_opportunity.branch_name}`}
    else if(row.replenishment_need_quantity>0&&row.service_demand_quantity>0){row.recommendation_code='PROTECT_SERVICE';row.recommendation='Дефицит блокирует активные ремонты — пополнить в приоритете'}
    else if(row.quantity>0&&row.days_no_consumption>=365&&protectedDemand<=0.000001){row.recommendation_code='REVIEW_WRITE_OFF';row.recommendation='Нет расхода 365+ дней — проверить продажу, возврат поставщику или списание'}
    else if(row.excess_quantity>0&&row.days_no_consumption>=180&&protectedDemand<=0.000001){row.recommendation_code='LIQUIDATE';row.recommendation='Неликвид 180+ дней — остановить закупку и вывести избыток'}
    else if(row.excess_quantity>0&&row.days_no_consumption>=90){row.recommendation_code='STOP_BUY';row.recommendation='Избыточный запас без расхода 90+ дней — временно не закупать'}
    else if(row.excess_quantity>0&&row.days_inventory!==null&&row.days_inventory>180){row.recommendation_code='REDUCE_STOCK';row.recommendation='Запас более чем на 180 дней — снизить целевой остаток'}
    else if(row.replenishment_need_quantity>0){row.recommendation_code='REPLENISH';row.recommendation='Остаток ниже целевого — использовать план закупок'}}
  const stockValue=decorated.reduce((s,x)=>s+x.stock_value,0),avgInventoryValue=decorated.reduce((s,x)=>s+x.average_inventory_value_365,0),usageValue=decorated.reduce((s,x)=>s+x.usage_value_365,0),turnover=avgInventoryValue>0?usageValue/avgInventoryValue:0,deadRows=decorated.filter(x=>x.quantity>0&&x.days_no_consumption>=180&&x.reserved_quantity+x.service_demand_quantity<=0.000001),abc={A:0,B:0,C:0},xyzCount={X:0,Y:0,Z:0};for(const x of decorated){abc[x.abc]++;xyzCount[x.xyz]++}
  const summary={positions:decorated.length,stock_value:stockValue,average_inventory_value_365:avgInventoryValue,usage_value_365:usageValue,turnover_365:turnover,days_inventory:turnover>0?365/turnover:null,excess_value:decorated.reduce((s,x)=>s+x.excess_value,0),dead_stock_value:deadRows.reduce((s,x)=>s+x.stock_value,0),no_consumption_30:decorated.filter(x=>x.quantity>0&&x.days_no_consumption>=30).length,no_consumption_60:decorated.filter(x=>x.quantity>0&&x.days_no_consumption>=60).length,no_consumption_90:decorated.filter(x=>x.quantity>0&&x.days_no_consumption>=90).length,no_consumption_180:decorated.filter(x=>x.quantity>0&&x.days_no_consumption>=180).length,no_consumption_365:decorated.filter(x=>x.quantity>0&&x.days_no_consumption>=365).length,transfer_opportunities:decorated.filter(x=>x.transfer_opportunity).length,estimated_reconstruction_items:decorated.filter(x=>x.inventory_reconstruction_accuracy==='ESTIMATED').length};
  const order={PROTECT_SERVICE:0,TRANSFER:1,REVIEW_WRITE_OFF:2,LIQUIDATE:3,STOP_BUY:4,REDUCE_STOCK:5,REPLENISH:6,KEEP:7};decorated.sort((a,b)=>(order[a.recommendation_code]??99)-(order[b.recommendation_code]??99)||b.stock_value-a.stock_value);
  return{generated_at:now.toISOString(),methodology:{abc:'Стоимость расхода INSTALL за 365 дней: A до 80% накопленной стоимости, B до 95%, C остаток',xyz:'Коэффициент вариации месячного расхода за 6 полных месяцев: X ≤ 0.5, Y ≤ 1.0, Z > 1.0 или нет расхода',turnover:'Стоимость расхода за 365 дней / восстановленная средняя стоимость складского остатка за период'},summary,abc,xyz:xyzCount,rows:decorated};
}

export function installWarehouseStockAnalytics(app,pool,{warehouseView,branchIds=resolveWarehouseBranchIds}={}){
  if(!warehouseView)throw new Error('warehouseView preHandler is required');
  app.get('/api/v1/warehouse-stock',{preHandler:warehouseView},async(req,reply)=>{try{const scope=await branchIds(pool,req.user),branchId=req.query?.branch_id?Number(req.query.branch_id):null;if(branchId&&Array.isArray(scope)&&!scope.includes(branchId))throw businessError('FORBIDDEN','Нет доступа к аналитике этого филиала',403);return{data:await buildWarehouseStockAnalytics(pool,{branchIds:scope,branchId,search:req.query?.search||''})}}catch(error){return fail(reply,error)}});
}
