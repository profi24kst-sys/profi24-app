import {authenticate,installOrderAccess} from './access.js';
import {can,PERMISSIONS} from './rbac.js';
import {installWarehouseStockAnalytics,resolveWarehouseBranchIds} from './warehouse-stock-analytics.js';
import {installSupplierPerformanceAnalytics,resolveSupplierPerformanceBranchIds} from './supplier-performance-analytics.js';
import {installEngineerCapacityAnalytics,resolveEngineerCapacityBranchIds} from './engineer-capacity-analytics.js';
import {installEngineerRoutePlanning,resolveEngineerRouteBranchIds} from './engineer-route-planning.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import pg from 'pg';

const app=Fastify({logger:true});
await app.register(cors,{origin:(process.env.CORS_ORIGIN||'http://localhost:5173').split(',').map(x=>x.trim()),credentials:true});
await app.register(helmet,{contentSecurityPolicy:false});
await app.register(rateLimit,{max:300,timeWindow:'1 minute'});
await app.register(jwt,{secret:process.env.JWT_SECRET||'dev-secret-change-me'});

const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:Number(process.env.DB_POOL_MAX||10)});
const q=(s,p=[])=>pool.query(s,p);
const fail=(r,c,m,s=422)=>r.code(s).send({data:null,error:{code:c,message:m}});
const n=v=>Number(v||0);
await q('ALTER TABLE requests ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ');

const auth=async(req,reply)=>{if(!await authenticate(req,reply,pool))return;};
const owner=async(req,reply)=>{await auth(req,reply);if(reply.sent)return;if(req.user.role!=='OWNER')return fail(reply,'FORBIDDEN','Раздел аналитики доступен владельцу',403)};
const warehouseView=async(req,reply)=>{await auth(req,reply);if(reply.sent)return;if(!can(req.user.role,PERMISSIONS.WAREHOUSE_VIEW))return fail(reply,'FORBIDDEN','Недостаточно прав для аналитики склада',403)};
const procurementView=async(req,reply)=>{await auth(req,reply);if(reply.sent)return;if(!can(req.user.role,PERMISSIONS.PROCUREMENT_VIEW))return fail(reply,'FORBIDDEN','Недостаточно прав для аналитики поставщиков',403)};
const operationsView=async(req,reply)=>{await auth(req,reply);if(reply.sent)return;if(!can(req.user.role,PERMISSIONS.OPERATIONS_MANAGE))return fail(reply,'FORBIDDEN','Недостаточно прав для диспетчеризации',403)};
const routeView=async(req,reply)=>{await auth(req,reply);if(reply.sent)return;if(req.user.role!=='ENGINEER'&&!can(req.user.role,PERMISSIONS.OPERATIONS_MANAGE))return fail(reply,'FORBIDDEN','Недостаточно прав для просмотра маршрута',403)};
function range(month){const d=month?new Date(month+'-01T00:00:00Z'):new Date();const s=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1)),e=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1));return[s,e]}

installOrderAccess(app,pool,'analytics');
installWarehouseStockAnalytics(app,pool,{warehouseView,branchIds:resolveWarehouseBranchIds});
installSupplierPerformanceAnalytics(app,pool,{procurementView,branchIds:resolveSupplierPerformanceBranchIds});
installEngineerCapacityAnalytics(app,pool,{operationsView,branchIds:resolveEngineerCapacityBranchIds});
installEngineerRoutePlanning(app,pool,{operationsView,routeView,branchIdsResolver:resolveEngineerRouteBranchIds});
app.get('/health',async()=>{await q('SELECT 1');return{ok:true,service:'profi24-analytics',version:'2.4-engineer-route'}});

app.get('/api/v1/dashboard',{preHandler:owner},async req=>{
 const[s,e]=range(req.query?.month);
 const summary=(await q(`SELECT count(*) FILTER(WHERE deleted_at IS NULL AND created_at>=$1 AND created_at<$2)::int created,count(*) FILTER(WHERE deleted_at IS NULL AND status='CLOSED' AND closed_at>=$1 AND closed_at<$2)::int closed,COALESCE(sum(total) FILTER(WHERE deleted_at IS NULL AND status='CLOSED' AND closed_at>=$1 AND closed_at<$2),0)::numeric revenue,COALESCE(sum(direct_cost) FILTER(WHERE deleted_at IS NULL AND status='CLOSED' AND closed_at>=$1 AND closed_at<$2),0)::numeric direct_cost,COALESCE(sum(total-direct_cost) FILTER(WHERE deleted_at IS NULL AND status='CLOSED' AND closed_at>=$1 AND closed_at<$2),0)::numeric gross_profit,COALESCE(avg(total) FILTER(WHERE deleted_at IS NULL AND status='CLOSED' AND closed_at>=$1 AND closed_at<$2),0)::numeric avg_check FROM requests`,[s,e])).rows[0];
 const statuses=(await q(`SELECT status,count(*)::int count FROM requests WHERE deleted_at IS NULL AND created_at>=$1 AND created_at<$2 GROUP BY status ORDER BY count DESC`,[s,e])).rows;
 const engineers=(await q(`SELECT u.id,u.name,count(r.id)::int jobs,COALESCE(sum(r.total),0)::numeric revenue,COALESCE(sum(r.total-r.direct_cost),0)::numeric gross_profit,COALESCE(avg(r.total),0)::numeric avg_check FROM users u LEFT JOIN requests r ON r.engineer_id=u.id AND r.deleted_at IS NULL AND r.status='CLOSED' AND r.closed_at>=$1 AND r.closed_at<$2 WHERE u.role='ENGINEER' GROUP BY u.id,u.name ORDER BY gross_profit DESC`,[s,e])).rows;
 const managers=(await q(`SELECT u.id,u.name,count(r.id)::int jobs,COALESCE(sum(r.total),0)::numeric revenue,COALESCE(sum(r.total-r.direct_cost),0)::numeric gross_profit,COALESCE(avg(r.total),0)::numeric avg_check FROM users u LEFT JOIN requests r ON r.manager_id=u.id AND r.deleted_at IS NULL AND r.status='CLOSED' AND r.closed_at>=$1 AND r.closed_at<$2 WHERE u.role='MANAGER' GROUP BY u.id,u.name ORDER BY revenue DESC`,[s,e])).rows;
 const sources=(await q(`SELECT COALESCE(source,'Не указан') source,count(*)::int leads,count(*) FILTER(WHERE status='CLOSED')::int closed,COALESCE(sum(total) FILTER(WHERE status='CLOSED'),0)::numeric revenue FROM requests WHERE deleted_at IS NULL AND created_at>=$1 AND created_at<$2 GROUP BY COALESCE(source,'Не указан') ORDER BY leads DESC`,[s,e])).rows;
 const claims=(await q(`SELECT count(*)::int total,count(*) FILTER(WHERE status NOT IN ('CLOSED','CANCELLED'))::int open FROM complaints WHERE created_at>=$1 AND created_at<$2`,[s,e])).rows[0];
 return{data:{month:s.toISOString().slice(0,7),summary:{...summary,margin:n(summary.revenue)?n(summary.gross_profit)/n(summary.revenue)*100:0,close_rate:n(summary.created)?n(summary.closed)/n(summary.created)*100:0},statuses,engineers,managers,sources,claims}};
});

app.get('/api/v1/orders-profit',{preHandler:owner},async req=>{
 const[s,e]=range(req.query?.month);
 return{data:(await q(`SELECT r.id,r.number,r.status,r.closed_at,c.name customer_name,u.name engineer_name,m.name manager_name,r.total::numeric,r.direct_cost::numeric,(r.total-r.direct_cost)::numeric gross_profit,CASE WHEN r.total>0 THEN ((r.total-r.direct_cost)/r.total*100) ELSE 0 END::numeric margin FROM requests r JOIN customers c ON c.id=r.customer_id LEFT JOIN users u ON u.id=r.engineer_id LEFT JOIN users m ON m.id=r.manager_id WHERE r.deleted_at IS NULL AND r.status='CLOSED' AND r.closed_at>=$1 AND r.closed_at<$2 ORDER BY gross_profit DESC`,[s,e])).rows};
});

app.get('/api/v1/financial-audit',{preHandler:owner},async req=>{
 const[s,e]=range(req.query?.month);
 const rows=(await q(`SELECT r.id,r.number,r.closed_at,c.name customer_name,u.name engineer_name,r.total::numeric,r.direct_cost::numeric,(r.total-r.direct_cost)::numeric gross_profit,CASE WHEN r.total>0 THEN ((r.total-r.direct_cost)/r.total*100) ELSE 0 END::numeric margin FROM requests r JOIN customers c ON c.id=r.customer_id LEFT JOIN users u ON u.id=r.engineer_id WHERE r.deleted_at IS NULL AND r.status='CLOSED' AND r.closed_at>=$1 AND r.closed_at<$2 ORDER BY r.total DESC`,[s,e])).rows;
 const totals=rows.map(x=>n(x.total)).filter(x=>x>0).sort((a,b)=>a-b),median=totals.length?(totals.length%2?totals[(totals.length-1)/2]:(totals[totals.length/2-1]+totals[totals.length/2])/2):0,threshold=Math.max(500000,median*5),orders=rows.map(x=>{const total=n(x.total),cost=n(x.direct_cost),margin=n(x.margin),flags=[];if(total>=threshold)flags.push('HIGH_CHECK');if(total>0&&cost===0)flags.push('NO_COST');if(total>0&&margin>=95)flags.push('MARGIN_95');if(cost>total)flags.push('COST_OVER_REVENUE');return{...x,total,direct_cost:cost,gross_profit:n(x.gross_profit),margin,flags}});
 const revenue=orders.reduce((a,x)=>a+x.total,0),direct_cost=orders.reduce((a,x)=>a+x.direct_cost,0);
 return{data:{month:s.toISOString().slice(0,7),orders,summary:{orders:orders.length,revenue,direct_cost,gross_profit:revenue-direct_cost,margin:revenue?(revenue-direct_cost)/revenue*100:0,median_check:median,anomalies:orders.filter(x=>x.flags.length).length,high_check_threshold:threshold}}};
});

app.listen({port:Number(process.env.PORT||8084),host:'0.0.0.0'});
