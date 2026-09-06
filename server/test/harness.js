import {readFile} from 'node:fs/promises';
import {createRequire,builtinModules} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';

// Shared harness for tests that exercise a shipped Fastify service over HTTP
// against an in-memory Postgres — the same technique crm-regression.test.js
// uses. Kept as its own file (rather than importing from crm-regression.test.js)
// so this suite never has to touch that file's contents.
const root=fileURLToPath(new URL('../src/',import.meta.url));
const require=createRequire(import.meta.url);

export async function setup() {
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  let queue=Promise.resolve();
  const pool={query,connect:async()=>{const before=queue;let release;queue=new Promise(r=>{release=r});await before;return {query,release}},end:async()=>{}};
  globalThis.__crmHarnessPool=pool;
  const apps=[];
  const services={};
  async function load(name) {
    let src=await readFile(path.join(root,name+'.js'),'utf8');
    src=src.replace(/import pg from\s*['"]pg['"];?/g,'const pg={Pool:class {constructor(){return globalThis.__crmHarnessPool}}};');
    src=src.replace(/\bfrom\s*(['"])([^'"]+)\1/g,(m,quote,spec)=>{
      if(spec.startsWith('node:')||builtinModules.includes(spec))return m;
      return 'from '+JSON.stringify(pathToFileURL(spec.startsWith('.')?path.resolve(root,spec):require.resolve(spec)).href);
    });
    src=src.replace(/logger:\s*true/g,'logger:false').replaceAll('app.listen(','testListen(').replaceAll('process.on(','testOn(');
    src='const testListen=async()=>{};const testOn=()=>{};const setInterval=()=>0;const fetch=async()=>{throw new Error("Network disabled in harness test")};\n'+src+'\nexport {app};';
    const {app}=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));
    await app.ready();
    apps.push(app);
    services[name]=app;
    return app;
  }
  await migrateCore(pool);
  await query("INSERT INTO users(name,email,password_hash,role) VALUES ('Owner','owner@test.invalid','unused','OWNER'),('Manager','manager@test.invalid','unused','MANAGER'),('Engineer','engineer@test.invalid','unused','ENGINEER'),('Other engineer','other@test.invalid','unused','ENGINEER')");
  await query("INSERT INTO customers(name,phone) VALUES('Test client','0000')");
  let seq=0;
  const tokens={};
  const roleOf=user=>user===1?'OWNER':user===2?'MANAGER':'ENGINEER';
  async function call(service,method,url,payload,user=1,role) {
    const app=services[service];
    if(!tokens[user])tokens[user]=app.jwt.sign({id:user,role:role||roleOf(user)});
    const res=await app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[user],'idempotency-key':'harness-'+String(++seq).padStart(12,'0')}});
    return {status:res.statusCode,...res.json()};
  }
  const order=async(status='NEW',engineer=3,total=1000,manager=2)=>(await query("INSERT INTO requests(number,customer_id,engineer_id,manager_id,status,complaint,total) VALUES($1,1,$2,$3,$4,'Test',$5) RETURNING id",['HARNESS-'+(++seq),engineer,manager,status,total])).rows[0].id;
  return {
    query,services,call,order,load,
    close:async()=>{for(const app of apps)await app.close();await db.close();delete globalThis.__crmHarnessPool;},
  };
}
