import {authenticate} from './access.js';
import {parseDirectoryQuery,visibleRequest} from './directory-routes.js';

export const DEFAULT_ORDER_COLUMNS=['number','customer','complaint','engineer','status','total'];
export const orderViewStatements=[
 `CREATE TABLE IF NOT EXISTS user_order_views(id SERIAL PRIMARY KEY,user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60),filters JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
 `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_order_view_name ON user_order_views(user_id,lower(name))`,
 `CREATE TABLE IF NOT EXISTS user_order_columns(user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,columns JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`
];
const keys=['status','search','brand','order_type','engineer_id','contract_id','only_mine'];
function filters(body){
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!keys.includes(key)))throw Error('Некорректный набор фильтров');
 if(['status','search','brand','order_type'].some(k=>body[k]!=null&&typeof body[k]!=='string')||['engineer_id','contract_id'].some(k=>body[k]!=null&&typeof body[k]!=='number')||body.only_mine!=null&&typeof body.only_mine!=='boolean')throw Error('Некорректное значение фильтра');
 const parsed=parseDirectoryQuery(body);
 if(parsed.error)throw Error(parsed.error);
 return Object.fromEntries(keys.map(key=>[key,parsed.value[key]]).filter(([,v])=>v!==''&&v!==null&&v!==false));
}
const failure=(reply,message,status=422)=>reply.code(status).send({data:null,error:{code:status===404?'NOT_FOUND':'VALIDATION',message}});
export function registerOrderViewRoutes(app,pool){
 const auth=async(req,reply)=>{await authenticate(req,reply,pool)};
 app.get('/api/v1/directory/order-views',{preHandler:auth},async req=>{
  const p=[],scope=visibleRequest(p,req.user,req.user.id,'r');
  const [views,columns,fields,engineers,brands,contracts]=await Promise.all([
   pool.query('SELECT id,name,filters FROM user_order_views WHERE user_id=$1 ORDER BY created_at,id',[req.user.id]),
   pool.query('SELECT columns FROM user_order_columns WHERE user_id=$1',[req.user.id]),
   pool.query(`SELECT f.code,f.label,f.field_type,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.id,'value',i.value) ORDER BY i.sort_order,i.id) FROM order_field_dictionary_items i WHERE i.dictionary_id=f.dictionary_id),'[]'::jsonb) options FROM order_field_defs f WHERE f.active ORDER BY f.sort_order,f.id`),
   pool.query(`SELECT DISTINCT u.id,u.name FROM requests r JOIN users u ON u.id=r.engineer_id WHERE r.deleted_at IS NULL AND ${scope} ORDER BY u.name,u.id`,p),
   pool.query(`SELECT DISTINCT e.brand FROM requests r JOIN equipment e ON e.id=r.equipment_id WHERE r.deleted_at IS NULL AND ${scope} AND COALESCE(e.brand,'')<>'' ORDER BY e.brand`,p),
   pool.query(`SELECT DISTINCT sc.id,sc.number FROM service_contracts sc JOIN service_contract_assets a ON a.contract_id=sc.id JOIN service_maintenance_cycles m ON m.contract_asset_id=a.id JOIN requests r ON r.id=m.request_id WHERE r.deleted_at IS NULL AND ${scope} ORDER BY sc.number,sc.id`,p)
  ]);
  const allowed=new Set([...DEFAULT_ORDER_COLUMNS,...fields.rows.map(f=>'custom:'+f.code)]);
  const selected=(columns.rows[0]?.columns||DEFAULT_ORDER_COLUMNS).filter(c=>allowed.has(c));
  return {data:views.rows,meta:{columns:selected.includes('number')?selected:DEFAULT_ORDER_COLUMNS,fields:fields.rows,engineers:engineers.rows,brands:brands.rows.map(r=>r.brand),contracts:contracts.rows}};
 });
 app.post('/api/v1/directory/order-views',{preHandler:auth},async(req,reply)=>{
  const body=req.body||{};let clean;
  if(Object.keys(body).some(k=>!['name','filters'].includes(k))||typeof body.name!=='string'||!body.name.trim()||body.name.trim().length>60)return failure(reply,'Название: от 1 до 60 символов');
  try{clean=filters(body.filters)}catch(e){return failure(reply,e.message)}
  const c=await pool.connect();try{
   await c.query('BEGIN');await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
   if(Number((await c.query('SELECT count(*) n FROM user_order_views WHERE user_id=$1',[req.user.id])).rows[0].n)>=20){await c.query('ROLLBACK');return failure(reply,'Можно сохранить не более 20 представлений')}
   const row=(await c.query('INSERT INTO user_order_views(user_id,name,filters) VALUES($1,$2,$3) RETURNING id,name,filters',[req.user.id,body.name.trim(),clean])).rows[0];
   await c.query('COMMIT');return reply.code(201).send({data:row});
  }catch(e){await c.query('ROLLBACK');if(e.code==='23505')return failure(reply,'Представление с таким названием уже есть',409);throw e}finally{c.release()}
 });
 app.delete('/api/v1/directory/order-views/:id',{preHandler:auth},async(req,reply)=>{
  if(!Number.isSafeInteger(Number(req.params.id))||Number(req.params.id)<1||Number(req.params.id)>2147483647)return failure(reply,'Представление не найдено',404);
  const row=(await pool.query('DELETE FROM user_order_views WHERE id=$1 AND user_id=$2 RETURNING id',[req.params.id,req.user.id])).rows[0];
  return row?{data:row}:failure(reply,'Представление не найдено',404);
 });
 app.put('/api/v1/directory/order-columns',{preHandler:auth},async(req,reply)=>{
  const body=req.body||{},columns=body.columns;
  const fields=(await pool.query('SELECT code FROM order_field_defs WHERE active')).rows;
  const allowed=new Set([...DEFAULT_ORDER_COLUMNS,...fields.map(f=>'custom:'+f.code)]);
  if(Object.keys(body).some(k=>k!=='columns')||!Array.isArray(columns)||!columns.includes('number')||columns.length>30||new Set(columns).size!==columns.length||columns.some(c=>typeof c!=='string'||!allowed.has(c)))return failure(reply,'Выберите до 30 разных колонок, включая номер заказа');
  await pool.query('INSERT INTO user_order_columns(user_id,columns) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET columns=EXCLUDED.columns,updated_at=now()',[req.user.id,JSON.stringify(columns)]);
  return {data:{columns}};
 });
}
