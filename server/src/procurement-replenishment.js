import {randomUUID} from 'node:crypto';
import {runSchemaStatements} from './schema-retry.js';
import {procurementReplenishmentStatements} from './procurement-replenishment-schema.js';
import {buildSmartSupplierSelections} from './smart-supplier-selection.js';

const n=v=>Number(v||0);
const clean=(v,max=500)=>String(v??'').trim().slice(0,max);
const businessError=(code,message,statusCode=409,details)=>Object.assign(new Error(message),{code,statusCode,details});
const fail=(reply,error)=>reply.code(error?.statusCode||422).send({data:null,error:{code:error?.code||'VALIDATION',message:error?.message||'Ошибка плана закупок',details:error?.details}});

export async function prepareProcurementReplenishment(pool,{logger=console}={}){
  await runSchemaStatements(pool,procurementReplenishmentStatements,{logger});
}

function decorateDemand(row){
  const stock=n(row.stock_quantity),reserved=n(row.reserved_quantity),service=n(row.service_demand_quantity),pending=n(row.pending_order_quantity),minimum=n(row.min_quantity);
  const free=stock-reserved,gross=Math.max(0,minimum+reserved+service-stock),recommended=Math.max(0,gross-pending),c30=n(row.consumption_30d),c90=n(row.consumption_90d),daily=c90/90;
  const daysCover=daily>0?Math.max(0,free)/daily:null;
  let priority='NORMAL';
  if(service>0&&recommended>0)priority='CRITICAL';
  else if(recommended>0||free<minimum)priority='HIGH';
  else if(daysCover!==null&&daysCover<14)priority='MEDIUM';
  return{...row,stock_quantity:stock,reserved_quantity:reserved,service_demand_quantity:service,pending_order_quantity:pending,min_quantity:minimum,free_quantity:free,gross_need_quantity:gross,recommended_quantity:recommended,consumption_30d:c30,consumption_90d:c90,avg_daily_consumption:daily,days_cover:daysCover,priority};
}

function withSelection(row,decision){
  const selected=decision?.selected||null,unitCost=selected?n(selected.unit_cost):n(row.purchase_price);
  return{...row,
    best_supplier_id:selected?Number(selected.supplier_id):null,
    best_supplier_name:selected?.supplier_name||null,
    best_unit_cost:unitCost,
    supplier_available_qty:selected?.supplier_available_qty==null?null:n(selected.supplier_available_qty),
    lead_time_days:selected?.lead_time_days==null?null:Number(selected.lead_time_days),
    currency:selected?.currency||'KZT',
    selection_strategy:selected?.selection_strategy||decision?.strategy||null,
    selection_score:selected?.selection_score==null?null:n(selected.selection_score),
    supplier_performance_score:selected?.supplier_performance_score==null?null:n(selected.supplier_performance_score),
    supplier_rating:selected?.supplier_rating||null,
    supplier_confidence:selected?.supplier_confidence||null,
    supplier_recommendation_code:selected?.supplier_recommendation_code||null,
    selection_reason:selected?.selection_reason||null,
    cheapest_supplier_id:selected?.cheapest_supplier_id?Number(selected.cheapest_supplier_id):null,
    cheapest_supplier_name:selected?.cheapest_supplier_name||null,
    cheapest_unit_cost:selected?.cheapest_unit_cost==null?null:n(selected.cheapest_unit_cost),
    price_premium_pct:selected?.price_premium_pct==null?null:n(selected.price_premium_pct),
    alternatives_count:selected?.alternatives_count||0,
    supplier_alternatives:(decision?.alternatives||[]).map(x=>({supplier_id:Number(x.supplier_id),supplier_name:x.supplier_name,unit_cost:n(x.unit_cost),supplier_available_qty:x.supplier_available_qty==null?null:n(x.supplier_available_qty),lead_time_days:x.lead_time_days==null?null:Number(x.lead_time_days),currency:x.currency||'KZT',source:x.source,selection_score:x.selection_score==null?null:n(x.selection_score),supplier_performance_score:x.supplier_performance_score==null?null:n(x.supplier_performance_score),supplier_rating:x.supplier_rating||null,supplier_confidence:x.supplier_confidence||null,supplier_recommendation_code:x.supplier_recommendation_code||null,auto_eligible:x.auto_eligible!==false,auto_exclusion_reason:x.auto_exclusion_reason||null})),
    estimated_value:row.recommended_quantity*unitCost
  };
}

export async function buildReplenishmentPlan(db,{branchIds=null,branchId=null,itemIds=null,needOnly=false}={}){
  const params=[],where=['w.active=true'];
  if(Array.isArray(branchIds)){
    if(!branchIds.length)return[];
    params.push(branchIds.map(Number));where.push(`w.branch_id=ANY($${params.length}::int[])`);
  }
  if(branchId){params.push(Number(branchId));where.push(`w.branch_id=$${params.length}`)}
  if(Array.isArray(itemIds)){
    if(!itemIds.length)return[];
    params.push(itemIds.map(Number));where.push(`w.id=ANY($${params.length}::int[])`);
  }
  const rows=(await db.query(`WITH reserved AS(
      SELECT sr.item_id,COALESCE(sum(sr.quantity),0)::numeric qty
      FROM stock_reservations sr JOIN requests r ON r.id=sr.request_id
      WHERE sr.status='ACTIVE' AND r.deleted_at IS NULL AND r.status NOT IN('CLOSED','CANCELLED') GROUP BY sr.item_id
    ),demand AS(
      SELECT d.item_id,COALESCE(sum(d.qty),0)::numeric qty
      FROM part_demands d JOIN requests r ON r.id=d.request_id
      WHERE d.status<>'RESOLVED' AND r.deleted_at IS NULL AND r.status NOT IN('CLOSED','CANCELLED') GROUP BY d.item_id
    ),pending AS(
      SELECT i.item_id,COALESCE(sum(GREATEST(i.qty-i.received_qty,0)),0)::numeric qty
      FROM purchase_order_items i JOIN purchase_orders po ON po.id=i.purchase_order_id
      WHERE po.status NOT IN('RECEIVED','CANCELLED') GROUP BY i.item_id
    ),consumption AS(
      SELECT m.item_id,
        COALESCE(sum(CASE WHEN m.created_at>=now()-interval '30 days' THEN m.quantity ELSE 0 END),0)::numeric c30,
        COALESCE(sum(CASE WHEN m.created_at>=now()-interval '90 days' THEN m.quantity ELSE 0 END),0)::numeric c90
      FROM warehouse_movements m WHERE m.movement_type IN('INSTALL','WRITE_OFF') GROUP BY m.item_id
    )
    SELECT w.id,w.branch_id,b.code branch_code,b.name branch_name,w.name,w.sku,w.oem_code,w.supplier,w.purchase_price,w.sale_price,
      w.quantity stock_quantity,w.min_quantity,
      COALESCE(r.qty,0)::numeric reserved_quantity,COALESCE(d.qty,0)::numeric service_demand_quantity,
      COALESCE(p.qty,0)::numeric pending_order_quantity,COALESCE(c.c30,0)::numeric consumption_30d,COALESCE(c.c90,0)::numeric consumption_90d
    FROM warehouse_items w JOIN branches b ON b.id=w.branch_id
    LEFT JOIN reserved r ON r.item_id=w.id LEFT JOIN demand d ON d.item_id=w.id LEFT JOIN pending p ON p.item_id=w.id LEFT JOIN consumption c ON c.item_id=w.id
    WHERE ${where.join(' AND ')} ORDER BY b.name,w.name,w.id`,params)).rows;
  const demandRows=rows.map(decorateDemand),decisions=await buildSmartSupplierSelections(db,demandRows),decorated=demandRows.map(row=>withSelection(row,decisions.get(Number(row.id))));
  return needOnly?decorated.filter(x=>x.recommended_quantity>0.000001):decorated;
}

async function attentionOrders(db,{branchIds=null}={}){
  const params=[],where=[`po.status NOT IN('RECEIVED','CANCELLED')`];
  if(Array.isArray(branchIds)){
    if(!branchIds.length)return[];
    params.push(branchIds.map(Number));where.push(`po.branch_id=ANY($${params.length}::int[])`);
  }
  return(await db.query(`SELECT po.id,po.number,po.branch_id,b.name branch_name,b.code branch_code,po.status,po.expected_at,po.created_at,s.name supplier_name,
      count(i.id)::int positions,COALESCE(sum(GREATEST(i.qty-i.received_qty,0)),0)::numeric remaining_qty,
      COALESCE(sum(GREATEST(i.qty-i.received_qty,0)*i.unit_cost),0)::numeric remaining_value,
      GREATEST(0,(CURRENT_DATE-COALESCE(po.expected_at,CURRENT_DATE)))::int overdue_days,
      floor(extract(epoch from(now()-po.created_at))/86400)::int age_days,
      CASE WHEN po.expected_at<CURRENT_DATE THEN true ELSE false END overdue,
      CASE WHEN po.expected_at IS NULL AND po.created_at<now()-interval '7 days' THEN true ELSE false END stale_without_eta
    FROM purchase_orders po JOIN branches b ON b.id=po.branch_id JOIN suppliers s ON s.id=po.supplier_id LEFT JOIN purchase_order_items i ON i.purchase_order_id=po.id
    WHERE ${where.join(' AND ')} GROUP BY po.id,b.name,b.code,s.name
    HAVING COALESCE(sum(GREATEST(i.qty-i.received_qty,0)),0)>0
    ORDER BY overdue DESC,stale_without_eta DESC,po.expected_at NULLS LAST,po.created_at`,params)).rows;
}

async function batchDetail(db,id){
  const batch=(await db.query(`SELECT b.*,u.name created_by_name FROM procurement_replenishment_batches b JOIN users u ON u.id=b.created_by WHERE b.id=$1`,[Number(id)])).rows[0];
  if(!batch)return null;
  const lines=(await db.query(`SELECT l.*,po.number purchase_order_number,po.status purchase_order_status FROM procurement_replenishment_lines l JOIN purchase_orders po ON po.id=l.purchase_order_id WHERE l.batch_id=$1 ORDER BY l.branch_id,l.supplier_name,l.item_name,l.id`,[batch.id])).rows;
  return{...batch,lines};
}

async function supplierFor(db,row,requestedSupplierId){
  if(!requestedSupplierId){
    if(!row.best_supplier_id)return null;
    return{supplier_id:Number(row.best_supplier_id),supplier_name:row.best_supplier_name,unit_cost:n(row.best_unit_cost),lead_time_days:row.lead_time_days,selection_strategy:row.selection_strategy,selection_score:row.selection_score,supplier_performance_score:row.supplier_performance_score,supplier_rating:row.supplier_rating,supplier_confidence:row.supplier_confidence,selection_reason:row.selection_reason,cheapest_supplier_id:row.cheapest_supplier_id,cheapest_supplier_name:row.cheapest_supplier_name,cheapest_unit_cost:row.cheapest_unit_cost,price_premium_pct:row.price_premium_pct,alternatives_count:row.alternatives_count,manual_supplier_override:false};
  }
  const supplier=(await db.query('SELECT id,name FROM suppliers WHERE id=$1 AND active=true',[Number(requestedSupplierId)])).rows[0];
  if(!supplier)throw businessError('SUPPLIER_NOT_FOUND','Поставщик не найден или отключён',404,{supplier_id:requestedSupplierId});
  const alternative=(row.supplier_alternatives||[]).find(x=>Number(x.supplier_id)===Number(supplier.id));
  if(alternative&&String(alternative.currency||'KZT').toUpperCase()!=='KZT')throw businessError('UNSUPPORTED_CURRENCY','Автоматический план закупок не проводит предложения в иностранной валюте без конвертации в KZT',409,{supplier_id:supplier.id,currency:alternative.currency});
  if(!alternative&&String(row.supplier||'').trim().toLowerCase()!==String(supplier.name).trim().toLowerCase())throw businessError('SUPPLIER_NOT_LINKED','Выбранный поставщик не связан с этой складской позицией. Сначала свяжите его прайс или укажите поставщика в карточке склада.',409,{supplier_id:supplier.id,item_id:row.id});
  const unitCost=alternative?n(alternative.unit_cost):n(row.purchase_price),lead=alternative?.lead_time_days==null?null:Number(alternative.lead_time_days),premium=row.cheapest_unit_cost>0?(unitCost-row.cheapest_unit_cost)/row.cheapest_unit_cost*100:null;
  return{supplier_id:Number(supplier.id),supplier_name:supplier.name,unit_cost:unitCost,lead_time_days:lead,selection_strategy:'MANUAL_OVERRIDE',selection_score:alternative?.selection_score??null,supplier_performance_score:alternative?.supplier_performance_score??null,supplier_rating:alternative?.supplier_rating||null,supplier_confidence:alternative?.supplier_confidence||null,selection_reason:`Ручной выбор пользователя вместо авто-рекомендации${row.best_supplier_name?` «${row.best_supplier_name}»`:''}.`,cheapest_supplier_id:row.cheapest_supplier_id,cheapest_supplier_name:row.cheapest_supplier_name,cheapest_unit_cost:row.cheapest_unit_cost,price_premium_pct:premium,alternatives_count:row.alternatives_count,manual_supplier_override:true};
}

export function installProcurementReplenishment(app,pool,{view,manage,branchIds}={}){
  if(!view||!manage||!branchIds)throw new Error('Procurement replenishment dependencies are required');

  app.get('/api/v1/replenishment',{preHandler:view},async(req,reply)=>{
    try{
      const scope=await branchIds(req.user),branchId=req.query?.branch_id?Number(req.query.branch_id):null;
      if(branchId&&Array.isArray(scope)&&!scope.map(Number).includes(branchId))throw businessError('FORBIDDEN','Нет доступа к закупкам этого филиала',403);
      const rows=await buildReplenishmentPlan(pool,{branchIds:scope,branchId,needOnly:String(req.query?.all||'')!=='1'}),attention=await attentionOrders(pool,{branchIds:scope});
      const summary={positions:rows.length,critical:rows.filter(x=>x.priority==='CRITICAL').length,high:rows.filter(x=>x.priority==='HIGH').length,recommended_units:rows.reduce((s,x)=>s+x.recommended_quantity,0),estimated_value:rows.reduce((s,x)=>s+x.estimated_value,0),missing_supplier:rows.filter(x=>x.recommended_quantity>0&&!x.best_supplier_id).length,overdue_orders:attention.filter(x=>x.overdue).length,stale_orders:attention.filter(x=>x.stale_without_eta).length,smart_selected:rows.filter(x=>x.best_supplier_id&&x.selection_strategy).length,critical_not_cheapest:rows.filter(x=>x.priority==='CRITICAL'&&n(x.price_premium_pct)>0.01).length};
      return{data:{generated_at:new Date().toISOString(),summary,rows,attention_orders:attention,selection_policy:{critical:'Критичный ремонт: 20% цена + 30% срок + 35% история поставщика + 15% наличие',stock:'Пополнение склада: 65% цена + 10% срок + 20% история + 5% наличие',currency:'Автоматически сравниваются только предложения в KZT'}}};
    }catch(error){return fail(reply,error)}
  });

  app.get('/api/v1/replenishment/batches',{preHandler:view},async(req,reply)=>{
    try{
      const limit=Math.max(1,Math.min(100,Number(req.query?.limit||30))),scope=await branchIds(req.user),params=[];
      let branchFilter='';if(Array.isArray(scope)){if(!scope.length)return{data:[]};params.push(scope.map(Number));branchFilter=`WHERE EXISTS(SELECT 1 FROM procurement_replenishment_lines l WHERE l.batch_id=b.id AND l.branch_id=ANY($1::int[]))`}
      params.push(limit);const rows=(await pool.query(`SELECT b.*,u.name created_by_name,(SELECT count(DISTINCT l.purchase_order_id)::int FROM procurement_replenishment_lines l WHERE l.batch_id=b.id) orders_count FROM procurement_replenishment_batches b JOIN users u ON u.id=b.created_by ${branchFilter} ORDER BY b.created_at DESC LIMIT $${params.length}`,params)).rows;
      return{data:rows};
    }catch(error){return fail(reply,error)}
  });

  app.get('/api/v1/replenishment/batches/:id',{preHandler:view},async(req,reply)=>{
    try{
      const data=await batchDetail(pool,req.params.id);if(!data)return fail(reply,businessError('NOT_FOUND','План закупки не найден',404));
      const scope=await branchIds(req.user);if(Array.isArray(scope)&&data.lines.some(x=>!scope.map(Number).includes(Number(x.branch_id))))return fail(reply,businessError('FORBIDDEN','Нет доступа к этому плану закупки',403));
      return{data};
    }catch(error){return fail(reply,error)}
  });

  app.post('/api/v1/replenishment/orders',{preHandler:manage},async(req,reply)=>{
    const requested=Array.isArray(req.body?.items)?req.body.items:[],key=clean(req.body?.idempotency_key||randomUUID(),120);
    if(!requested.length||requested.length>100)return fail(reply,businessError('VALIDATION','Выберите от 1 до 100 позиций',422));
    const normalized=[],seen=new Set();
    for(const raw of requested){const id=Number(raw?.item_id),quantity=raw?.quantity==null?null:Number(raw.quantity),supplierId=raw?.supplier_id==null?null:Number(raw.supplier_id);if(!Number.isInteger(id)||id<=0||seen.has(id)||quantity!==null&&(!Number.isFinite(quantity)||quantity<=0)||supplierId!==null&&(!Number.isInteger(supplierId)||supplierId<=0))return fail(reply,businessError('VALIDATION','Некорректные позиции плана закупки',422));seen.add(id);normalized.push({item_id:id,quantity,supplier_id:supplierId})}
    const scope=await branchIds(req.user),client=await pool.connect();
    try{
      await client.query('BEGIN');
      const existing=(await client.query('SELECT id FROM procurement_replenishment_batches WHERE idempotency_key=$1',[key])).rows[0];
      if(existing){await client.query('COMMIT');return{data:await batchDetail(pool,existing.id)}}
      const ids=normalized.map(x=>x.item_id),params=[ids];let lockScope='';if(Array.isArray(scope)){params.push(scope.map(Number));lockScope=` AND branch_id=ANY($2::int[])`}
      const locked=(await client.query(`SELECT id FROM warehouse_items WHERE id=ANY($1::int[])${lockScope} ORDER BY id FOR UPDATE`,params)).rows;
      if(locked.length!==ids.length)throw businessError('FORBIDDEN','Одна из позиций недоступна или удалена',403);
      const plan=await buildReplenishmentPlan(client,{branchIds:scope,itemIds:ids,needOnly:false}),byId=new Map(plan.map(x=>[Number(x.id),x])),chosen=[];
      for(const item of normalized){const row=byId.get(item.item_id);if(!row)throw businessError('NOT_FOUND','Складская позиция не найдена',404,{item_id:item.item_id});const recommended=n(row.recommended_quantity);if(recommended<=0.000001)continue;const qty=item.quantity==null?recommended:item.quantity;if(qty-recommended>0.000001)throw businessError('QUANTITY_EXCEEDS_NEED',`Для «${row.name}» сейчас требуется не более ${recommended}`,409,{item_id:row.id,recommended,requested:qty});const supplier=await supplierFor(client,row,item.supplier_id);if(!supplier)throw businessError('SUPPLIER_REQUIRED',`Для «${row.name}» не определён поставщик. Свяжите позицию с прайсом поставщика или укажите поставщика в карточке склада.`,409,{item_id:row.id});chosen.push({row,qty,supplier})}
      if(!chosen.length)throw businessError('NO_REPLENISHMENT','По выбранным позициям потребность уже закрыта текущим складом или существующими заказами поставщикам',409);
      const batchNumber=`RPL-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${randomUUID().slice(0,8).toUpperCase()}`,total=chosen.reduce((s,x)=>s+x.qty*n(x.supplier.unit_cost),0);
      const batch=(await client.query(`INSERT INTO procurement_replenishment_batches(number,idempotency_key,lines_count,total_value,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *`,[batchNumber,key,chosen.length,total,req.user.id])).rows[0];
      const groups=new Map();for(const x of chosen){const groupKey=`${x.row.branch_id}:${x.supplier.supplier_id}`;if(!groups.has(groupKey))groups.set(groupKey,[]);groups.get(groupKey).push(x)}
      for(const group of groups.values()){
        const branchId=Number(group[0].row.branch_id),supplier=group[0].supplier,maxLead=group.reduce((m,x)=>Math.max(m,Number(x.supplier.lead_time_days||0)),0),expected=maxLead>0?new Date(Date.now()+maxLead*86400000).toISOString().slice(0,10):null;
        const poNumber=`PO-RPL-${new Date().getFullYear()}-${randomUUID().slice(0,8).toUpperCase()}`;
        const po=(await client.query(`INSERT INTO purchase_orders(number,supplier_id,branch_id,status,expected_at,comment,created_by) VALUES($1,$2,$3,'ORDERED',$4,$5,$6) RETURNING *`,[poNumber,supplier.supplier_id,branchId,expected,`Автопополнение по плану ${batchNumber}`,req.user.id])).rows[0];
        for(const x of group){
          await client.query(`INSERT INTO purchase_order_items(purchase_order_id,item_id,name,qty,unit_cost) VALUES($1,$2,$3,$4,$5)`,[po.id,x.row.id,x.row.name,x.qty,x.supplier.unit_cost]);
          await client.query(`INSERT INTO procurement_replenishment_lines(batch_id,warehouse_item_id,branch_id,item_name,sku,oem_code,min_quantity,stock_quantity,reserved_quantity,service_demand_quantity,pending_order_quantity,recommended_quantity,ordered_quantity,supplier_id,supplier_name,unit_cost,purchase_order_id,priority,selection_strategy,selection_score,supplier_performance_score,supplier_rating,supplier_confidence,selection_reason,cheapest_supplier_id,cheapest_supplier_name,cheapest_unit_cost,price_premium_pct,alternatives_count,manual_supplier_override) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)`,[batch.id,x.row.id,x.row.branch_id,x.row.name,x.row.sku,x.row.oem_code,x.row.min_quantity,x.row.stock_quantity,x.row.reserved_quantity,x.row.service_demand_quantity,x.row.pending_order_quantity,x.row.recommended_quantity,x.qty,x.supplier.supplier_id,x.supplier.supplier_name,x.supplier.unit_cost,po.id,x.row.priority,x.supplier.selection_strategy,x.supplier.selection_score,x.supplier.supplier_performance_score,x.supplier.supplier_rating,x.supplier.supplier_confidence,x.supplier.selection_reason,x.supplier.cheapest_supplier_id,x.supplier.cheapest_supplier_name,x.supplier.cheapest_unit_cost,x.supplier.price_premium_pct,x.supplier.alternatives_count,x.supplier.manual_supplier_override]);
        }
      }
      await client.query('COMMIT');return reply.code(201).send({data:await batchDetail(pool,batch.id)});
    }catch(error){await client.query('ROLLBACK').catch(()=>{});return fail(reply,error)}finally{client.release()}
  });
}