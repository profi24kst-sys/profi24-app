import {authenticate} from './access.js';

const CREATORS=new Set(['OWNER','SUPERVISOR','MANAGER']);
const PRIORITIES=new Set(['LOW','NORMAL','HIGH','URGENT']);
const TERMINAL=new Set(['DONE','CANCELLED']);
const MAX_ITEMS=500;

function fail(reply,code,message,status=422){
  return reply.code(status).send({data:null,error:{code,message}});
}

function positiveId(value){
  const num=Number(value);
  return Number.isSafeInteger(num)&&num>0?num:null;
}

export function parseStaffTaskInput(body={}){
  const title=String(body.title??'').trim();
  const description=String(body.description??'').trim();
  const assignee=positiveId(body.assigned_to);
  const priority=String(body.priority??'NORMAL').trim().toUpperCase();
  if(!title||title.length>200)return{error:'Название задачи обязательно, максимум 200 символов'};
  if(description.length>4000)return{error:'Описание задачи не может быть длиннее 4000 символов'};
  if(!assignee)return{error:'Укажите ответственного сотрудника'};
  if(!PRIORITIES.has(priority))return{error:'Некорректный приоритет задачи'};
  if(body.request_id!=null&&body.request_id!=='')return{error:'Задачу по заказу создавайте из карточки заказа'};
  let dueAt=null;
  if(body.due_at!=null&&body.due_at!==''){
    const date=new Date(body.due_at);
    if(!Number.isFinite(date.getTime()))return{error:'Некорректная дата выполнения'};
    dueAt=date.toISOString();
  }
  return{value:{title,description:description||null,assigned_to:assignee,priority,due_at:dueAt}};
}

export function staffTaskVisibility(role,userId){
  if(role==='OWNER'||role==='SUPERVISOR')return{clause:null,params:[]};
  if(role==='MANAGER')return{clause:'(t.assigned_to=$1 OR t.created_by=$1)',params:[userId]};
  return{clause:'t.assigned_to=$1',params:[userId]};
}

export function registerStaffTaskRoutes(app,pool){
  const q=(sql,params=[])=>pool.query(sql,params);
  const auth=async(req,reply)=>{await authenticate(req,reply,pool);};
  const creator=(req,reply)=>CREATORS.has(req.user.role)||fail(reply,'FORBIDDEN','Назначать задачи может собственник, управляющий или менеджер',403);

  async function isEligibleAssignee(actor,userId){
    const user=(await q('SELECT id,name,role,active FROM users WHERE id=$1',[userId])).rows[0];
    if(!user?.active)return{error:'Ответственный сотрудник не найден или неактивен'};
    if(actor.role==='MANAGER'){
      const member=(await q(`SELECT 1 FROM user_branches manager_branch
        JOIN user_branches employee_branch ON employee_branch.branch_id=manager_branch.branch_id
        WHERE manager_branch.user_id=$1 AND employee_branch.user_id=$2 LIMIT 1`,[actor.id,userId])).rows[0];
      if(!member)return{error:'Менеджер может назначать задачи только сотрудникам своего филиала',status:403};
    }
    return{user};
  }

  app.get('/api/v1/tasks/assignees',{preHandler:auth},async(req,reply)=>{
    if(!creator(req,reply))return;
    const params=[],where=['u.active=true'];
    if(req.user.role==='MANAGER'){
      params.push(req.user.id);
      where.push(`EXISTS(SELECT 1 FROM user_branches mb
        JOIN user_branches eb ON eb.branch_id=mb.branch_id
        WHERE mb.user_id=$1 AND eb.user_id=u.id)`);
    }
    const employees=(await q(`SELECT u.id,u.name,u.role FROM users u
      WHERE ${where.join(' AND ')} ORDER BY u.name,u.id`,params)).rows;
    return{data:employees};
  });

  app.get('/api/v1/tasks',{preHandler:auth},async(req,reply)=>{
    const params=[],where=['(t.request_id IS NULL OR r.deleted_at IS NULL)'];
    const visibility=staffTaskVisibility(req.user.role,req.user.id);
    if(visibility.clause){
      params.push(...visibility.params);
      where.push(visibility.clause);
    }
    const bind=value=>{params.push(value);return '$'+params.length;};
    const status=String(req.query?.status||'active').toLowerCase();
    if(status==='active')where.push("t.status IN ('OPEN','IN_PROGRESS')");
    else if(status==='overdue')where.push("t.status IN ('OPEN','IN_PROGRESS') AND t.due_at<now()");
    else if(status==='done')where.push("t.status='DONE'");
    else if(status==='cancelled')where.push("t.status='CANCELLED'");
    else if(status==='all'){}
    else return fail(reply,'VALIDATION','Неизвестный фильтр статуса');
    if(req.query?.mine==='true')where.push(`t.assigned_to=${bind(req.user.id)}`);
    const assigned=req.query?.assigned_to?positiveId(req.query.assigned_to):null;
    if(req.query?.assigned_to&&!assigned)return fail(reply,'VALIDATION','Некорректный ответственный');
    if(assigned)where.push(`t.assigned_to=${bind(assigned)}`);
    const priority=String(req.query?.priority||'').toUpperCase();
    if(priority){
      if(!PRIORITIES.has(priority))return fail(reply,'VALIDATION','Некорректный фильтр приоритета');
      where.push(`t.priority=${bind(priority)}`);
    }
    const max=Math.min(MAX_ITEMS,Math.max(1,Number(req.query?.limit)||MAX_ITEMS));
    const limit=Number.isSafeInteger(max)?max:MAX_ITEMS;
    const rows=(await q(`SELECT
       t.id,t.title,t.description,t.request_id,t.assigned_to,t.priority,t.status,
       t.due_at,t.created_at,t.updated_at,t.started_at,t.completed_at,t.completed_by,t.result,t.created_by,
       assignee.name assigned_name,creator.name created_by_name,
       r.number request_number,
       CASE WHEN t.status NOT IN ('DONE','CANCELLED') AND t.due_at IS NOT NULL AND t.due_at<now()
            THEN true ELSE false END overdue
      FROM tasks t
      JOIN users assignee ON assignee.id=t.assigned_to
      LEFT JOIN users creator ON creator.id=t.created_by
      LEFT JOIN requests r ON r.id=t.request_id
      WHERE ${where.join(' AND ')}
      ORDER BY
        CASE WHEN t.status IN ('DONE','CANCELLED') THEN 1 ELSE 0 END,
        CASE WHEN t.status NOT IN ('DONE','CANCELLED') AND t.due_at<now() THEN 0 ELSE 1 END,
        t.due_at NULLS LAST,t.created_at DESC,t.id DESC
      LIMIT ${bind(limit)}`,params)).rows;
    return{data:rows,meta:{limit,has_more_possible:rows.length===limit}};
  });

  app.post('/api/v1/tasks',{preHandler:auth},async(req,reply)=>{
    if(!creator(req,reply))return;
    const parsed=parseStaffTaskInput(req.body||{});
    if(parsed.error)return fail(reply,'VALIDATION',parsed.error);
    const b=parsed.value,eligible=await isEligibleAssignee(req.user,b.assigned_to);
    if(eligible.error)return fail(reply,'INVALID_ASSIGNEE',eligible.error,eligible.status||422);
    const task=(await q(`INSERT INTO tasks(
      title,description,request_id,assigned_to,priority,status,due_at,created_by,updated_at
    ) VALUES($1,$2,NULL,$3,$4,'OPEN',$5,$6,now()) RETURNING *`,[
      b.title,b.description,b.assigned_to,b.priority,b.due_at,req.user.id
    ])).rows[0];
    return reply.code(201).send({data:{...task,assigned_name:eligible.user.name,created_by_name:req.user.name}});
  });
}
