import {canAccessAllOrders,canMutateOrder,isAssignedOnly,isKnownRole} from './rbac.js';

// Shared authentication and order authorization for every API service.
const authenticated = Symbol('active-user');
export function accessError(code, message, statusCode = 409) {
  return Object.assign(new Error(message), {code, statusCode});
}
export async function authenticate(req, reply, db) {
  if (req[authenticated]) return true;
  try { await req.jwtVerify(); }
  catch { reply.code(401).send({data:null,error:{code:'UNAUTHORIZED',message:'Требуется авторизация'}}); return false; }
  const user = (await db.query('SELECT id,name,email,role,primary_branch_id FROM users WHERE id=$1 AND active=true', [req.user.id])).rows[0];
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
  if(user.role==='ENGINEER'){
    const member=(await db.query(`SELECT 1 FROM request_participants WHERE request_id=$1 AND user_id=$2 AND participant_role='ENGINEER' AND removed_at IS NULL LIMIT 1`,[order.id,user.id])).rows[0];
    return Boolean(member);
  }
  if(user.role==='TRAINEE'){
    const member=(await db.query(`
      SELECT 1
      FROM request_participants rp
      JOIN user_mentors um ON um.trainee_id=rp.user_id AND um.mentor_id=rp.mentor_id
      JOIN users mentor ON mentor.id=um.mentor_id AND mentor.role='ENGINEER' AND mentor.active=true
      WHERE rp.request_id=$1
        AND rp.user_id=$2
        AND rp.participant_role='TRAINEE'
        AND rp.removed_at IS NULL
        AND rp.mentor_id=rp.mentor_id
        AND $3::int=um.mentor_id
      LIMIT 1`,[order.id,user.id,order.engineer_id])).rows[0];
    return Boolean(member);
  }
  return false;
}

async function hasManagerBranchAccess(db,user,order){
  if(user.role!=='MANAGER')return true;
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
