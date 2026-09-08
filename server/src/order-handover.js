import {requireOrder} from './access.js';

const clean=(v,max=240)=>String(v??'').replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,max);
const fail=(reply,code,message,status=422)=>reply.code(status).send({data:null,error:{code,message}});

export async function installOrderHandover(app,pool,{roles}){
  const q=(sql,p=[])=>pool.query(sql,p);
  for(const sql of[
    `CREATE TABLE IF NOT EXISTS request_handovers(
      request_id INT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'READY' CHECK(status IN('READY','HANDED_OVER')),
      ready_at TIMESTAMPTZ NOT NULL DEFAULT now(),ready_by INT NOT NULL REFERENCES users(id),ready_note TEXT,
      handed_over_at TIMESTAMPTZ,handed_over_by INT REFERENCES users(id),recipient_name TEXT,recipient_phone TEXT,recipient_relation TEXT,
      recipient_confirmed BOOLEAN NOT NULL DEFAULT false,handover_note TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK(status<>'HANDED_OVER' OR (handed_over_at IS NOT NULL AND handed_over_by IS NOT NULL AND recipient_name IS NOT NULL AND recipient_confirmed=true)))`,
    `CREATE INDEX IF NOT EXISTS idx_request_handovers_status_ready ON request_handovers(status,ready_at)`,
    `CREATE TABLE IF NOT EXISTS generated_documents(id SERIAL PRIMARY KEY,request_id INT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,document_type TEXT NOT NULL,document_number TEXT NOT NULL,created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now())`,
    `CREATE OR REPLACE FUNCTION guard_request_handover_integrity() RETURNS trigger AS $$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Документированную выдачу нельзя удалять' USING ERRCODE='P2409'; END IF;
        IF OLD.status='HANDED_OVER' AND to_jsonb(NEW)-ARRAY['updated_at']<>to_jsonb(OLD)-ARRAY['updated_at'] THEN
          RAISE EXCEPTION 'Факт выдачи неизменяем. Исправление оформляется отдельным событием' USING ERRCODE='P2409';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS guard_request_handover ON request_handovers`,
    `CREATE TRIGGER guard_request_handover BEFORE UPDATE OR DELETE ON request_handovers FOR EACH ROW EXECUTE FUNCTION guard_request_handover_integrity()`
  ])await q(sql);

  async function scopedOrder(user,id,lock=false,client=pool){return requireOrder(client,user,id,{lock});}
  async function history(c,requestId,userId,action,details={}){await c.query('INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,$3,$4)',[requestId,userId,action,details]);}
  async function managerBranches(user){if(user.role!=='MANAGER')return null;return (await q('SELECT branch_id FROM user_branches WHERE user_id=$1',[user.id])).rows.map(x=>Number(x.branch_id));}
  async function detail(requestId){
    const row=(await q(`SELECT h.*,rb.name ready_by_name,hb.name handed_over_by_name
      FROM request_handovers h LEFT JOIN users rb ON rb.id=h.ready_by LEFT JOIN users hb ON hb.id=h.handed_over_by WHERE h.request_id=$1`,[requestId])).rows[0];
    return row||{request_id:Number(requestId),status:'NOT_READY',ready_at:null,handed_over_at:null};
  }

  app.get('/api/v1/handovers/summary',{preHandler:roles('OWNER','SUPERVISOR','ACCOUNTANT','MANAGER')},async req=>{
    const branches=await managerBranches(req.user),params=[],scope=branches===null?'TRUE':(params.push(branches),`r.branch_id=ANY($${params.length}::int[])`);
    const row=(await q(`SELECT
      count(*) FILTER(WHERE h.status='READY')::int ready,
      count(*) FILTER(WHERE h.status='READY' AND h.ready_at<now()-interval '3 days')::int waiting_over_3_days,
      count(*) FILTER(WHERE h.status='READY' AND h.ready_at<now()-interval '7 days')::int waiting_over_7_days,
      count(*) FILTER(WHERE h.status='HANDED_OVER' AND h.handed_over_at>=date_trunc('day',now()))::int handed_over_today
      FROM request_handovers h JOIN requests r ON r.id=h.request_id WHERE r.deleted_at IS NULL AND ${scope}`,params)).rows[0];
    return{data:row};
  });

  app.get('/api/v1/handovers',{preHandler:roles('OWNER','SUPERVISOR','ACCOUNTANT','MANAGER')},async req=>{
    const branches=await managerBranches(req.user),status=clean(req.query?.status,20).toUpperCase(),params=[];let where=['r.deleted_at IS NULL'];
    if(branches!==null){params.push(branches);where.push(`r.branch_id=ANY($${params.length}::int[])`)}
    if(status){if(!['READY','HANDED_OVER'].includes(status))return{data:[]};params.push(status);where.push(`h.status=$${params.length}`)}
    const rows=(await q(`SELECT h.*,r.number,r.status request_status,r.branch_id,c.name customer_name,c.phone customer_phone,b.name branch_name,
      e.category,e.brand,e.model,e.serial_number,rb.name ready_by_name,hb.name handed_over_by_name,
      GREATEST(0,floor(extract(epoch from (COALESCE(h.handed_over_at,now())-h.ready_at))/86400))::int days_waiting
      FROM request_handovers h JOIN requests r ON r.id=h.request_id JOIN customers c ON c.id=r.customer_id LEFT JOIN equipment e ON e.id=r.equipment_id
      LEFT JOIN branches b ON b.id=r.branch_id LEFT JOIN users rb ON rb.id=h.ready_by LEFT JOIN users hb ON hb.id=h.handed_over_by
      WHERE ${where.join(' AND ')} ORDER BY CASE h.status WHEN 'READY' THEN 0 ELSE 1 END,h.ready_at`,params)).rows;
    return{data:rows};
  });

  app.get('/api/v1/handovers/:requestId',{preHandler:roles('OWNER','SUPERVISOR','ACCOUNTANT','MANAGER','ENGINEER','TRAINEE')},async(req,reply)=>{
    try{await scopedOrder(req.user,req.params.requestId);return{data:await detail(req.params.requestId)}}catch(e){return fail(reply,e.code||'FORBIDDEN',e.message,e.statusCode||403)}
  });

  app.post('/api/v1/handovers/:requestId/ready',{preHandler:roles('OWNER','SUPERVISOR','MANAGER')},async(req,reply)=>{
    const c=await pool.connect();try{
      await c.query('BEGIN');const order=await scopedOrder(req.user,req.params.requestId,true,c);
      if(order.status!=='CLOSED'||!order.closed_at)return failAfterRollback(c,reply,'ORDER_NOT_CLOSED','К выдаче можно готовить только документированно закрытый заказ',409);
      const old=(await c.query('SELECT * FROM request_handovers WHERE request_id=$1 FOR UPDATE',[order.id])).rows[0];
      if(old?.status==='HANDED_OVER')return failAfterRollback(c,reply,'ALREADY_HANDED_OVER','Техника уже выдана клиенту',409);
      if(old?.status==='READY'){await c.query('COMMIT');return reply.send({data:old})}
      const note=clean(req.body?.note,1000)||null;
      const row=(await c.query(`INSERT INTO request_handovers(request_id,status,ready_by,ready_note) VALUES($1,'READY',$2,$3) RETURNING *`,[order.id,req.user.id,note])).rows[0];
      await history(c,order.id,req.user.id,'HANDOVER_READY',{ready_note:note});await c.query('COMMIT');return reply.code(201).send({data:row});
    }catch(e){await c.query('ROLLBACK').catch(()=>{});if(e.statusCode)return fail(reply,e.code||'HANDOVER_FAILED',e.message,e.statusCode);throw e}finally{c.release()}
  });

  app.post('/api/v1/handovers/:requestId/complete',{preHandler:roles('OWNER','SUPERVISOR','MANAGER')},async(req,reply)=>{
    const recipient=clean(req.body?.recipient_name,160),phone=clean(req.body?.recipient_phone,80)||null,relation=clean(req.body?.recipient_relation,120)||null,note=clean(req.body?.note,1000)||null;
    if(recipient.length<2)return fail(reply,'RECIPIENT_REQUIRED','Укажите ФИО получателя');
    if(req.body?.recipient_confirmed!==true)return fail(reply,'CONFIRMATION_REQUIRED','Подтвердите, что получатель принял технику и комплектность');
    const c=await pool.connect();try{
      await c.query('BEGIN');const order=await scopedOrder(req.user,req.params.requestId,true,c);
      if(order.status!=='CLOSED'||!order.closed_at)return failAfterRollback(c,reply,'ORDER_NOT_CLOSED','Выдача доступна только для документированно закрытого заказа',409);
      const h=(await c.query('SELECT * FROM request_handovers WHERE request_id=$1 FOR UPDATE',[order.id])).rows[0];
      if(!h)return failAfterRollback(c,reply,'NOT_READY','Сначала отметьте технику готовой к выдаче',409);
      if(h.status==='HANDED_OVER'){await c.query('COMMIT');return reply.send({data:h})}
      const row=(await c.query(`UPDATE request_handovers SET status='HANDED_OVER',handed_over_at=now(),handed_over_by=$2,recipient_name=$3,recipient_phone=$4,recipient_relation=$5,recipient_confirmed=true,handover_note=$6,updated_at=now() WHERE request_id=$1 RETURNING *`,[order.id,req.user.id,recipient,phone,relation,note])).rows[0];
      const number=`HANDOVER-${order.id}-${Date.now().toString().slice(-8)}`;
      await c.query(`INSERT INTO generated_documents(request_id,document_type,document_number,created_by)
        SELECT $1,'HANDOVER_ACT',$2,$3 WHERE NOT EXISTS(SELECT 1 FROM generated_documents WHERE request_id=$1 AND document_type='HANDOVER_ACT')`,[order.id,number,req.user.id]);
      await history(c,order.id,req.user.id,'HANDOVER_COMPLETED',{recipient_name:recipient,recipient_phone:phone,recipient_relation:relation,recipient_confirmed:true,note});
      await c.query('COMMIT');return{data:row};
    }catch(e){await c.query('ROLLBACK').catch(()=>{});if(e.statusCode)return fail(reply,e.code||'HANDOVER_FAILED',e.message,e.statusCode);throw e}finally{c.release()}
  });

  return{detail};
}

async function failAfterRollback(c,reply,code,message,status){await c.query('ROLLBACK');reply.code(status).send({data:null,error:{code,message}});return reply;}
