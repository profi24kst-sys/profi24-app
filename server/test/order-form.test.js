
import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {orderFormSchema,validateOrderFields,registerOrderFormRoutes} from '../src/order-form.js';

test('owner configures dictionaries and typed intake; manager may read but not modify definitions',async()=>{
 const db=await PGlite.create();
 const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(x=>x.at(-1));
 let queue=Promise.resolve();
 const pool={query,connect:async()=>{const prior=queue;let release;queue=new Promise(resolve=>release=resolve);await prior;return{query,release}},end:async()=>{}};
 const app=Fastify();
 try{
  await migrateCore(pool);
  const auth=async req=>{req.user={id:req.headers['x-role']==='OWNER'?1:2,role:req.headers['x-role']||'MANAGER'}};
  const err=(reply,code,message,status=422,details)=>reply.code(status).send({data:null,error:{code,message,details}});
  const roles=(...allowed)=>async(req,reply)=>{await auth(req);if(!allowed.includes(req.user.role))return err(reply,'FORBIDDEN','Нет доступа',403)};
  registerOrderFormRoutes(app,pool,{auth,roles,err});await app.ready();
  const send=async(method,url,body,role='OWNER')=>{
   const r=await app.inject({method,url,headers:{'x-role':role},...(body?{payload:body}:{})});
   return{status:r.statusCode,...r.json()};
  };
  let r=await send('POST','/api/v1/order-form/dictionaries',{code:'brands',label:'Бренды'});
  assert.equal(r.status,201);const dictionaryId=r.data.id;
  r=await send('POST','/api/v1/order-form/dictionaries/'+dictionaryId+'/items',{value:'LG'});
  assert.equal(r.status,201);const choice=r.data.id;
  r=await send('POST','/api/v1/order-form/fields',{code:'device_brand',label:'Бренд',field_type:'SELECT',dictionary_id:dictionaryId,required:true,sort_order:1});
  assert.equal(r.status,201);const fieldId=r.data.id;
  r=await send('POST','/api/v1/order-form/fields',{code:'external_condition',label:'Внешний вид',field_type:'TEXTAREA',required:false});
  assert.equal(r.status,201);
  r=await send('GET','/api/v1/order-form/schema?order_type=REPAIR',undefined,'MANAGER');
  assert.equal(r.status,200);assert.ok(r.data.fields.some(f=>f.code==='device_brand'));
  assert.equal(r.data.fields.find(f=>f.code==='device_brand').options[0].id,choice);
  await assert.rejects(validateOrderFields(pool,'REPAIR',{}),e=>e.code==='CUSTOM_FIELD_REQUIRED');
  await assert.rejects(validateOrderFields(pool,'REPAIR',{device_brand:999}),e=>e.code==='INVALID_CUSTOM_FIELD');
  await assert.rejects(validateOrderFields(pool,'REPAIR',{device_brand:choice,unknown:'abc'}),e=>e.code==='UNKNOWN_CUSTOM_FIELD');
  const valid=await validateOrderFields(pool,'REPAIR',{device_brand:choice,external_condition:'  Без царапин  '});
  assert.deepEqual(valid.custom_fields,{device_brand:choice,external_condition:'Без царапин'});
  r=await send('POST','/api/v1/order-form/fields',{code:'unapproved',label:'Чужое поле',field_type:'TEXT'},'MANAGER');
  assert.equal(r.status,403);
  r=await send('PATCH','/api/v1/order-form/fields/'+fieldId,{active:false});
  assert.equal(r.status,200);
  assert.equal((await orderFormSchema(pool,'REPAIR')).fields.some(f=>f.code==='device_brand'),false);

  r=await send('POST','/api/v1/order-form/fields',{code:'visit_notes',label:'Выездные заметки',field_type:'TEXT',required:true,order_types:['FIELD']});
  assert.equal(r.status,201);
  r=await send('POST','/api/v1/order-form/fields',{code:'workshop_receipt',label:'Номер квитанции',field_type:'TEXT',required:true,order_types:['PAID_WORKSHOP']});
  assert.equal(r.status,201);
  assert.equal((await orderFormSchema(pool,'REPAIR')).fields.some(f=>['visit_notes','workshop_receipt'].includes(f.code)),false);
  await assert.rejects(validateOrderFields(pool,'FIELD',{}),e=>e.code==='CUSTOM_FIELD_REQUIRED'&&e.details.field==='visit_notes');
  await assert.rejects(validateOrderFields(pool,'PAID_WORKSHOP',{}),e=>e.code==='CUSTOM_FIELD_REQUIRED'&&e.details.field==='workshop_receipt');
  assert.deepEqual((await validateOrderFields(pool,'FIELD',{visit_notes:'Выезд на завтра'})).custom_fields,{visit_notes:'Выезд на завтра'});
  await assert.rejects(validateOrderFields(pool,'FIELD',{workshop_receipt:'123',visit_notes:'ok'}),e=>e.code==='UNKNOWN_CUSTOM_FIELD');
  const field=(await query('SELECT custom_fields,order_type FROM requests LIMIT 1')).rows;
  assert.equal(Array.isArray(field),true);
 }finally{await app.close();await db.close()}
});
