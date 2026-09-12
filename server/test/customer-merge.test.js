import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire,builtinModules} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';

const root=fileURLToPath(new URL('../src/',import.meta.url));
const require=createRequire(import.meta.url);

async function setup(){
 const db=await PGlite.create();
 const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
 let queue=Promise.resolve();
 const pool={query,connect:async()=>{const prior=queue;let release;queue=new Promise(r=>{release=r});await prior;return{query,release}},end:async()=>{}};
 globalThis.__customerMergePool=pool;
 await migrateCore(pool);
 const branch=Number((await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id);
 await query(`INSERT INTO users(name,email,password_hash,role,active,primary_branch_id) VALUES
  ('Merge Owner','merge-owner@test.invalid','unused','OWNER',true,$1),
  ('Merge Manager','merge-manager@test.invalid','unused','MANAGER',true,$1)`,[branch]);
 const users=(await query("SELECT id,role FROM users WHERE email LIKE 'merge-%@test.invalid' ORDER BY id")).rows;
 const owner=Number(users.find(x=>x.role==='OWNER').id),manager=Number(users.find(x=>x.role==='MANAGER').id);
 await query(`INSERT INTO customers(name,phone,phone_norm,email,address,notes,latitude,longitude,location_source) VALUES
  ('Основной клиент','+7 701 111 22 33','77011112233','main@test.invalid',NULL,'Основная заметка',NULL,NULL,NULL),
  ('Дубликат клиента','8 701 111 22 33','77011112233',NULL,'Адрес дубликата','Заметка дубликата',53.2145,63.6250,'MANUAL')`);
 const customers=(await query("SELECT id,name FROM customers WHERE name IN ('Основной клиент','Дубликат клиента') ORDER BY id")).rows;
 const target=Number(customers.find(x=>x.name==='Основной клиент').id),source=Number(customers.find(x=>x.name==='Дубликат клиента').id);
 const equipment=Number((await query("INSERT INTO equipment(customer_id,category,brand,model) VALUES($1,'Холодильник','LG','DUP') RETURNING id",[source])).rows[0].id);
 const request=Number((await query("INSERT INTO requests(number,customer_id,equipment_id,manager_id,branch_id,status,complaint) VALUES('MERGE-ORDER',$1,$2,$3,$4,'NEW','Тест объединения') RETURNING id",[source,equipment,manager,branch])).rows[0].id);
 await query("INSERT INTO complaints(number,request_id,customer_id,text) VALUES('MERGE-COMPLAINT',$1,$2,'Тест')",[request,source]);
 await query("INSERT INTO customer_feedback(request_id,customer_id,branch_id,token_nonce,token_hash,expires_at) VALUES($1,$2,$3,'merge-nonce','merge-hash',now()+interval '1 day')",[request,source,branch]);
 await query("INSERT INTO customer_visit_confirmations(request_id,customer_id,branch_id,version,token_nonce,token_hash,scheduled_at_snapshot,expires_at) VALUES($1,$2,$3,1,'visit-nonce','visit-hash',now()+interval '1 hour',now()+interval '1 day')",[request,source,branch]);
 await query("INSERT INTO equipment_pickup_states(request_id,customer_id,branch_id,ready_at,storage_due_at) VALUES($1,$2,$3,now(),now()+interval '7 days')",[request,source,branch]);
 await query("INSERT INTO service_contracts(number,customer_id,branch_id,status,start_date,created_by) VALUES('MERGE-CONTRACT',$1,$2,'ACTIVE',CURRENT_DATE,$3)",[source,branch,owner]);
 await query("INSERT INTO engineer_route_location_audit(customer_id,branch_id,actor_id,before_location,after_location) VALUES($1,$2,$3,'{}','{}')",[source,branch,owner]);

 let src=await readFile(path.join(root,'directory-admin.js'),'utf8');
 src=src.replace(/import pg from\s*['"]pg['"];?/g,'const pg={Pool:class {constructor(){return globalThis.__customerMergePool}}};');
 src=src.replace(/\bfrom\s*(['"])([^'"]+)\1/g,(m,quote,spec)=>{
  if(spec.startsWith('node:')||builtinModules.includes(spec))return m;
  return 'from '+JSON.stringify(pathToFileURL(spec.startsWith('.')?path.resolve(root,spec):require.resolve(spec)).href);
 });
 src=src.replace(/logger:\s*true/g,'logger:false').replaceAll('app.listen(','testListen(').replaceAll('process.on(','testOn(');
 src='const testListen=async()=>{};const testOn=()=>{};\n'+src+'\nexport {app};';
 const {app}=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));await app.ready();
 const tokens={owner:app.jwt.sign({id:owner,role:'OWNER'}),manager:app.jwt.sign({id:manager,role:'MANAGER'})};
 const call=async(role,method,url,payload)=>{const r=await app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[role]}});return{status:r.statusCode,...r.json()}};
 return{db,query,app,call,owner,manager,source,target,request,equipment,close:async()=>{await app.close();await db.close();delete globalThis.__customerMergePool}};
}

test('F02: безопасное объединение клиента сохраняет всю историю и неизменяемый аудит',async()=>{
 const s=await setup();
 try{
  assert.equal((await s.call('manager','GET',`/api/v1/customers/${s.source}/merge-preview?target_id=${s.target}`)).status,403);
  const preview=await s.call('owner','GET',`/api/v1/customers/${s.source}/merge-preview?target_id=${s.target}`);
  assert.equal(preview.status,200,JSON.stringify(preview));assert.equal(preview.data.phones_match,true);
  for(const key of ['orders','equipment','complaints','feedback','visit_confirmations','pickup_states','service_contracts','location_audit_preserved'])assert.equal(preview.data.source.counts[key],1,key);
  assert.equal((await s.call('owner','POST',`/api/v1/customers/${s.source}/merge`,{target_id:s.target,reason:'Создан повторно'})).status,409);
  const merged=await s.call('owner','POST',`/api/v1/customers/${s.source}/merge`,{target_id:s.target,confirm_target_id:s.target,reason:'Создан повторно'});
  assert.equal(merged.status,200,JSON.stringify(merged));assert.equal(merged.data.target_customer_id,s.target);
  for(const table of ['requests','equipment','complaints','customer_feedback','customer_visit_confirmations','equipment_pickup_states','service_contracts']){
   const row=(await s.query(`SELECT customer_id FROM ${table} WHERE customer_id=$1`,[s.target])).rows[0];assert.equal(Number(row.customer_id),s.target,table);
  }
  const source=(await s.query('SELECT deleted_at,deleted_by,delete_reason,phone_norm FROM customers WHERE id=$1',[s.source])).rows[0];
  assert.ok(source.deleted_at);assert.equal(Number(source.deleted_by),s.owner);assert.match(source.delete_reason,new RegExp(`^MERGED_INTO:${s.target}:`));assert.equal(source.phone_norm,null);
  const target=(await s.query('SELECT email,address,notes,latitude,longitude FROM customers WHERE id=$1',[s.target])).rows[0];
  assert.equal(target.email,'main@test.invalid');assert.equal(target.address,'Адрес дубликата');assert.match(target.notes,/Основная заметка/);assert.match(target.notes,/Заметка дубликата/);assert.equal(Number(target.latitude),53.2145);assert.equal(Number(target.longitude),63.625);
  assert.equal(Number((await s.query('SELECT customer_id FROM engineer_route_location_audit')).rows[0].customer_id),s.source);
  const audit=(await s.query('SELECT * FROM customer_merge_audit WHERE source_customer_id=$1',[s.source])).rows[0];assert.equal(Number(audit.target_customer_id),s.target);assert.equal(audit.moved_counts.orders,1);
  assert.equal(Number((await s.query("SELECT count(*) value FROM request_history WHERE request_id=$1 AND action='CUSTOMER_MERGED'",[s.request])).rows[0].value),1);
  await assert.rejects(s.query('UPDATE customer_merge_audit SET reason=$1 WHERE id=$2',['Подмена',audit.id]),e=>e.code==='P2401');
  const restore=await s.call('owner','POST',`/api/v1/customers/${s.source}/restore`,{});assert.equal(restore.status,409);assert.equal(restore.error.code,'MERGED_CUSTOMER');
 }finally{await s.close()}
});
