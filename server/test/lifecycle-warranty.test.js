import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire,builtinModules} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';

const root=fileURLToPath(new URL('../src/',import.meta.url));const require=createRequire(import.meta.url);

test('warranty rework is supervisor/owner controlled and preserves original closed order',async()=>{
 const db=await PGlite.create();const query=(sql,p=[])=>p.length?db.query(sql,p):db.exec(sql).then(r=>r.at(-1));let queue=Promise.resolve();const pool={query,connect:async()=>{const prior=queue;let release;queue=new Promise(r=>{release=r});await prior;return{query,release}},end:async()=>{}};globalThis.__lifeWarrantyPool=pool;let app;
 try{
  await migrateCore(pool);const branch=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id;
  await query(`INSERT INTO users(name,email,password_hash,role) VALUES ('Owner LW','lw-owner@test.invalid','x','OWNER'),('Supervisor LW','lw-supervisor@test.invalid','x','SUPERVISOR'),('Manager LW','lw-manager@test.invalid','x','MANAGER'),('Engineer LW','lw-engineer@test.invalid','x','ENGINEER')`);
  await query("INSERT INTO customers(name,phone) VALUES('Warranty client','777')");
  const parent=(await query("INSERT INTO requests(number,customer_id,manager_id,engineer_id,branch_id,status,complaint,total,paid,closed_at,warranty_until) VALUES('LW-CLOSED',1,3,4,$1,'CLOSED','Original repair',5000,5000,now(),CURRENT_DATE+90) RETURNING *",[branch])).rows[0];
  await query(`CREATE TABLE warranty_cards(id BIGSERIAL PRIMARY KEY,request_id INT UNIQUE NOT NULL REFERENCES requests(id),token TEXT UNIQUE NOT NULL,warranty_days INT NOT NULL DEFAULT 90,issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),warranty_until DATE NOT NULL,created_at TIMESTAMPTZ DEFAULT now())`);
  await query("INSERT INTO warranty_cards(request_id,token,warranty_until) VALUES($1,'lw-token',CURRENT_DATE+90)",[parent.id]);
  let src=await readFile(path.join(root,'order-lifecycle-v2.js'),'utf8');src=src.replace(/import pg from\s*['"]pg['"];?/g,'const pg={Pool:class {constructor(){return globalThis.__lifeWarrantyPool}}};');src=src.replace(/\bfrom\s*(['"])([^'"]+)\1/g,(m,q,spec)=>{if(spec.startsWith('node:')||builtinModules.includes(spec))return m;return 'from '+JSON.stringify(pathToFileURL(spec.startsWith('.')?path.resolve(root,spec):require.resolve(spec)).href)});src=src.replace(/logger:\s*true/g,'logger:false').replaceAll('app.listen(','testListen(').replaceAll('process.on(','testOn(');src='const testListen=async()=>{};const testOn=()=>{};\n'+src+'\nexport {app};';({app}=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64')));await app.ready();
  const tok=(id,role)=>app.jwt.sign({id,role});let seq=0;const call=async(user,role,body)=>{const r=await app.inject({method:'POST',url:`/api/v1/requests/${parent.id}/rework`,payload:body,headers:{authorization:'Bearer '+tok(user,role),'idempotency-key':'life-warranty-'+String(++seq).padStart(8,'0')}});return{status:r.statusCode,...r.json()}};
  assert.equal((await call(3,'MANAGER',{link_type:'WARRANTY_REWORK',reason:'Повтор дефекта в гарантийный срок'})).status,403);
  const created=await call(2,'SUPERVISOR',{link_type:'WARRANTY_REWORK',reason:'Повтор дефекта в гарантийный срок'});assert.equal(created.status,201,JSON.stringify(created));
  assert.equal(created.data.request.source,'WARRANTY_REWORK');assert.equal(Number(created.data.request.original_request_id),Number(parent.id));assert.equal(Number(created.data.request.branch_id),Number(branch));
  const original=(await query('SELECT status,total,paid,closed_at FROM requests WHERE id=$1',[parent.id])).rows[0];assert.equal(original.status,'CLOSED');assert.equal(Number(original.total),5000);assert.equal(Number(original.paid),5000);assert.ok(original.closed_at);
  assert.equal((await call(1,'OWNER',{link_type:'WARRANTY_REWORK',reason:'Не должен создаться дубль'})).status,409);
  const links=(await query('SELECT * FROM request_order_links WHERE parent_request_id=$1',[parent.id])).rows;assert.equal(links.length,1);assert.equal(links[0].link_type,'WARRANTY_REWORK');
  await assert.rejects(query("UPDATE request_order_links SET reason='Подмена' WHERE id=$1",[links[0].id]),e=>e.code==='P2401');
 }finally{if(app)await app.close();await db.close();delete globalThis.__lifeWarrantyPool;}
});
