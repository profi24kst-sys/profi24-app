import {isTechnicalRole,roleAllowed} from './rbac.js';

const SEVERITIES=new Set(['NORMAL','HIGH','CRITICAL']);
const STAGES=new Set(['REGISTERED','IN_REVIEW','REWORK','RESOLUTION_PENDING','RESOLVED']);
const CLASSIFICATIONS=new Set([
  'REPAIR_QUALITY','DIAGNOSTIC','PART','DEADLINE','DAMAGE','COMMUNICATION','PAYMENT','OTHER',
  'G1','G2','G3','G4','G5','G6','G7','G8'
]);
const OPERATIONAL_FIELDS=new Set(['text','severity','classification','stage','resolution','responsible_id','root_cause','prevention','rework_request_id','due_at','status']);
const FINANCIAL_FIELDS=new Set(['financial_impact','financial_note']);
const FINANCIAL_ROLES=new Set(['OWNER','SUPERVISOR','ACCOUNTANT']);
const text=(value,max=4000)=>String(value??'').trim().slice(0,max);
const positiveId=value=>{const n=Number(value);return Number.isSafeInteger(n)&&n>0?n:null};
const money=value=>{const n=Number(value);return Number.isFinite(n)&&n>=0?Math.round(n*100)/100:null};
const hasOwn=(obj,key)=>Object.prototype.hasOwnProperty.call(obj||{},key);

async function tableExists(db,name){
  return Boolean((await db.query('SELECT to_regclass($1) name',[`public.${name}`])).rows[0]?.name);
}

function fail(reply,code,message,status=422,details){
  return reply.code(status).send({data:null,error:{code,message,details}});
}

function defaultDue(severity){
  const hours=severity==='CRITICAL'?4:severity==='HIGH'?24:48;
  return new Date(Date.now()+hours*60*60*1000);
}

function parseDate(value){
  if(value==null||value==='')return null;
  const d=new Date(value);
  return Number.isNaN(d.getTime())?false:d;
}

async function responsibleForOrder(c,userId,order){
  if(userId==null)return null;
  const id=positiveId(userId);
  if(!id)return false;
  const user=(await c.query('SELECT id,name,role,active FROM users WHERE id=$1 AND active=true',[id])).rows[0];
  if(!user)return false;
  if(!order.branch_id||['OWNER','SUPERVISOR'].includes(user.role)||!await tableExists(c,'user_branches'))return user;
  const member=(await c.query('SELECT 1 FROM user_branches WHERE user_id=$1 AND branch_id=$2 LIMIT 1',[id,order.branch_id])).rows[0];
  return member?user:false;
}

async function validateRework(c,parentId,reworkId){
  if(reworkId==null)return true;
  const childId=positiveId(reworkId);
  if(!childId)return false;
  if(!await tableExists(c,'request_order_links'))return false;
  return Boolean((await c.query(`SELECT 1 FROM request_order_links WHERE parent_request_id=$1 AND child_request_id=$2 AND link_type IN ('REWORK','WARRANTY_REWORK') LIMIT 1`,[parentId,childId])).rows[0]);
}

async function history(c,complaint,userId,action,details={}){
  if(!complaint.request_id)return;
  await c.query('INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,$3,$4)',[
    complaint.request_id,userId,action,{complaint_id:complaint.id,complaint_number:complaint.number,...details}
  ]);
}

async function detail(db,id,user,requireOrder){
  const row=(await db.query(`
    SELECT co.*,r.number request_number,r.status request_status,r.branch_id,c.name customer_name,c.phone customer_phone,
           u.name responsible_name,rw.number rework_number,rw.status rework_status
    FROM complaints co
    JOIN requests r ON r.id=co.request_id
    JOIN customers c ON c.id=co.customer_id
    LEFT JOIN users u ON u.id=co.responsible_id
    LEFT JOIN requests rw ON rw.id=co.rework_request_id
    WHERE co.id=$1 AND r.deleted_at IS NULL`,[id])).rows[0];
  if(!row)return null;
  await requireOrder(db,user,row.request_id);
  if(!isTechnicalRole(user.role)){
    const impact=(await db.query('SELECT amount,note,updated_by,updated_at FROM complaint_financial_impacts WHERE complaint_id=$1',[row.id])).rows[0];
    row.financial_impact=impact?.amount??0;
    row.financial_note=impact?.note??null;
    row.financial_updated_at=impact?.updated_at??null;
  }
  return row;
}

export function registerComplaintRoutes(app,db,{authenticate,requireOrder,accessError}){
  const auth=async(req,reply)=>{if(!await authenticate(req,reply,db))return;};
  const roles=(...allowed)=>async(req,reply)=>{
    await auth(req,reply);if(reply.sent)return;
    if(!roleAllowed(req.user.role,allowed))return fail(reply,'FORBIDDEN','Недостаточно прав для работы с претензией',403);
  };

  app.get('/api/v1/complaints/:id',{preHandler:auth},async(req,reply)=>{
    const id=positiveId(req.params.id);if(!id)return fail(reply,'VALIDATION','Некорректная претензия');
    try{
      const row=await detail(db,id,req.user,requireOrder);
      if(!row)return fail(reply,'NOT_FOUND','Претензия не найдена',404);
      return{data:row};
    }catch(e){throw e.code?e:accessError('COMPLAINT_READ_FAILED',e.message||'Не удалось открыть претензию',500)}
  });

  app.post('/api/v1/complaints',{preHandler:roles('OWNER','SUPERVISOR','MANAGER')},async(req,reply)=>{
    const body=req.body||{},requestId=positiveId(body.source_request_id??body.request_id),description=text(body.text),severity=String(body.severity||'NORMAL').toUpperCase();
    if(!requestId)return fail(reply,'VALIDATION','Претензию необходимо связать с исходным заказом');
    if(description.length<3)return fail(reply,'VALIDATION','Опишите суть претензии или повторного обращения');
    if(!SEVERITIES.has(severity))return fail(reply,'VALIDATION','Некорректная критичность претензии');
    const due=parseDate(body.due_at);if(due===false)return fail(reply,'VALIDATION','Некорректный срок обработки претензии');
    const result=await (async()=>{
      const c=await db.connect();
      try{
        await c.query('BEGIN');
        const order=await requireOrder(c,req.user,requestId,{lock:true});
        const duplicate=(await c.query("SELECT id,number FROM complaints WHERE request_id=$1 AND status='OPEN' ORDER BY id DESC LIMIT 1 FOR UPDATE",[order.id])).rows[0];
        if(duplicate)throw accessError('ACTIVE_COMPLAINT_EXISTS',`По заказу уже открыта претензия ${duplicate.number}`,409);
        const responsible=hasOwn(body,'responsible_id')?await responsibleForOrder(c,body.responsible_id,order):null;
        if(hasOwn(body,'responsible_id')&&body.responsible_id!=null&&!responsible)throw accessError('RESPONSIBLE_BRANCH_MISMATCH','Ответственный не активен или не относится к филиалу заказа',422);
        const classification=body.classification?String(body.classification).toUpperCase():null;
        if(classification&&!CLASSIFICATIONS.has(classification))throw accessError('INVALID_CLASSIFICATION','Некорректная классификация претензии',422);
        const seq=(await c.query("SELECT nextval('complaint_number_seq') n")).rows[0].n;
        let branchCode='KST';
        if(order.branch_id&&await tableExists(c,'branches'))branchCode=(await c.query('SELECT code FROM branches WHERE id=$1',[order.branch_id])).rows[0]?.code||branchCode;
        const number=`${branchCode}-R-${new Date().getFullYear()}-${String(seq).padStart(7,'0')}`;
        const row=(await c.query(`INSERT INTO complaints(number,request_id,customer_id,text,severity,status,stage,classification,responsible_id,due_at,created_by,updated_by,updated_at)
          VALUES($1,$2,$3,$4,$5,'OPEN','REGISTERED',$6,$7,$8,$9,$9,now()) RETURNING *`,[
          number,order.id,order.customer_id,description,severity,classification,responsible?.id||null,(due||defaultDue(severity)).toISOString(),req.user.id
        ])).rows[0];
        await history(c,row,req.user.id,'COMPLAINT_CREATED',{severity,classification,responsible_id:row.responsible_id,due_at:row.due_at});
        await c.query('COMMIT');return row;
      }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
    })();
    return reply.code(201).send({data:result});
  });

  app.patch('/api/v1/complaints/:id',{preHandler:roles('OWNER','SUPERVISOR','MANAGER','ACCOUNTANT')},async(req,reply)=>{
    const id=positiveId(req.params.id),body=req.body||{};if(!id)return fail(reply,'VALIDATION','Некорректная претензия');
    const operationalKeys=Object.keys(body).filter(k=>OPERATIONAL_FIELDS.has(k));
    const financialKeys=Object.keys(body).filter(k=>FINANCIAL_FIELDS.has(k));
    if(!operationalKeys.length&&!financialKeys.length)return fail(reply,'VALIDATION','Нет изменений для сохранения');
    if(req.user.role==='ACCOUNTANT'&&operationalKeys.length)return fail(reply,'FORBIDDEN','Бухгалтер может фиксировать только финансовый ущерб претензии',403);
    if(financialKeys.length&&!FINANCIAL_ROLES.has(req.user.role))return fail(reply,'FORBIDDEN','Финансовый ущерб фиксирует собственник, управляющий или бухгалтер',403);
    const result=await (async()=>{
      const c=await db.connect();
      try{
        await c.query('BEGIN');
        const old=(await c.query('SELECT * FROM complaints WHERE id=$1 FOR UPDATE',[id])).rows[0];
        if(!old)throw accessError('NOT_FOUND','Претензия не найдена',404);
        const order=await requireOrder(c,req.user,old.request_id,{lock:true});
        if(old.status==='CLOSED'&&operationalKeys.length)throw accessError('COMPLAINT_CLOSED','Закрытую претензию сначала нужно документированно переоткрыть',409);
        let updated=old;
        if(operationalKeys.length){
          const next={...old};
          if(hasOwn(body,'text')){next.text=text(body.text);if(next.text.length<3)throw accessError('VALIDATION','Опишите суть претензии',422)}
          if(hasOwn(body,'severity')){next.severity=String(body.severity||'').toUpperCase();if(!SEVERITIES.has(next.severity))throw accessError('VALIDATION','Некорректная критичность претензии',422)}
          if(hasOwn(body,'classification')){next.classification=body.classification?String(body.classification).toUpperCase():null;if(next.classification&&!CLASSIFICATIONS.has(next.classification))throw accessError('INVALID_CLASSIFICATION','Некорректная классификация претензии',422)}
          if(hasOwn(body,'stage')){next.stage=String(body.stage||'').toUpperCase();if(!STAGES.has(next.stage))throw accessError('INVALID_STAGE','Некорректный этап претензии',422)}
          if(hasOwn(body,'resolution'))next.resolution=text(body.resolution)||null;
          if(hasOwn(body,'root_cause'))next.root_cause=text(body.root_cause)||null;
          if(hasOwn(body,'prevention'))next.prevention=text(body.prevention)||null;
          if(hasOwn(body,'due_at')){const d=parseDate(body.due_at);if(d===false)throw accessError('VALIDATION','Некорректный срок претензии',422);next.due_at=d?.toISOString()||null}
          if(hasOwn(body,'responsible_id')){
            const responsible=await responsibleForOrder(c,body.responsible_id,order);
            if(body.responsible_id!=null&&!responsible)throw accessError('RESPONSIBLE_BRANCH_MISMATCH','Ответственный не активен или не относится к филиалу заказа',422);
            next.responsible_id=responsible?.id||null;
          }
          if(hasOwn(body,'rework_request_id')){
            const reworkId=body.rework_request_id==null?null:positiveId(body.rework_request_id);
            if(body.rework_request_id!=null&&!reworkId)throw accessError('INVALID_REWORK','Некорректный повторный заказ',422);
            if(reworkId&&!await validateRework(c,old.request_id,reworkId))throw accessError('INVALID_REWORK','Повторный заказ должен быть создан штатной процедурой из исходного заказа',409);
            next.rework_request_id=reworkId;
            if(reworkId&&next.stage==='REGISTERED')next.stage='REWORK';
          }
          if(hasOwn(body,'status')){
            const status=String(body.status||'').toUpperCase();
            if(status!=='OPEN'&&status!=='CLOSED')throw accessError('INVALID_STATUS','Статус претензии может быть OPEN или CLOSED',422);
            if(status==='CLOSED'){
              if(!next.classification)throw accessError('CLASSIFICATION_REQUIRED','Перед закрытием классифицируйте претензию',409);
              if(text(next.resolution).length<3)throw accessError('RESOLUTION_REQUIRED','Перед закрытием укажите принятое решение',409);
              next.status='CLOSED';next.stage='RESOLVED';
            }
          }
          updated=(await c.query(`UPDATE complaints SET text=$1,severity=$2,status=$3,stage=$4,classification=$5,resolution=$6,responsible_id=$7,root_cause=$8,prevention=$9,rework_request_id=$10,due_at=$11,closed_at=CASE WHEN $3='CLOSED' THEN COALESCE(closed_at,now()) ELSE closed_at END,updated_by=$12,updated_at=now() WHERE id=$13 RETURNING *`,[
            next.text,next.severity,next.status,next.stage,next.classification,next.resolution,next.responsible_id,next.root_cause,next.prevention,next.rework_request_id,next.due_at,req.user.id,id
          ])).rows[0];
        }
        let impact=null;
        if(financialKeys.length){
          const amount=hasOwn(body,'financial_impact')?money(body.financial_impact):null;
          if(hasOwn(body,'financial_impact')&&amount===null)throw accessError('VALIDATION','Финансовый ущерб не может быть отрицательным',422);
          const previous=(await c.query('SELECT * FROM complaint_financial_impacts WHERE complaint_id=$1',[id])).rows[0];
          impact=(await c.query(`INSERT INTO complaint_financial_impacts(complaint_id,amount,note,updated_by,updated_at) VALUES($1,$2,$3,$4,now())
            ON CONFLICT(complaint_id) DO UPDATE SET amount=$2,note=$3,updated_by=$4,updated_at=now() RETURNING *`,[
            id,amount??Number(previous?.amount||0),hasOwn(body,'financial_note')?(text(body.financial_note)||null):(previous?.note||null),req.user.id
          ])).rows[0];
        }
        const action=old.status!=='CLOSED'&&updated.status==='CLOSED'?'COMPLAINT_CLOSED':'COMPLAINT_UPDATED';
        await history(c,updated,req.user.id,action,{fields:[...operationalKeys,...financialKeys],stage:updated.stage,status:updated.status,rework_request_id:updated.rework_request_id,financial_impact:impact?.amount});
        await c.query('COMMIT');
        return{...updated,...(!isTechnicalRole(req.user.role)?{financial_impact:impact?.amount??undefined,financial_note:impact?.note??undefined}:{})};
      }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
    })();
    return{data:result};
  });

  app.post('/api/v1/complaints/:id/reopen',{preHandler:roles('OWNER','SUPERVISOR')},async(req,reply)=>{
    const id=positiveId(req.params.id);if(!id)return fail(reply,'VALIDATION','Некорректная претензия');
    const c=await db.connect();
    try{
      await c.query('BEGIN');
      const old=(await c.query('SELECT * FROM complaints WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!old)throw accessError('NOT_FOUND','Претензия не найдена',404);
      await requireOrder(c,req.user,old.request_id,{lock:true});
      if(old.status!=='CLOSED')throw accessError('COMPLAINT_ALREADY_OPEN','Претензия уже открыта',409);
      const reason=text(req.body?.reason);if(reason.length<3)throw accessError('REOPEN_REASON_REQUIRED','Укажите причину переоткрытия претензии',422);
      const row=(await c.query("UPDATE complaints SET status='OPEN',stage='IN_REVIEW',closed_at=NULL,resolution=NULL,updated_by=$1,updated_at=now() WHERE id=$2 RETURNING *",[req.user.id,id])).rows[0];
      await history(c,row,req.user.id,'COMPLAINT_REOPENED',{reason});
      await c.query('COMMIT');return{data:row};
    }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
  });
}
