import {authenticate,installOrderAccess} from './access.js';
import {canManageOperations} from './rbac.js';
import {buildOperationsActions,resolveOperationsScope} from './operations-action-center.js';
import Fastify from'fastify';import cors from'@fastify/cors';import helmet from'@fastify/helmet';import jwt from'@fastify/jwt';import pg from'pg';
const app=Fastify({logger:true});
await app.register(cors,{origin:true,credentials:true});await app.register(helmet,{contentSecurityPolicy:false});await app.register(jwt,{secret:process.env.JWT_SECRET||'dev-secret-change-me'});
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:Number(process.env.DB_POOL_MAX||10)}),q=(s,p=[])=>pool.query(s,p);
const fail=(r,c,m,s=422)=>r.code(s).send({data:null,error:{code:c,message:m}});
const auth=async(req,r)=>{if(!await authenticate(req,r,pool))return;};
const ops=async(req,r)=>{await auth(req,r);if(r.sent)return;if(!canManageOperations(req.user.role))return fail(r,'FORBIDDEN','Недостаточно прав',403)};
const stageSql=`CASE WHEN r.status='ACCEPTED' AND EXISTS(SELECT 1 FROM request_stage_events se WHERE se.request_id=r.id AND se.event='DEPART') AND NOT EXISTS(SELECT 1 FROM request_stage_events se WHERE se.request_id=r.id AND se.event='ARRIVE') THEN 'ON_ROUTE' ELSE r.status END`;
const scope=`($1::int[] IS NULL OR r.branch_id=ANY($1::int[]))`;
installOrderAccess(app,pool,'operations-center');
app.get('/health',async()=>{await q('SELECT 1');return{ok:true,service:'profi24-operations-center',version:'2.0-action-center'}});

app.get('/api/v1/operations/live',{preHandler:ops},async(req,reply)=>{try{
 const now=new Date(),resolved=await resolveOperationsScope(pool,req.user,req.query?.branch_id),branchIds=resolved.branchIds,p=[branchIds];
 const actionData=await buildOperationsActions(pool,{branchIds,now});
 const metrics=(await q(`SELECT
 count(*) FILTER(WHERE r.status NOT IN('CLOSED','CANCELLED'))::int active,
 count(*) FILTER(WHERE r.created_at>=date_trunc('day',now()))::int created_today,
 count(*) FILTER(WHERE r.status='NEW')::int new,
 count(*) FILTER(WHERE r.engineer_id IS NULL AND r.status NOT IN('CLOSED','CANCELLED'))::int unassigned,
 count(*) FILTER(WHERE r.sla_deadline<now() AND r.status NOT IN('CLOSED','CANCELLED'))::int sla_overdue,
 count(*) FILTER(WHERE r.scheduled_at<now()-interval '20 minutes' AND r.status NOT IN('CLOSED','CANCELLED','PAYMENT_REQUIRED'))::int visit_overdue,
 count(*) FILTER(WHERE r.status='APPROVAL_REQUIRED')::int approval_waiting,
 count(*) FILTER(WHERE r.status='WAITING_PART')::int waiting_parts,
 count(*) FILTER(WHERE r.status='CLOSED' AND r.closed_at>=date_trunc('day',now()))::int closed_today,
 COALESCE(sum(r.total) FILTER(WHERE r.status='CLOSED' AND r.closed_at>=date_trunc('day',now())),0)::numeric revenue_today,
 COALESCE(sum(r.total) FILTER(WHERE r.status NOT IN('CLOSED','CANCELLED')),0)::numeric active_order_value,
 COALESCE(sum(GREATEST(COALESCE(r.total,0)-COALESCE(r.paid,0),0)) FILTER(WHERE r.status NOT IN('CANCELLED')),0)::numeric receivable,
 COALESCE(sum(r.paid) FILTER(WHERE r.updated_at>=date_trunc('day',now())),0)::numeric request_paid_snapshot
 FROM requests r WHERE r.deleted_at IS NULL AND ${scope}`,p)).rows[0];
 const cash=(await q(`SELECT COALESCE(sum(CASE WHEN pay.kind='PAYMENT' THEN pay.amount ELSE -pay.amount END),0)::numeric amount,count(*) FILTER(WHERE pay.kind='PAYMENT')::int payments FROM payments pay JOIN requests r ON r.id=pay.request_id WHERE r.deleted_at IS NULL AND ${scope} AND pay.created_at>=date_trunc('day',now())`,p)).rows[0];
 const engineers=(await q(`WITH active_orders AS(
  SELECT r.id,r.number,r.engineer_id,r.status,r.scheduled_at,r.updated_at,c.name customer_name,c.phone,c.address,r.complaint,${stageSql} live_stage,
  row_number() over(partition by r.engineer_id order by CASE ${stageSql} WHEN 'DIAGNOSTICS' THEN 1 WHEN 'REPAIR' THEN 2 WHEN 'ON_ROUTE' THEN 3 WHEN 'TESTING' THEN 4 WHEN 'APPROVAL_REQUIRED' THEN 5 WHEN 'ACCEPTED' THEN 6 WHEN 'ASSIGNED' THEN 7 ELSE 8 END,r.updated_at desc) rn
  FROM requests r JOIN customers c ON c.id=r.customer_id WHERE r.deleted_at IS NULL AND r.status NOT IN('CLOSED','CANCELLED') AND r.engineer_id IS NOT NULL AND ${scope}),
 today AS(SELECT r.engineer_id,count(*) FILTER(WHERE r.created_at>=date_trunc('day',now()))::int assigned_today,count(*) FILTER(WHERE r.status='CLOSED' AND r.closed_at>=date_trunc('day',now()))::int closed_today FROM requests r WHERE r.deleted_at IS NULL AND ${scope} GROUP BY r.engineer_id)
 SELECT u.id,u.name,u.active,ao.id request_id,ao.number,ao.live_stage,ao.scheduled_at,ao.updated_at,ao.customer_name,ao.phone,ao.address,ao.complaint,COALESCE(t.assigned_today,0) assigned_today,COALESCE(t.closed_today,0) closed_today,
 (SELECT min(r2.scheduled_at) FROM requests r2 WHERE r2.deleted_at IS NULL AND r2.engineer_id=u.id AND r2.status NOT IN('CLOSED','CANCELLED') AND r2.scheduled_at>now() AND ($1::int[] IS NULL OR r2.branch_id=ANY($1::int[]))) next_visit
 FROM users u LEFT JOIN active_orders ao ON ao.engineer_id=u.id AND ao.rn=1 LEFT JOIN today t ON t.engineer_id=u.id
 WHERE u.role='ENGINEER' AND u.active=true AND ($1::int[] IS NULL OR EXISTS(SELECT 1 FROM user_branches ub WHERE ub.user_id=u.id AND ub.branch_id=ANY($1::int[])))
 ORDER BY CASE WHEN ao.live_stage='ON_ROUTE' THEN 1 WHEN ao.live_stage IN('DIAGNOSTICS','REPAIR','TESTING') THEN 2 WHEN ao.id IS NULL THEN 4 ELSE 3 END,u.name`,p)).rows;
 const timeline=(await q(`SELECT r.id,r.number,r.status,${stageSql} live_stage,r.scheduled_at,c.name customer_name,eng.name engineer_name,c.address,r.branch_id,b.name branch_name FROM requests r JOIN customers c ON c.id=r.customer_id LEFT JOIN users eng ON eng.id=r.engineer_id LEFT JOIN branches b ON b.id=r.branch_id WHERE r.deleted_at IS NULL AND r.status NOT IN('CLOSED','CANCELLED') AND ${scope} AND r.scheduled_at>=date_trunc('day',now()) AND r.scheduled_at<date_trunc('day',now())+interval '1 day' ORDER BY r.scheduled_at`,p)).rows;
 let approvals={pending:0,declined_today:0};try{approvals=(await q(`SELECT count(*) FILTER(WHERE a.status='PENDING')::int pending,count(*) FILTER(WHERE a.status='DECLINED' AND a.responded_at>=date_trunc('day',now()))::int declined_today FROM customer_approvals a JOIN requests r ON r.id=a.request_id WHERE r.deleted_at IS NULL AND ${scope}`,p)).rows[0]}catch{}
 const complaints=(await q(`SELECT count(*) FILTER(WHERE c.status='OPEN')::int open FROM complaints c LEFT JOIN requests r ON r.id=c.request_id WHERE c.status='OPEN' AND (($1::int[] IS NULL AND (c.request_id IS NULL OR r.deleted_at IS NULL)) OR ($1::int[] IS NOT NULL AND r.deleted_at IS NULL AND r.branch_id=ANY($1::int[])))`,p)).rows[0];
 const legacyAttention=actionData.actions.slice(0,100).map(a=>({id:a.request_id,number:a.number,status:a.request_status,live_stage:a.request_status,priority:a.priority,scheduled_at:a.due_at,updated_at:a.due_at,customer_name:a.customer_name,phone:a.phone,engineer_name:a.engineer_name,complaint:a.detail,reason:a.type,severity:a.severity,next_action:a.next_action,score:a.score}));
 return{data:{generated_at:now.toISOString(),scope:{branch_ids:branchIds,selected_branch_id:resolved.selectedBranchId},metrics:{...metrics,cash_today:cash.amount,payments_today:cash.payments,pending_approvals:approvals.pending,declined_today:approvals.declined_today,complaints_open:complaints.open,actions_total:actionData.summary.total,actions_critical:actionData.summary.critical,actions_high:actionData.summary.high,payment_at_risk:actionData.summary.payment_at_risk},engineers,attention:legacyAttention,timeline,action_summary:actionData.summary,actions:actionData.actions}};
 }catch(e){return fail(reply,e.code||'OPERATIONS_ERROR',e.message||'Ошибка операционного центра',e.statusCode||500)}});

app.listen({port:Number(process.env.PORT||8091),host:'0.0.0.0'});
