import {calculatePayroll,payrollPeriod} from './payroll-calculation.js';
import {authenticate,installOrderAccess} from './access.js';
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
const q=(s,p=[])=>pool.query(s,p);const n=v=>Number(v||0);const fail=(r,c,m,s=422)=>r.code(s).send({data:null,error:{code:c,message:m}});

const schema=[
`CREATE TABLE IF NOT EXISTS payroll_rules(
 user_id INT PRIMARY KEY REFERENCES users(id),
 base_salary NUMERIC(14,2) NOT NULL DEFAULT 0,
 order_percent NUMERIC(8,3) NOT NULL DEFAULT 0,
 work_percent NUMERIC(8,3) NOT NULL DEFAULT 0,
 gross_profit_percent NUMERIC(8,3) NOT NULL DEFAULT 0,
 active BOOLEAN NOT NULL DEFAULT true,
 updated_by INT REFERENCES users(id),updated_at TIMESTAMPTZ DEFAULT now())`,
`CREATE TABLE IF NOT EXISTS payroll_adjustments(
 id SERIAL PRIMARY KEY,user_id INT NOT NULL REFERENCES users(id),period_month DATE NOT NULL,
 amount NUMERIC(14,2) NOT NULL,type TEXT NOT NULL CHECK(type IN ('BONUS','PENALTY','OTHER')),
 reason TEXT NOT NULL,created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now())`,
`CREATE INDEX IF NOT EXISTS idx_payroll_adjustments_period ON payroll_adjustments(period_month,user_id)`
];for(const s of schema)await q(s);

const auth=async(req,reply)=>{if(!await authenticate(req,reply,pool))return;};
const owner=async(req,reply)=>{await auth(req,reply);if(reply.sent)return;if(req.user.role!=='OWNER')return fail(reply,'FORBIDDEN','Раздел зарплат доступен владельцу',403)};
const monthStart=v=>payrollPeriod(v)[0];
const monthEnd=start=>new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,1));

installOrderAccess(app,pool,'payroll');
app.get('/health',async()=>{await q('SELECT 1');return{ok:true,service:'profi24-payroll',version:'1.0.0'}});
app.get('/api/v1/rules',{preHandler:owner},async()=>({data:(await q(`SELECT u.id user_id,u.name,u.email,u.role,u.active,
 COALESCE(pr.base_salary,0)::numeric base_salary,COALESCE(pr.order_percent,0)::numeric order_percent,
 COALESCE(pr.work_percent,0)::numeric work_percent,COALESCE(pr.gross_profit_percent,0)::numeric gross_profit_percent,
 COALESCE(pr.active,true) rule_active
 FROM users u LEFT JOIN payroll_rules pr ON pr.user_id=u.id ORDER BY u.active DESC,u.role,u.name`)).rows}));
app.put('/api/v1/rules/:userId',{preHandler:owner},async(req,reply)=>{const id=n(req.params.userId),b=req.body||{};if(!id)return fail(reply,'VALIDATION','Сотрудник не указан');for(const x of ['base_salary','order_percent','work_percent','gross_profit_percent'])if(n(b[x])<0)return fail(reply,'VALIDATION','Значения не могут быть отрицательными');const exists=(await q('SELECT id FROM users WHERE id=$1',[id])).rows[0];if(!exists)return fail(reply,'NOT_FOUND','Сотрудник не найден',404);const r=await q(`INSERT INTO payroll_rules(user_id,base_salary,order_percent,work_percent,gross_profit_percent,active,updated_by)
 VALUES($1,$2,$3,$4,$5,$6,$7)
 ON CONFLICT(user_id) DO UPDATE SET base_salary=EXCLUDED.base_salary,order_percent=EXCLUDED.order_percent,
 work_percent=EXCLUDED.work_percent,gross_profit_percent=EXCLUDED.gross_profit_percent,active=EXCLUDED.active,updated_by=EXCLUDED.updated_by,updated_at=now()
 RETURNING *`,[id,n(b.base_salary),n(b.order_percent),n(b.work_percent),n(b.gross_profit_percent),b.active!==false,req.user.id]);return{data:r.rows[0]}});

app.get('/api/v1/adjustments',{preHandler:owner},async req=>{const start=monthStart(req.query?.month);const end=monthEnd(start);return{data:(await q(`SELECT a.*,u.name user_name,cb.name created_by_name FROM payroll_adjustments a JOIN users u ON u.id=a.user_id LEFT JOIN users cb ON cb.id=a.created_by WHERE a.period_month>=$1 AND a.period_month<$2 ORDER BY a.created_at DESC`,[start,end])).rows}});
app.post('/api/v1/adjustments',{preHandler:owner},async(req,reply)=>{const b=req.body||{},amount=Math.abs(n(b.amount));if(!b.user_id||!amount||!b.reason?.trim()||!['BONUS','PENALTY','OTHER'].includes(b.type))return fail(reply,'VALIDATION','Заполните сотрудника, сумму, тип и причину');const start=monthStart(b.month);const signed=b.type==='PENALTY'?-amount:n(b.amount);const r=await q('INSERT INTO payroll_adjustments(user_id,period_month,amount,type,reason,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[b.user_id,start,signed,b.type,b.reason.trim(),req.user.id]);return reply.code(201).send({data:r.rows[0]})});
app.delete('/api/v1/adjustments/:id',{preHandler:owner},async(req,reply)=>{const r=await q('DELETE FROM payroll_adjustments WHERE id=$1 RETURNING id',[req.params.id]);if(!r.rows[0])return fail(reply,'NOT_FOUND','Корректировка не найдена',404);return{data:{ok:true}}});

app.get('/api/v1/report',{preHandler:owner},async req=>{
 const [start,end]=payrollPeriod(req.query?.month);
 const {rows,totals}=await calculatePayroll(pool,start,end);
 return {data:{month:start.toISOString().slice(0,7),rows,totals}};
});

app.listen({port:Number(process.env.PORT||8083),host:'0.0.0.0'});
