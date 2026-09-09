import {authenticate} from './access.js';
import {can,PERMISSIONS} from './rbac.js';
import {runSchemaStatements} from './schema-retry.js';
import {warehouseInventoryStatements} from './warehouse-inventory-schema.js';

const n=v=>Number(v||0);
const clean=(v,max=1000)=>String(v??'').trim().slice(0,max);
const globalBranchRoles=new Set(['OWNER','SUPERVISOR','ACCOUNTANT']);
const businessError=(code,message,statusCode=409,details)=>Object.assign(new Error(message),{code,statusCode,details});
const fail=(reply,error)=>reply.code(error?.statusCode||422).send({data:null,error:{code:error?.code||'VALIDATION',message:error?.message||'Ошибка инвентаризации',details:error?.details}});

export async function prepareWarehouseInventory(pool,{logger=console}={}){
  await runSchemaStatements(pool,warehouseInventoryStatements,{logger});
}

async function branchIds(pool,user){
  if(globalBranchRoles.has(user.role))return null;
  return (await pool.query('SELECT branch_id FROM user_branches WHERE user_id=$1',[user.id])).rows.map(x=>Number(x.branch_id));
}

async function assertBranchAccess(pool,user,branchId){
  const id=Number(branchId);
  if(!id)throw businessError('VALIDATION','Укажите филиал',422);
  if(globalBranchRoles.has(user.role))return id;
  const ok=(await pool.query('SELECT 1 FROM user_branches WHERE user_id=$1 AND branch_id=$2',[user.id,id])).rows[0];
  if(!ok)throw businessError('FORBIDDEN','Нет доступа к складу этого филиала',403);
  return id;
}

async function getInventory(pool,user,id,{lock=false}={}){
  const row=(await pool.query(`SELECT wi.*,b.code branch_code,b.name branch_name,su.name started_by_name,pu.name posted_by_name,cu.name cancelled_by_name
    FROM warehouse_inventories wi JOIN branches b ON b.id=wi.branch_id JOIN users su ON su.id=wi.started_by
    LEFT JOIN users pu ON pu.id=wi.posted_by LEFT JOIN users cu ON cu.id=wi.cancelled_by
    WHERE wi.id=$1${lock?' FOR UPDATE OF wi':''}`,[Number(id)])).rows[0];
  if(!row)throw businessError('NOT_FOUND','Инвентаризация не найдена',404);
  await assertBranchAccess(pool,user,row.branch_id);
  return row;
}

async function detail(pool,user,id){
  const doc=await getInventory(pool,user,id);
  const lines=(await pool.query(`SELECT wil.*,u.name counted_by_name FROM warehouse_inventory_lines wil LEFT JOIN users u ON u.id=wil.counted_by WHERE wil.inventory_id=$1 ORDER BY wil.item_name,wil.id`,[doc.id])).rows;
  const counted=lines.filter(x=>x.actual_quantity!==null&&x.actual_quantity!==undefined).length;
  const varianceUnits=lines.reduce((s,x)=>s+n(x.variance),0);
  const varianceValue=lines.reduce((s,x)=>s+n(x.variance)*n(x.unit_cost),0);
  return {...doc,lines,summary:{positions:lines.length,counted,remaining:lines.length-counted,variance_units:varianceUnits,variance_value:varianceValue}};
}

export function installWarehouseInventory(app,pool){
  const tx=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const out=await fn(c);await c.query('COMMIT');return out}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}};
  const auth=async(req,reply)=>{if(!await authenticate(req,reply,pool))return};
  const permit=permission=>async(req,reply)=>{await auth(req,reply);if(reply.sent)return;if(!can(req.user.role,permission))return reply.code(403).send({data:null,error:{code:'FORBIDDEN',message:'Недостаточно прав для инвентаризации склада'}})};
  const view=permit(PERMISSIONS.WAREHOUSE_VIEW),manage=permit(PERMISSIONS.WAREHOUSE_INVENTORY);

  app.get('/api/v1/inventories',{preHandler:view},async(req,reply)=>{
    try{
      const ids=await branchIds(pool,req.user),params=[],where=[];
      if(ids){params.push(ids);where.push(`wi.branch_id=ANY($${params.length}::int[])`)}
      if(req.query?.branch_id){const branchId=await assertBranchAccess(pool,req.user,req.query.branch_id);params.push(branchId);where.push(`wi.branch_id=$${params.length}`)}
      if(req.query?.status){const status=clean(req.query.status,20).toUpperCase();if(!['DRAFT','POSTED','CANCELLED'].includes(status))throw businessError('VALIDATION','Некорректный статус',422);params.push(status);where.push(`wi.status=$${params.length}`)}
      const rows=(await pool.query(`SELECT wi.*,b.code branch_code,b.name branch_name,u.name started_by_name,
        count(l.id)::int positions,count(l.id) FILTER(WHERE l.actual_quantity IS NOT NULL)::int counted,
        COALESCE(sum(l.variance),0)::numeric variance_units,COALESCE(sum(l.variance*l.unit_cost),0)::numeric variance_value
        FROM warehouse_inventories wi JOIN branches b ON b.id=wi.branch_id JOIN users u ON u.id=wi.started_by
        LEFT JOIN warehouse_inventory_lines l ON l.inventory_id=wi.id
        ${where.length?'WHERE '+where.join(' AND '):''}
        GROUP BY wi.id,b.code,b.name,u.name ORDER BY wi.started_at DESC LIMIT 300`,params)).rows;
      return{data:rows};
    }catch(e){return fail(reply,e)}
  });

  app.get('/api/v1/inventories/:id',{preHandler:view},async(req,reply)=>{try{return{data:await detail(pool,req.user,req.params.id)}}catch(e){return fail(reply,e)}});

  app.post('/api/v1/inventories',{preHandler:manage},async(req,reply)=>{
    try{
      const branchId=await assertBranchAccess(pool,req.user,req.body?.branch_id);
      const result=await tx(async c=>{
        const branch=(await c.query('SELECT id,code,name FROM branches WHERE id=$1 AND active=true FOR SHARE',[branchId])).rows[0];
        if(!branch)throw businessError('NOT_FOUND','Филиал не найден или отключён',404);
        const open=(await c.query("SELECT id,number FROM warehouse_inventories WHERE branch_id=$1 AND status='DRAFT' FOR UPDATE",[branchId])).rows[0];
        if(open)throw businessError('INVENTORY_ALREADY_OPEN',`По филиалу уже идёт инвентаризация ${open.number}`,409,{inventory_id:open.id});
        const items=(await c.query('SELECT id,name,sku,oem_code,location,purchase_price,quantity,updated_at FROM warehouse_items WHERE branch_id=$1 AND active=true ORDER BY id FOR SHARE',[branchId])).rows;
        if(!items.length)throw businessError('EMPTY_STOCK','В филиале нет активных складских позиций',409);
        const date=new Date().toISOString().slice(0,10).replaceAll('-',''),suffix=Math.random().toString(36).slice(2,7).toUpperCase();
        const number=`INV-${branch.code}-${date}-${suffix}`;
        const doc=(await c.query(`INSERT INTO warehouse_inventories(number,branch_id,note,document_reference,started_by) VALUES($1,$2,$3,$4,$5) RETURNING *`,[number,branchId,clean(req.body?.note,2000)||null,clean(req.body?.document_reference,300)||null,req.user.id])).rows[0];
        for(const item of items)await c.query(`INSERT INTO warehouse_inventory_lines(inventory_id,item_id,item_name,sku,oem_code,location,unit_cost,expected_quantity,snapshot_updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[doc.id,item.id,item.name,item.sku,item.oem_code,item.location,item.purchase_price,item.quantity,item.updated_at]);
        return doc;
      });
      return reply.code(201).send({data:await detail(pool,req.user,result.id)});
    }catch(e){if(e?.code==='23505')return fail(reply,businessError('INVENTORY_ALREADY_OPEN','По филиалу уже идёт незавершённая инвентаризация',409));return fail(reply,e)}
  });

  app.patch('/api/v1/inventories/:id/lines/:lineId',{preHandler:manage},async(req,reply)=>{
    try{
      const actual=req.body?.actual_quantity;
      if(actual!==null&&actual!==undefined&&(!Number.isFinite(Number(actual))||Number(actual)<0))throw businessError('VALIDATION','Фактическое количество должно быть 0 или больше',422);
      await tx(async c=>{
        const doc=await getInventory(c,req.user,req.params.id,{lock:true});
        if(doc.status!=='DRAFT')throw businessError('INVENTORY_LOCKED','Можно считать только черновик инвентаризации',409);
        const line=(await c.query('SELECT * FROM warehouse_inventory_lines WHERE id=$1 AND inventory_id=$2 FOR UPDATE',[Number(req.params.lineId),doc.id])).rows[0];
        if(!line)throw businessError('NOT_FOUND','Строка инвентаризации не найдена',404);
        if(actual===null||actual===undefined){await c.query('UPDATE warehouse_inventory_lines SET actual_quantity=NULL,variance=NULL,counted_by=NULL,counted_at=NULL,note=$1 WHERE id=$2',[clean(req.body?.note,1000)||null,line.id])}
        else{const value=Number(actual),variance=value-n(line.expected_quantity);await c.query('UPDATE warehouse_inventory_lines SET actual_quantity=$1,variance=$2,counted_by=$3,counted_at=clock_timestamp(),note=$4 WHERE id=$5',[value,variance,req.user.id,clean(req.body?.note,1000)||null,line.id])}
      });
      return{data:await detail(pool,req.user,req.params.id)};
    }catch(e){return fail(reply,e)}
  });

  app.post('/api/v1/inventories/:id/post',{preHandler:manage},async(req,reply)=>{
    try{
      await tx(async c=>{
        const doc=await getInventory(c,req.user,req.params.id,{lock:true});
        if(doc.status!=='DRAFT')throw businessError('INVENTORY_LOCKED','Инвентаризация уже проведена или отменена',409);
        const lines=(await c.query('SELECT * FROM warehouse_inventory_lines WHERE inventory_id=$1 ORDER BY item_id FOR UPDATE',[doc.id])).rows;
        const uncounted=lines.filter(x=>x.actual_quantity===null||x.actual_quantity===undefined);
        if(uncounted.length)throw businessError('INVENTORY_INCOMPLETE',`Не пересчитано позиций: ${uncounted.length}`,409,{line_ids:uncounted.map(x=>x.id)});
        const current=(await c.query('SELECT id,quantity,updated_at,purchase_price,sale_price FROM warehouse_items WHERE branch_id=$1 AND active=true ORDER BY id FOR UPDATE',[doc.branch_id])).rows;
        if(current.length!==lines.length||current.some((item,i)=>Number(item.id)!==Number(lines[i].item_id)))throw businessError('INVENTORY_STALE','Состав склада изменился после начала пересчёта. Создайте новый снимок.',409);
        const reservations=(await c.query("SELECT item_id,COALESCE(sum(quantity),0)::numeric reserved FROM stock_reservations WHERE branch_id=$1 AND status='ACTIVE' GROUP BY item_id",[doc.branch_id])).rows;
        const reserved=new Map(reservations.map(x=>[Number(x.item_id),n(x.reserved)]));
        for(let i=0;i<lines.length;i++){
          const line=lines[i],item=current[i],expected=n(line.expected_quantity),nowQty=n(item.quantity),actual=n(line.actual_quantity);
          if(Math.abs(nowQty-expected)>0.000001||new Date(item.updated_at).getTime()!==new Date(line.snapshot_updated_at).getTime())throw businessError('INVENTORY_STALE',`По позиции «${line.item_name}» было движение или изменение после начала пересчёта. Обновите инвентаризацию.`,409,{item_id:item.id});
          const reservedQty=reserved.get(Number(item.id))||0;
          if(actual+0.000001<reservedQty)throw businessError('RESERVATION_CONFLICT',`Фактический остаток «${line.item_name}» (${actual}) меньше активного резерва (${reservedQty})`,409,{item_id:item.id,reserved:reservedQty,actual});
        }
        for(let i=0;i<lines.length;i++){
          const line=lines[i],item=current[i],expected=n(line.expected_quantity),actual=n(line.actual_quantity),variance=actual-expected;
          if(Math.abs(variance)<=0.000001)continue;
          await c.query('UPDATE warehouse_items SET quantity=$1,updated_at=clock_timestamp() WHERE id=$2',[actual,item.id]);
          const direction=variance>0?'Излишек':'Недостача';
          await c.query(`INSERT INTO warehouse_movements(item_id,movement_type,quantity,unit_cost,sale_price,comment,created_by) VALUES($1,'ADJUSTMENT',$2,$3,$4,$5,$6)`,[item.id,Math.abs(variance),item.purchase_price,item.sale_price,`Инвентаризация ${doc.number}: ${direction}; учёт ${expected}; факт ${actual}`,req.user.id]);
        }
        await c.query("UPDATE warehouse_inventories SET status='POSTED',posted_by=$1,posted_at=clock_timestamp() WHERE id=$2",[req.user.id,doc.id]);
      });
      return{data:await detail(pool,req.user,req.params.id)};
    }catch(e){return fail(reply,e)}
  });

  app.post('/api/v1/inventories/:id/cancel',{preHandler:manage},async(req,reply)=>{
    try{
      const reason=clean(req.body?.reason,1000);if(reason.length<3)throw businessError('VALIDATION','Укажите причину отмены',422);
      await tx(async c=>{const doc=await getInventory(c,req.user,req.params.id,{lock:true});if(doc.status!=='DRAFT')throw businessError('INVENTORY_LOCKED','Можно отменить только черновик инвентаризации',409);await c.query("UPDATE warehouse_inventories SET status='CANCELLED',cancelled_by=$1,cancelled_at=clock_timestamp(),cancel_reason=$2 WHERE id=$3",[req.user.id,reason,doc.id])});
      return{data:await detail(pool,req.user,req.params.id)};
    }catch(e){return fail(reply,e)}
  });
}
