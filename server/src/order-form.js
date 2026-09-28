
export const orderFormStatements=[
  "ALTER TABLE requests ADD COLUMN IF NOT EXISTS order_type TEXT NOT NULL DEFAULT 'REPAIR'",
  "ALTER TABLE requests ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb",
  "CREATE TABLE IF NOT EXISTS order_field_dictionaries(id SERIAL PRIMARY KEY,code TEXT UNIQUE NOT NULL,label TEXT NOT NULL,active BOOLEAN DEFAULT TRUE)",
  "CREATE TABLE IF NOT EXISTS order_field_dictionary_items(id SERIAL PRIMARY KEY,dictionary_id INT NOT NULL REFERENCES order_field_dictionaries(id),value TEXT NOT NULL,active BOOLEAN DEFAULT TRUE,sort_order INT DEFAULT 0,UNIQUE(dictionary_id,value))",
  "CREATE TABLE IF NOT EXISTS order_field_defs(id SERIAL PRIMARY KEY,code TEXT UNIQUE NOT NULL,label TEXT NOT NULL,field_type TEXT NOT NULL CHECK(field_type IN ('TEXT','TEXTAREA','NUMBER','DATE','IMEI','SELECT')),dictionary_id INT REFERENCES order_field_dictionaries(id),required BOOLEAN DEFAULT FALSE,active BOOLEAN DEFAULT TRUE,sort_order INT DEFAULT 0,order_types TEXT[] NOT NULL DEFAULT ARRAY['REPAIR']::TEXT[],CHECK(field_type='SELECT' OR dictionary_id IS NULL))"
];
const TYPES=['REPAIR','FIELD','SALE','PAID_WORKSHOP','PARTS'];
const FIELD_TYPES=['TEXT','TEXTAREA','NUMBER','DATE','IMEI','SELECT'];
const codeOk=v=>typeof v==='string'&&/^[a-z][a-z0-9_]{1,49}$/.test(v);
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const issue=(code,message,field)=>Object.assign(new Error(message),{code,statusCode:422,details:field?{field}:undefined});
export async function orderFormSchema(pool,orderType='REPAIR'){
 if(!TYPES.includes(orderType))throw issue('INVALID_ORDER_TYPE','Неизвестный тип заказа');
 const fields=(await pool.query("SELECT f.id,f.code,f.label,f.field_type,f.dictionary_id,f.required,f.sort_order FROM order_field_defs f WHERE f.active AND $1=ANY(f.order_types) ORDER BY f.sort_order,f.id",[orderType])).rows;
 const ids=fields.filter(f=>f.field_type==='SELECT').map(f=>f.dictionary_id);
 let options=[];
 if(ids.length)options=(await pool.query("SELECT i.id,i.dictionary_id,i.value FROM order_field_dictionary_items i JOIN order_field_dictionaries d ON d.id=i.dictionary_id WHERE i.dictionary_id=ANY($1::int[]) AND i.active AND d.active ORDER BY i.sort_order,i.id",[ids])).rows;
 return {order_type:orderType,fields:fields.map(f=>({...f,options:options.filter(i=>i.dictionary_id===f.dictionary_id).map(i=>({id:i.id,value:i.value}))}))};
}
export async function validateOrderFields(pool,orderType='REPAIR',fields={}){
 if(!plain(fields)||Object.keys(fields).length>60)throw issue('INVALID_CUSTOM_FIELDS','Передайте объект дополнительных полей (максимум 60)');
 const schema=await orderFormSchema(pool,orderType),byCode=new Map(schema.fields.map(f=>[f.code,f])),clean={};
 for(const [code,value] of Object.entries(fields)){
  const f=byCode.get(code);
  if(!f)throw issue('UNKNOWN_CUSTOM_FIELD','Неизвестное или отключённое поле',code);
  if(value===null||value==='')continue;
  const invalid=()=>issue('INVALID_CUSTOM_FIELD','Проверьте поле «'+f.label+'»',code);
  if(f.field_type==='TEXT'||f.field_type==='TEXTAREA'){
   if(typeof value!=='string'||!value.trim()||value.length>(f.field_type==='TEXT'?250:2000))throw invalid();
   clean[code]=value.trim();
  }else if(f.field_type==='IMEI'){
   if(typeof value!=='string'||!/^\d{15}$/.test(value))throw invalid();
   clean[code]=value;
  }else if(f.field_type==='DATE'){
   if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw invalid();
   clean[code]=value;
  }else if(f.field_type==='NUMBER'){
   if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>1e10)throw invalid();
   clean[code]=value;
  }else if(f.field_type==='SELECT'){
   if(!Number.isInteger(value)||!f.options.some(x=>x.id===value))throw invalid();
   clean[code]=value;
  }
 }
 for(const f of schema.fields)if(f.required&&!Object.hasOwn(clean,f.code))throw issue('CUSTOM_FIELD_REQUIRED','Заполните поле «'+f.label+'»',f.code);
 return {order_type:orderType,custom_fields:clean};
}
export function registerOrderFormRoutes(app,pool,{auth,roles,err}){
 const q=(sql,p=[])=>pool.query(sql,p);
 const fail=(reply,e)=>err(reply,e.code||'VALIDATION',e.message,e.statusCode||422,e.details);
 app.get('/api/v1/order-form/schema',{preHandler:auth},async(req,reply)=>{try{return{data:await orderFormSchema(pool,req.query?.order_type||'REPAIR')}}catch(e){return fail(reply,e)}});
 app.get('/api/v1/order-form/dictionaries',{preHandler:roles('OWNER')},async()=>({data:(await q("SELECT * FROM order_field_dictionaries ORDER BY label")).rows}));

 app.get('/api/v1/order-form/fields',{preHandler:roles('OWNER')},async()=>({data:(await q("SELECT f.*,d.label dictionary_label FROM order_field_defs f LEFT JOIN order_field_dictionaries d ON d.id=f.dictionary_id ORDER BY f.sort_order,f.id")).rows}));
 app.get('/api/v1/order-form/dictionaries/:id/items',{preHandler:roles('OWNER')},async(req,reply)=>{
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id)||id<1)return err(reply,'VALIDATION','Некорректный справочник');
  return {data:(await q("SELECT id,value,active,sort_order FROM order_field_dictionary_items WHERE dictionary_id=$1 ORDER BY sort_order,id",[id])).rows};
 });

 app.post('/api/v1/order-form/dictionaries',{preHandler:roles('OWNER')},async(req,reply)=>{
  const {code,label}=req.body||{};
  if(!codeOk(code)||typeof label!=='string'||!label.trim()||label.length>120)return err(reply,'VALIDATION','Укажите код и название справочника');
  try{return reply.code(201).send({data:(await q("INSERT INTO order_field_dictionaries(code,label) VALUES($1,$2) RETURNING *",[code,label.trim()])).rows[0]})}
  catch(e){if(e.code==='23505')return err(reply,'DUPLICATE_DICTIONARY','Справочник уже существует',409);throw e}
 });
 app.post('/api/v1/order-form/dictionaries/:id/items',{preHandler:roles('OWNER')},async(req,reply)=>{
  const id=Number(req.params.id),value=req.body?.value;
  if(!Number.isSafeInteger(id)||id<1||typeof value!=='string'||!value.trim()||value.length>160)return err(reply,'VALIDATION','Проверьте значение справочника');
  if(!(await q("SELECT 1 FROM order_field_dictionaries WHERE id=$1 AND active=true",[id])).rows.length)return err(reply,'NOT_FOUND','Справочник не найден',404);
  try{return reply.code(201).send({data:(await q("INSERT INTO order_field_dictionary_items(dictionary_id,value) VALUES($1,$2) RETURNING *",[id,value.trim()])).rows[0]})}
  catch(e){if(e.code==='23505')return err(reply,'DUPLICATE_VALUE','Значение уже существует',409);throw e}
 });
 app.patch('/api/v1/order-form/dictionaries/:id',{preHandler:roles('OWNER')},async(req,reply)=>{
  const id=Number(req.params.id),body=req.body||{},allowed=['label','active'];
  if(!Number.isSafeInteger(id)||id<1||!plain(body)||!Object.keys(body).length||Object.keys(body).some(k=>!allowed.includes(k)))return err(reply,'VALIDATION','Проверьте параметры справочника');
  if(body.label!==undefined&&(typeof body.label!=='string'||!body.label.trim()||body.label.length>120)||body.active!==undefined&&typeof body.active!=='boolean')return err(reply,'VALIDATION','Некорректное значение справочника');
  const row=(await q("UPDATE order_field_dictionaries SET label=COALESCE($2,label),active=COALESCE($3,active) WHERE id=$1 RETURNING *",[id,body.label?.trim()??null,body.active??null])).rows[0];
  return row?{data:row}:err(reply,'NOT_FOUND','Справочник не найден',404);
 });
 app.patch('/api/v1/order-form/dictionaries/:id/items/:itemId',{preHandler:roles('OWNER')},async(req,reply)=>{
  const id=Number(req.params.id),itemId=Number(req.params.itemId),body=req.body||{},allowed=['value','active','sort_order'];
  if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(itemId)||itemId<1||!plain(body)||!Object.keys(body).length||Object.keys(body).some(k=>!allowed.includes(k)))return err(reply,'VALIDATION','Проверьте параметры значения');
  if(body.value!==undefined&&(typeof body.value!=='string'||!body.value.trim()||body.value.length>160)||body.active!==undefined&&typeof body.active!=='boolean'||body.sort_order!==undefined&&(!Number.isSafeInteger(body.sort_order)||Math.abs(body.sort_order)>100000))return err(reply,'VALIDATION','Некорректное значение справочника');
  try{
   const row=(await q("UPDATE order_field_dictionary_items SET value=COALESCE($3,value),active=COALESCE($4,active),sort_order=COALESCE($5,sort_order) WHERE id=$1 AND dictionary_id=$2 RETURNING *",[itemId,id,body.value?.trim()??null,body.active??null,body.sort_order??null])).rows[0];
   return row?{data:row}:err(reply,'NOT_FOUND','Значение не найдено',404);
  }catch(e){if(e.code==='23505')return err(reply,'DUPLICATE_VALUE','Значение уже существует',409);throw e}
 });
 app.post('/api/v1/order-form/fields',{preHandler:roles('OWNER')},async(req,reply)=>{
  const f=req.body||{},types=f.order_types===undefined?['REPAIR']:f.order_types,sort=f.sort_order??0;
  if(!codeOk(f.code)||typeof f.label!=='string'||!f.label.trim()||f.label.length>120||!FIELD_TYPES.includes(f.field_type)||!Array.isArray(types)||!types.length||types.some(t=>!TYPES.includes(t))||!Number.isSafeInteger(sort)||Math.abs(sort)>100000||f.required!==undefined&&typeof f.required!=='boolean')return err(reply,'VALIDATION','Проверьте определение поля');
  const dict=f.field_type==='SELECT'?Number(f.dictionary_id):null;
  if(f.field_type==='SELECT'&&(!Number.isSafeInteger(dict)||dict<1||!(await q("SELECT 1 FROM order_field_dictionaries WHERE id=$1 AND active=true",[dict])).rows.length))return err(reply,'VALIDATION','Выберите активный справочник');
  if(f.field_type!=='SELECT'&&f.dictionary_id!=null)return err(reply,'VALIDATION','Справочник применим только к списку');
  try{return reply.code(201).send({data:(await q("INSERT INTO order_field_defs(code,label,field_type,dictionary_id,required,sort_order,order_types) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",[f.code,f.label.trim(),f.field_type,dict,f.required===true,sort,[...new Set(types)]])).rows[0]})}
  catch(e){if(e.code==='23505')return err(reply,'DUPLICATE_FIELD','Поле уже существует',409);throw e}
 });
 app.patch('/api/v1/order-form/fields/:id',{preHandler:roles('OWNER')},async(req,reply)=>{
  const id=Number(req.params.id),f=req.body||{},allowed=['label','required','active','sort_order','order_types'];
  if(!Number.isSafeInteger(id)||id<1||!plain(f)||!Object.keys(f).length||Object.keys(f).some(k=>!allowed.includes(k)))return err(reply,'VALIDATION','Проверьте параметры');
  if(f.label!==undefined&&(typeof f.label!=='string'||!f.label.trim()||f.label.length>120)||f.required!==undefined&&typeof f.required!=='boolean'||f.active!==undefined&&typeof f.active!=='boolean'||f.sort_order!==undefined&&(!Number.isSafeInteger(f.sort_order)||Math.abs(f.sort_order)>100000)||f.order_types!==undefined&&(!Array.isArray(f.order_types)||!f.order_types.length||f.order_types.some(t=>!TYPES.includes(t))))return err(reply,'VALIDATION','Некорректное значение');
  const row=(await q("UPDATE order_field_defs SET label=COALESCE($2,label),required=COALESCE($3,required),active=COALESCE($4,active),sort_order=COALESCE($5,sort_order),order_types=COALESCE($6,order_types) WHERE id=$1 RETURNING *",[id,f.label?.trim()??null,f.required??null,f.active??null,f.sort_order??null,f.order_types?[...new Set(f.order_types)]:null])).rows[0];
  return row?{data:row}:err(reply,'NOT_FOUND','Поле не найдено',404);
 });
}
