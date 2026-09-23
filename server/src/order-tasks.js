import {authenticate,installOrderAccess} from './access.js';
import {registerStaffTaskRoutes} from './staff-tasks.js';
import Fastify from'fastify';import cors from'@fastify/cors';import helmet from'@fastify/helmet';import jwt from'@fastify/jwt';import pg from'pg';
const app=Fastify({logger:true});await app.register(cors,{origin:true,credentials:true});await app.register(helmet,{contentSecurityPolicy:false});await app.register(jwt,{secret:process.env.JWT_SECRET||'dev-secret-change-me'});const pool=new pg.Pool({connectionString:process.env.DATABASE_URL}),q=(s,p=[])=>pool.query(s,p),n=v=>Number(v||0),fail=(r,c,m,s=422)=>r.code(s).send({data:null,error:{code:c,message:m}});
for(const s of[`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description TEXT`,`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS result TEXT`,`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ`,`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_by INT REFERENCES users(id)`,`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`,`CREATE INDEX IF NOT EXISTS idx_tasks_request_status ON tasks(request_id,status,due_at)`,`CREATE INDEX IF NOT EXISTS idx_tasks_assignee_due ON tasks(assigned_to,status,due_at)`])await q(s);
const auth=async(req,r)=>{if(!await authenticate(req,r,pool))return;};async function canSee(req,requestId){
 const x=(await q(`SELECT r.engineer_id,r.branch_id,
   EXISTS(SELECT 1 FROM user_branches ub WHERE ub.user_id=$2 AND ub.branch_id=r.branch_id) manager_member
   FROM requests r WHERE r.id=$1 AND r.deleted_at IS NULL`,[requestId,req.user.id])).rows[0];
 if(!x)return false;
 if(['OWNER','SUPERVISOR'].includes(req.user.role))return true;
 if(req.user.role==='MANAGER')return Boolean(x.manager_member);
 return req.user.role==='ENGINEER'&&Number(x.engineer_id)===Number(req.user.id);
}async function hist(requestId,user,action,details){await q('INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,$3,$4)',[requestId,user,action,details||{}])}
installOrderAccess(app,pool,'order-tasks');
registerStaffTaskRoutes(app,pool);
app.get('/health',async()=>{await q('SELECT 1');return{ok:true,service:'profi24-order-tasks',version:'1.1.0'}});
app.get('/api/v1/request/:id',{preHandler:auth},async(req,r)=>{const id=n(req.params.id);if(!await canSee(req,id))return fail(r,'FORBIDDEN','Нет доступа к задачам заказа',403);return{data:(await q(`SELECT t.*,u.name assigned_name,c.name created_by_name,cb.name completed_by_name,CASE WHEN t.status NOT IN ('DONE','CANCELLED') AND t.due_at IS NOT NULL AND t.due_at<now() THEN true ELSE false END overdue FROM tasks t JOIN users u ON u.id=t.assigned_to LEFT JOIN users c ON c.id=t.created_by LEFT JOIN users cb ON cb.id=t.completed_by WHERE t.request_id=$1 ORDER BY CASE WHEN t.status='DONE' THEN 1 ELSE 0 END,CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END,t.due_at,t.created_at DESC`,[id])).rows}});
app.get('/api/v1/my',{preHandler:auth},async req=>{const openOnly=req.query?.all!=='true';return{data:(await q(`SELECT t.*,r.number request_number,c.name customer_name,CASE WHEN t.status NOT IN ('DONE','CANCELLED') AND t.due_at IS NOT NULL AND t.due_at<now() THEN true ELSE false END overdue FROM tasks t LEFT JOIN requests r ON r.id=t.request_id LEFT JOIN customers c ON c.id=r.customer_id WHERE t.assigned_to=$1 AND ($2::boolean=false OR t.status NOT IN ('DONE','CANCELLED')) AND (t.request_id IS NULL OR r.deleted_at IS NULL) ORDER BY overdue DESC,t.due_at NULLS LAST,t.created_at DESC`,[req.user.id,openOnly])).rows}});
app.post('/api/v1/request/:id/comment',{preHandler:auth},async(req,r)=>{const id=n(req.params.id),text=String(req.body?.text||'').trim();if(!await canSee(req,id))return fail(r,'FORBIDDEN','Нет доступа к заказу',403);if(text.length<1)return fail(r,'VALIDATION','Введите комментарий');if(text.length>2000)return fail(r,'VALIDATION','Комментарий слишком длинный');await hist(id,req.user.id,'ORDER_COMMENT',{text});return r.code(201).send({data:{ok:true,text}})});
app.post('/api/v1/request/:id',{preHandler:auth},async(req,r)=>{const id=n(req.params.id),b=req.body||{};if(!await canSee(req,id))return fail(r,'FORBIDDEN','Нет доступа к заказу',403);if(!b.title?.trim()||!n(b.assigned_to))return fail(r,'VALIDATION','Укажите задачу и ответственного');const u=(await q('SELECT id,name,active FROM users WHERE id=$1',[n(b.assigned_to)])).rows[0];if(!u?.active)return fail(r,'VALIDATION','Ответственный сотрудник не найден');if(req.user.role==='ENGINEER'&&Number(b.assigned_to)!==Number(req.user.id))return fail(r,'FORBIDDEN','Инженер может поставить задачу только себе',403);const member=(await q('SELECT 1 FROM requests r JOIN user_branches ub ON ub.branch_id=r.branch_id AND ub.user_id=$2 WHERE r.id=$1 AND r.deleted_at IS NULL LIMIT 1',[id,n(b.assigned_to)])).rows[0];if(!member)return fail(r,'INVALID_ASSIGNEE','Сотрудник не относится к филиалу заказа',422);const x=(await q(`INSERT INTO tasks(title,description,request_id,assigned_to,priority,status,due_at,created_by,updated_at) VALUES($1,$2,$3,$4,$5,'OPEN',$6,$7,now()) RETURNING *`,[b.title.trim(),b.description?.trim()||null,id,n(b.assigned_to),['LOW','NORMAL','HIGH','URGENT'].includes(b.priority)?b.priority:'NORMAL',b.due_at||null,req.user.id])).rows[0];await hist(id,req.user.id,'ORDER_TASK_CREATED',{task_id:x.id,title:x.title,assigned_to:x.assigned_to,due_at:x.due_at,priority:x.priority});return r.code(201).send({data:x})});
app.patch('/api/v1/tasks/:id',{preHandler:auth},async(req,reply)=>{
  const t=(await q('SELECT * FROM tasks WHERE id=$1',[req.params.id])).rows[0];
  if(!t)return fail(reply,'NOT_FOUND','Задача не найдена',404);
  const isManager=req.user.role==='MANAGER';
  const managerOwn=isManager&&(t.request_id
    ?await canSee(req,t.request_id)
    :Number(t.created_by)===Number(req.user.id));
  const admin=['OWNER','SUPERVISOR'].includes(req.user.role)||managerOwn;
  const mine=Number(t.assigned_to)===Number(req.user.id);
  if(!admin&&!mine)return fail(reply,'FORBIDDEN','Нет доступа к задаче',403);

  const b=req.body||{},status=b.status??t.status;
  if(!['OPEN','IN_PROGRESS','DONE','CANCELLED'].includes(status))
    return fail(reply,'VALIDATION','Некорректный статус');
  if(status==='CANCELLED'&&!admin)
    return fail(reply,'FORBIDDEN','Отменять поручения может только руководитель',403);
  if(status==='DONE'&&!String(b.result??t.result??'').trim())
    return fail(reply,'RESULT_REQUIRED','При завершении укажите результат выполнения');

  const metadataChange=['title','description','priority','due_at','assigned_to']
    .some(key=>Object.hasOwn(b,key));
  if(metadataChange&&!admin)
    return fail(reply,'FORBIDDEN','Изменять поручение и ответственного может только руководитель',403);

  const title=Object.hasOwn(b,'title')?String(b.title??'').trim():t.title;
  const description=Object.hasOwn(b,'description')?String(b.description??'').trim()||null:t.description;
  const priority=Object.hasOwn(b,'priority')?String(b.priority??'').toUpperCase():t.priority;
  if(!title||title.length>200)return fail(reply,'VALIDATION','Название задачи: от 1 до 200 символов');
  if(description?.length>4000)return fail(reply,'VALIDATION','Описание задачи слишком длинное');
  if(!['LOW','NORMAL','HIGH','URGENT'].includes(priority))return fail(reply,'VALIDATION','Некорректный приоритет');

  let dueAt=t.due_at;
  if(Object.hasOwn(b,'due_at')){
    if(b.due_at==null||b.due_at==='')dueAt=null;
    else{
      const date=new Date(b.due_at);
      if(!Number.isFinite(date.getTime()))return fail(reply,'VALIDATION','Некорректный срок выполнения');
      dueAt=date.toISOString();
    }
  }

  let assignedTo=t.assigned_to;
  if(Object.hasOwn(b,'assigned_to')){
    assignedTo=n(b.assigned_to);
    if(!Number.isSafeInteger(assignedTo)||assignedTo<1)
      return fail(reply,'VALIDATION','Укажите действующего ответственного');
    const user=(await q('SELECT id FROM users WHERE id=$1 AND active=true',[assignedTo])).rows[0];
    if(!user)return fail(reply,'INVALID_ASSIGNEE','Сотрудник не найден или неактивен',422);
    if(t.request_id){
      const member=(await q('SELECT 1 FROM requests r JOIN user_branches ub ON ub.branch_id=r.branch_id AND ub.user_id=$2 WHERE r.id=$1 AND r.deleted_at IS NULL LIMIT 1',[t.request_id,assignedTo])).rows[0];
      if(!member)return fail(reply,'INVALID_ASSIGNEE','Сотрудник не относится к филиалу заказа',422);
    }else if(isManager){
      const shared=(await q('SELECT 1 FROM user_branches mb JOIN user_branches ub ON ub.branch_id=mb.branch_id WHERE mb.user_id=$1 AND ub.user_id=$2 LIMIT 1',[req.user.id,assignedTo])).rows[0];
      if(!shared)return fail(reply,'FORBIDDEN','Менеджер может переназначать задачи только в своих филиалах',403);
    }
  }

  const completed=status==='DONE'?new Date():null;
  const started=status==='IN_PROGRESS'&&!t.started_at?new Date():t.started_at;
  const x=(await q('UPDATE tasks SET title=$1,description=$2,assigned_to=$3,priority=$4,status=$5,due_at=$6,result=$7,started_at=$8,completed_at=$9,completed_by=$10,updated_at=now() WHERE id=$11 RETURNING *',[
    title,description,assignedTo,priority,status,dueAt,b.result??t.result,
    started,completed,status==='DONE'?req.user.id:null,t.id
  ])).rows[0];
  if(t.request_id)await hist(t.request_id,req.user.id,status==='DONE'?'ORDER_TASK_COMPLETED':'ORDER_TASK_UPDATED',{
    task_id:t.id,title:x.title,status:x.status,result:x.result,due_at:x.due_at,
    on_time:status==='DONE'&&(!x.due_at||new Date(x.completed_at)<=new Date(x.due_at))
  });
  return{data:x};
});
app.delete('/api/v1/tasks/:id',{preHandler:auth},async(req,r)=>{if(req.user.role!=='OWNER')return fail(r,'FORBIDDEN','Удалять задачи может только владелец',403);const t=(await q('DELETE FROM tasks WHERE id=$1 RETURNING *',[req.params.id])).rows[0];if(!t)return fail(r,'NOT_FOUND','Задача не найдена',404);if(t.request_id)await hist(t.request_id,req.user.id,'ORDER_TASK_DELETED',{task_id:t.id,title:t.title});return{data:{ok:true}}});
app.listen({port:Number(process.env.PORT||8105),host:'0.0.0.0'});
