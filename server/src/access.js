import {canAccessAllOrders,canMutateOrder,isAssignedOnly,isKnownRole} from './rbac.js';

// Shared authentication and order authorization for every API service.
const authenticated = Symbol('active-user');
export function accessError(code, message, statusCode = 409) {
  return Object.assign(new Error(message), {code, statusCode});
}
async function tableExists(db,name){
  return Boolean((await db.query('SELECT to_regclass($1) name',[`public.${name}`])).rows[0]?.name);
}
async function managerBranchIds(db,userId){
  if(!await tableExists(db,'user_branches'))return null;
  return (await db.query('SELECT branch_id FROM user_branches WHERE user_id=$1 ORDER BY branch_id',[userId])).rows.map(x=>Number(x.branch_id));
}
async function allowedManagerRequestIds(db,userId,requestIds){
  const ids=[...new Set((requestIds||[]).map(Number).filter(Number.isSafeInteger))];
  if(!ids.length)return new Set();
  const branches=await managerBranchIds(db,userId);
  if(branches===null)return new Set(ids);
  if(!branches.length)return new Set();
  const rows=(await db.query('SELECT id FROM requests WHERE id=ANY($1::int[]) AND branch_id=ANY($2::int[]) AND deleted_at IS NULL',[ids,branches])).rows;
  return new Set(rows.map(x=>Number(x.id)));
}
export async function authenticate(req, reply, db) {
  if (req[authenticated]) return true;
  try { await req.jwtVerify(); }
  catch { reply.code(401).send({data:null,error:{code:'UNAUTHORIZED',message:'Требуется авторизация'}}); return false; }
  let user;
  try{user=(await db.query('SELECT id,name,email,role,primary_branch_id FROM users WHERE id=$1 AND active=true', [req.user.id])).rows[0];}
  catch(error){if(error.code!=='42703')throw error;user=(await db.query('SELECT id,name,email,role FROM users WHERE id=$1 AND active=true',[req.user.id])).rows[0];}
  if (!user) { reply.code(403).send({data:null,error:{code:'FORBIDDEN',message:'Пользователь неактивен'}}); return false; }
  if (!isKnownRole(user.role)) { reply.code(403).send({data:null,error:{code:'FORBIDDEN',message:'Роль пользователя не поддерживается'}}); return false; }
  req.user = user;
  req[authenticated] = true;
  return true;
}
export function assertOrderMutable(order) {
  if (['CLOSED','CANCELLED'].includes(order.status)) {
    throw accessError('ORDER_FINISHED','Заказ закрыт или отменён. Используйте документированную процедуру исправления.');
  }
}

async function hasTechnicalOrderAccess(db,user,order){
  if(user.role==='ENGINEER'&&Number(order.engineer_id)===Number(user.id))return true;
  const participantsReady=await tableExists(db,'request_participants');
  if(user.role==='ENGINEER'){
    if(!participantsReady)return false;
    const member=(await db.query(`SELECT 1 FROM request_participants WHERE request_id=$1 AND user_id=$2 AND participant_role='ENGINEER' AND removed_at IS NULL LIMIT 1`,[order.id,user.id])).rows[0];
    return Boolean(member);
  }
  if(user.role==='TRAINEE'){
    if(!participantsReady||!await tableExists(db,'user_mentors'))return false;
    const member=(await db.query(`
      SELECT 1
      FROM request_participants rp
      JOIN user_mentors um ON um.trainee_id=rp.user_id AND um.mentor_id=rp.mentor_id
      JOIN users mentor ON mentor.id=um.mentor_id AND mentor.role='ENGINEER' AND mentor.active=true
      WHERE rp.request_id=$1
        AND rp.user_id=$2
        AND rp.participant_role='TRAINEE'
        AND rp.removed_at IS NULL
        AND $3::int=um.mentor_id
      LIMIT 1`,[order.id,user.id,order.engineer_id])).rows[0];
    return Boolean(member);
  }
  return false;
}

async function hasManagerBranchAccess(db,user,order){
  if(user.role!=='MANAGER')return true;
  // Finance/unit tests and pre-branch legacy databases may not have branch tables yet.
  // Production branch migration creates them before services start.
  if(!await tableExists(db,'user_branches'))return true;
  if(!order.branch_id)return false;
  const row=(await db.query('SELECT 1 FROM user_branches WHERE user_id=$1 AND branch_id=$2 LIMIT 1',[user.id,order.branch_id])).rows[0];
  return Boolean(row);
}

export async function requireOrder(db, user, requestId, {mutable=false, lock=false}={}) {
  const id = Number(requestId);
  if (!Number.isSafeInteger(id) || id < 1) throw accessError('VALIDATION','Некорректный номер заказа',422);
  const order = (await db.query(`SELECT * FROM requests WHERE id=$1${lock?' FOR UPDATE':''}`, [id])).rows[0];
  if (!order || order.deleted_at) throw accessError('NOT_FOUND','Заказ не найден',404);
  if (user) {
    if (!isKnownRole(user.role)) throw accessError('FORBIDDEN','Роль пользователя не поддерживается',403);
    if (isAssignedOnly(user.role) && !await hasTechnicalOrderAccess(db,user,order)) {
      throw accessError('FORBIDDEN','Нет доступа к этому заказу',403);
    }
    if (!isAssignedOnly(user.role) && !canAccessAllOrders(user.role)) {
      throw accessError('FORBIDDEN','Нет доступа к заказам',403);
    }
    if (!await hasManagerBranchAccess(db,user,order)) {
      throw accessError('FORBIDDEN','Заказ относится к другому филиалу',403);
    }
  }
  if (mutable) assertOrderMutable(order);
  return order;
}

// Child resources must resolve their order too: hiding a screen is not authorization.
const children = {
  'index2': {works:'request_works',parts:'parts',payments:'payments',tasks:'tasks'},
  'diagnostic-flow': {lines:'request_quote_lines'},
  'documents': {files:'request_files'},
  'parts-orchestrator': {'special-orders':'special_part_orders'},
  'procurement': {reservations:'stock_reservations'},
  'communications': {queue:'message_queue'},
  'order-tasks': {tasks:'tasks'}
};
export function installOrderAccess(app, db, service) {
  app.setErrorHandler((e, req, reply) => {
    const status = ({P2400:422,P2401:409,P2403:403,P2409:409,23505:409,23503:409,23514:422})[e.code] || e.statusCode || e.status || 500;
    if (status >= 500) req.log.error(e);
    return reply.code(status).send({data:null,error:{code:e.code || 'INTERNAL_ERROR',message:status>=500?'Не удалось выполнить действие. Обновите страницу и повторите.':e.message}});
  });

  if(service==='index2')app.addHook('preSerialization',async(req,reply,payload)=>{
    if(req.user?.role!=='MANAGER'||!payload||payload.data==null)return payload;
    const route=req.routeOptions?.url||'';
    const branches=await managerBranchIds(db,req.user.id);
    if(branches===null)return payload;
    if(route==='/api/v1/requests'&&Array.isArray(payload.data)){
      payload.data=payload.data.filter(row=>branches.includes(Number(row.branch_id)));
      return payload;
    }
    if(route==='/api/v1/customers'&&Array.isArray(payload.data)){
      const ids=payload.data.map(x=>Number(x.id)).filter(Number.isSafeInteger);
      if(!ids.length||!branches.length){payload.data=payload.data.map(x=>({...x,request_count:0,lifetime_paid:0}));return payload;}
      const rows=(await db.query(`SELECT customer_id,count(*)::int request_count,COALESCE(sum(paid),0)::numeric lifetime_paid FROM requests WHERE deleted_at IS NULL AND branch_id=ANY($1::int[]) AND customer_id=ANY($2::int[]) GROUP BY customer_id`,[branches,ids])).rows;
      const agg=new Map(rows.map(x=>[Number(x.customer_id),x]));
      payload.data=payload.data.map(x=>{const a=agg.get(Number(x.id));return {...x,request_count:a?.request_count||0,lifetime_paid:a?.lifetime_paid||0}});
      return payload;
    }
    if((route==='/api/v1/complaints'||route==='/api/v1/dispatch-controls')&&Array.isArray(payload.data)){
      const allowed=await allowedManagerRequestIds(db,req.user.id,payload.data.map(x=>x.request_id));
      payload.data=payload.data.filter(x=>x.request_id!=null&&allowed.has(Number(x.request_id)));
      return payload;
    }
    if(route==='/api/v1/dashboard'&&payload.data&&typeof payload.data==='object'&&!Array.isArray(payload.data)){
      if(!branches.length){payload.data={...payload.data,total:0,new:0,active:0,closed:0,overdue:0,gross_profit:0,tasks_open:0,complaints_open:0};return payload;}
      const orders=(await db.query(`SELECT count(*)::int total,count(*) FILTER(WHERE status='NEW')::int new,count(*) FILTER(WHERE status NOT IN ('CLOSED','CANCELLED'))::int active,count(*) FILTER(WHERE status='CLOSED')::int closed,count(*) FILTER(WHERE sla_deadline<now() AND status NOT IN ('CLOSED','CANCELLED'))::int overdue,COALESCE(sum(total-direct_cost) FILTER(WHERE status='CLOSED'),0)::numeric gross_profit FROM requests WHERE deleted_at IS NULL AND branch_id=ANY($1::int[])`,[branches])).rows[0];
      const tasks=(await db.query(`SELECT count(DISTINCT t.id)::int c FROM tasks t LEFT JOIN requests r ON r.id=t.request_id WHERE t.status='OPEN' AND (t.assigned_to=$2 OR (r.deleted_at IS NULL AND r.branch_id=ANY($1::int[])))`,[branches,req.user.id])).rows[0].c;
      const complaints=(await db.query(`SELECT count(*)::int c FROM complaints co JOIN requests r ON r.id=co.request_id WHERE co.status='OPEN' AND r.deleted_at IS NULL AND r.branch_id=ANY($1::int[])`,[branches])).rows[0].c;
      payload.data={...payload.data,...orders,tasks_open:tasks,complaints_open:complaints};
      return payload;
    }
    if(route==='/api/v1/dashboard/finance'&&payload.data&&typeof payload.data==='object'&&!Array.isArray(payload.data)){
      const totals=branches.length?(await db.query(`SELECT COALESCE(sum(total),0)::numeric revenue,COALESCE(sum(direct_cost),0)::numeric direct_cost,COALESCE(sum(total-direct_cost),0)::numeric gross_profit,COALESCE(sum(paid),0)::numeric paid,COALESCE(sum(GREATEST(total-paid,0)),0)::numeric outstanding FROM requests WHERE created_at>=date_trunc('month',now()) AND deleted_at IS NULL AND status<>'CANCELLED' AND branch_id=ANY($1::int[])`,[branches])).rows[0]:{revenue:0,direct_cost:0,gross_profit:0,paid:0,outstanding:0};
      payload.data={totals};
      return payload;
    }
    return payload;
  });

  app.addHook('preHandler', async (req, reply) => {
    const route = req.routeOptions.url;
    if (!route?.startsWith('/api/') || route === '/api/v1/auth/login') return;
    if (!await authenticate(req, reply, db)) return reply;
    let requestId;
    if (/\/(requests|request)\/:/.test(route)) requestId = req.params.requestId ?? req.params.id;
    if (requestId == null && req.body?.request_id != null) requestId = req.body.request_id;
    if (requestId == null && req.query?.request_id != null) requestId = req.query.request_id;
    if (requestId == null) {
      for (const [resource, table] of Object.entries(children[service] || {})) {
        if (!route.includes('/'+resource+'/:')) continue;
        const id = req.params.lineId ?? req.params.id;
        const row = (await db.query(`SELECT request_id FROM ${table} WHERE id=$1`, [id])).rows[0];
        if (!row) throw accessError('NOT_FOUND','Запись не найдена',404);
        requestId = row.request_id;
        break;
      }
    }
    if (requestId == null) return;
    const readOnly = ['GET','HEAD'].includes(req.method);
    if (!readOnly && !canMutateOrder(req.user.role,{service,route,method:req.method})) {
      throw accessError('FORBIDDEN','Эта роль не может изменять ремонт или его операционные данные',403);
    }
    // These routes have their own documented correction/replay checks. Comments remain append-only.
    const documented = service==='communications' || /\/(refund|cancel|cancellation-readiness|notes|comment|documents)$/.test(route);
    const order = await requireOrder(db, req.user, requestId, {mutable:!readOnly && !documented});
    req.order = order;
  });
}

// Modules create some tables after core migrations. Attach the same database guard then.
export async function protectOrderTables(db, tables) {
  await transaction(db,async c=>{
    for (const table of tables) {
      if (!/^[a-z_]+$/.test(table)) throw new Error('Invalid internal table name');
      await c.query(`DROP TRIGGER IF EXISTS guard_order_mutation ON ${table}`);
      await c.query(`CREATE TRIGGER guard_order_mutation BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION guard_order_child_mutation()`);
    }
  });
}

export async function transaction(db, fn) {
  const c = await db.connect();
  try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; }
  catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}
