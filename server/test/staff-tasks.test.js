import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire,builtinModules} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {parseStaffTaskInput,staffTaskVisibility} from '../src/staff-tasks.js';

const root=fileURLToPath(new URL('../src/',import.meta.url));
const require=createRequire(import.meta.url);

async function setup(){
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  let queue=Promise.resolve();
  const pool={
    query,
    connect:async()=>{
      const prior=queue;
      let release;
      queue=new Promise(r=>{release=r});
      await prior;
      return{query,release};
    },
    end:async()=>{}
  };
  globalThis.__staffTaskPool=pool;
  const apps=[];
  async function load(name){
    let src=await readFile(path.join(root,name+'.js'),'utf8');
    src=src.replace(/import pg from\s*['"]pg['"];?/g,'const pg={Pool:class {constructor(){return globalThis.__staffTaskPool}}};');
    src=src.replace(/\bfrom\s*(['"])([^'"]+)\1/g,(m,quote,spec)=>{
      if(spec.startsWith('node:')||builtinModules.includes(spec))return m;
      return 'from '+JSON.stringify(pathToFileURL(spec.startsWith('.')?path.resolve(root,spec):require.resolve(spec)).href);
    });
    src=src.replace(/logger:\s*true/g,'logger:false').replaceAll('app.listen(','testListen(').replaceAll('process.on(','testOn(');
    src='const testListen=async()=>{};const testOn=()=>{};\n'+src+'\nexport {app};';
    const {app}=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));
    await app.ready();apps.push(app);return app;
  }
  await migrateCore(pool);
  const kst=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id;
  const other=(await query("INSERT INTO branches(code,name) VALUES('ALT-TASK','Другой филиал') RETURNING id")).rows[0].id;
  await query(`INSERT INTO users(name,email,password_hash,role) VALUES
    ('Owner','staff-owner@test.invalid','unused','OWNER'),
    ('Supervisor','staff-supervisor@test.invalid','unused','SUPERVISOR'),
    ('Manager KST','staff-manager@test.invalid','unused','MANAGER'),
    ('Manager ALT','staff-manager-alt@test.invalid','unused','MANAGER'),
    ('Engineer KST','staff-engineer@test.invalid','unused','ENGINEER'),
    ('Engineer ALT','staff-engineer-alt@test.invalid','unused','ENGINEER'),
    ('Accountant','staff-accountant@test.invalid','unused','ACCOUNTANT'),
    ('Trainee','staff-trainee@test.invalid','unused','TRAINEE')`);
  await query('UPDATE users SET primary_branch_id=$1 WHERE id IN (4,6)',[other]);
  await query('DELETE FROM user_branches WHERE user_id IN (4,6) AND branch_id=$1',[kst]);
  await query("INSERT INTO customers(name,phone) VALUES('Task Client','77001112233')");
  const ownOrder=(await query("INSERT INTO requests(number,customer_id,engineer_id,manager_id,branch_id,status,complaint,total) VALUES('TASK-KST',1,5,3,$1,'REPAIR','Task acceptance',1000) RETURNING id",[kst])).rows[0].id;
  const foreignOrder=(await query("INSERT INTO requests(number,customer_id,engineer_id,manager_id,branch_id,status,complaint,total) VALUES('TASK-ALT',1,6,4,$1,'REPAIR','Task acceptance',1000) RETURNING id",[other])).rows[0].id;
  const app=await load('order-tasks');
  const roles={1:'OWNER',2:'SUPERVISOR',3:'MANAGER',4:'MANAGER',5:'ENGINEER',6:'ENGINEER',7:'ACCOUNTANT',8:'TRAINEE'};
  let n=0;
  async function call(user,method,url,payload){
    const token=app.jwt.sign({id:user,role:roles[user]});
    const res=await app.inject({method,url,payload,headers:{authorization:'Bearer '+token,'idempotency-key':'staff-test-'+(++n)}});
    let body;
    try{body=res.json()}catch{body={raw:res.body}};
    return{status:res.statusCode,...body};
  }
  return{db,query,call,kst,other,ownOrder,foreignOrder,close:async()=>{for(const app of apps)await app.close();await db.close();delete globalThis.__staffTaskPool;}};
}

test('standalone task parser enforces title, assignment, priority and due dates',()=>{
  assert.ok(parseStaffTaskInput({title:'',assigned_to:1}).error);
  assert.ok(parseStaffTaskInput({title:'Valid',assigned_to:'wrong'}).error);
  assert.ok(parseStaffTaskInput({title:'Valid',assigned_to:1,priority:'CRITICAL'}).error);
  assert.ok(parseStaffTaskInput({title:'Valid',assigned_to:1,due_at:'not-a-date'}).error);
  assert.ok(parseStaffTaskInput({title:'Valid',assigned_to:1,request_id:9}).error);
  assert.equal(parseStaffTaskInput({title:'  Call supplier  ',assigned_to:'5'}).value.title,'Call supplier');
  assert.equal(staffTaskVisibility('MANAGER',3).params[0],3);
  assert.equal(staffTaskVisibility('OWNER',1).clause,null);
});

test('staff task center: create, branch permissions, personal visibility, search and completion',async t=>{
  const s=await setup();
  const {call}=s;
  try{
    await t.test('assignee catalog is limited for managers and restricted for technicians',async()=>{
      const owner=await call(1,'GET','/api/v1/tasks/assignees');
      assert.equal(owner.status,200);
      assert.equal(owner.data.length,8);
      const manager=await call(3,'GET','/api/v1/tasks/assignees');
      assert.equal(manager.status,200);
      const ids=manager.data.map(x=>Number(x.id));
      assert.ok(ids.includes(5));
      assert.ok(!ids.includes(6));
      assert.ok(!ids.includes(4));
      assert.equal((await call(5,'GET','/api/v1/tasks/assignees')).status,403);
    });

    let managerTask;
    await t.test('owner/supervisor/manager create tasks with branch scope; engineer cannot',async()=>{
      assert.equal((await call(5,'POST','/api/v1/tasks',{title:'Forbidden',assigned_to:5})).status,403);
      assert.equal((await call(3,'POST','/api/v1/tasks',{title:'Wrong branch',assigned_to:6})).status,403);
      assert.equal((await call(3,'POST','/api/v1/tasks',{title:'',assigned_to:5})).status,422);
      assert.equal((await call(3,'POST','/api/v1/tasks',{title:'Wrong link',assigned_to:5,request_id:s.ownOrder})).status,422);
      const created=await call(3,'POST','/api/v1/tasks',{title:'Replace consumables',assigned_to:5,priority:'HIGH',description:'Prepare materials before visit'});
      assert.equal(created.status,201,JSON.stringify(created));
      assert.equal(created.data.request_id,null);
      managerTask=created.data;
      assert.equal((await call(1,'POST','/api/v1/tasks',{title:'Owner audit',assigned_to:7,priority:'URGENT'})).status,201);
      assert.equal((await call(2,'POST','/api/v1/tasks',{title:'Supervisor visit',assigned_to:6})).status,201);
    });

    await t.test('every role sees only accessible tasks, and search is server side',async()=>{
      const owner=await call(1,'GET','/api/v1/tasks?status=active');
      assert.equal(owner.status,200);
      assert.equal(owner.data.length,3);
      const manager=await call(3,'GET','/api/v1/tasks?status=all');
      assert.equal(manager.status,200);
      assert.deepEqual(manager.data.map(x=>x.title),['Replace consumables']);
      const engineer=await call(5,'GET','/api/v1/tasks');
      assert.deepEqual(engineer.data.map(x=>x.title),['Replace consumables']);
      const accountant=await call(7,'GET','/api/v1/tasks');
      assert.deepEqual(accountant.data.map(x=>x.title),['Owner audit']);
      const altManager=await call(4,'GET','/api/v1/tasks?status=all');
      assert.equal(altManager.data.length,0);
      const search=await call(1,'GET','/api/v1/tasks?search=consumables&status=all');
      assert.deepEqual(search.data.map(x=>x.title),['Replace consumables']);
      const missed=await call(1,'GET','/api/v1/tasks?search=not-here&status=all');
      assert.equal(missed.data.length,0);
      assert.equal((await call(1,'GET','/api/v1/tasks?status=invalid')).status,422);
    });

    await t.test('assignee can work and complete only with result, but cannot cancel or edit чужую задачу',async()=>{
      assert.equal((await call(6,'PATCH','/api/v1/tasks/'+managerTask.id,{status:'DONE',result:'Wrong person'})).status,403);
      assert.equal((await call(5,'PATCH','/api/v1/tasks/'+managerTask.id,{status:'DONE'})).status,422);
      assert.equal((await call(5,'PATCH','/api/v1/tasks/'+managerTask.id,{status:'CANCELLED'})).status,403);
      assert.equal((await call(5,'PATCH','/api/v1/tasks/'+managerTask.id,{status:'IN_PROGRESS'})).status,200);
      assert.equal((await call(5,'PATCH','/api/v1/tasks/'+managerTask.id,{status:'DONE',result:'Completed'})).status,200);
      const done=await call(3,'GET','/api/v1/tasks?status=done');
      assert.equal(done.data.length,1);
      assert.equal(done.data[0].result,'Completed');
    });

    await t.test('order-linked task creation respects manager branch membership',async()=>{
      assert.equal((await call(3,'POST','/api/v1/request/'+s.foreignOrder,{title:'Foreign',assigned_to:6})).status,403);
      assert.equal((await call(3,'POST','/api/v1/request/'+s.ownOrder,{title:'Check delivery',assigned_to:5})).status,201);
      assert.equal((await call(2,'POST','/api/v1/request/'+s.foreignOrder,{title:'Cross-branch supervisor',assigned_to:6})).status,201);
    });
  }finally{await s.close()}
});
