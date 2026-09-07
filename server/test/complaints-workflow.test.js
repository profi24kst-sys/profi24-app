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
  const pool={query,connect:async()=>{const prior=queue;let release;queue=new Promise(r=>{release=r});await prior;return {query,release}},end:async()=>{}};
  globalThis.__complaintsPool=pool;
  await migrateCore(pool);
  await query(`INSERT INTO users(name,email,password_hash,role) VALUES
    ('Owner','compl-owner@test.invalid','unused','OWNER'),
    ('Supervisor','compl-supervisor@test.invalid','unused','SUPERVISOR'),
    ('Accountant','compl-accountant@test.invalid','unused','ACCOUNTANT'),
    ('Manager','compl-manager@test.invalid','unused','MANAGER'),
    ('Engineer','compl-engineer@test.invalid','unused','ENGINEER'),
    ('Trainee','compl-trainee@test.invalid','unused','TRAINEE'),
    ('Foreign manager','compl-foreign-manager@test.invalid','unused','MANAGER'),
    ('Foreign engineer','compl-foreign-engineer@test.invalid','unused','ENGINEER')`);
  await query("INSERT INTO customers(name,phone) VALUES('Complaint Client','70000000101')");
  const kst=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id;
  const other=(await query("INSERT INTO branches(code,name,address) VALUES('CMP2','Другой филиал','Другой адрес') RETURNING id")).rows[0].id;
  await query('UPDATE users SET primary_branch_id=$1 WHERE id IN (7,8)',[other]);
  const own=(await query("INSERT INTO requests(number,customer_id,manager_id,engineer_id,branch_id,status,complaint,total,paid,closed_at) VALUES('CMP-CLOSED',1,4,5,$1,'CLOSED','Исходный закрытый ремонт',15000,15000,now()) RETURNING id",[kst])).rows[0].id;
  const foreign=(await query("INSERT INTO requests(number,customer_id,manager_id,engineer_id,branch_id,status,complaint,total,paid,closed_at) VALUES('CMP-FOREIGN',1,7,8,$1,'CLOSED','Чужой закрытый ремонт',12000,12000,now()) RETURNING id",[other])).rows[0].id;
  await query('INSERT INTO user_mentors(trainee_id,mentor_id,assigned_by) VALUES(6,5,1)');
  await query("INSERT INTO request_participants(request_id,user_id,participant_role,mentor_id,added_by) VALUES($1,6,'TRAINEE',5,1)",[own]);

  let src=await readFile(path.join(root,'index2.js'),'utf8');
  src=src.replace(/import pg from\s*['"]pg['"];?/g,'const pg={Pool:class {constructor(){return globalThis.__complaintsPool}}};');
  src=src.replace(/\bfrom\s*(['"])([^'"]+)\1/g,(m,quote,spec)=>{
    if(spec.startsWith('node:')||builtinModules.includes(spec))return m;
    return 'from '+JSON.stringify(pathToFileURL(spec.startsWith('.')?path.resolve(root,spec):require.resolve(spec)).href);
  });
  src=src.replace(/logger:\s*true/g,'logger:false').replaceAll('app.listen(','testListen(').replaceAll('process.on(','testOn(');
  src='const testListen=async()=>{};const testOn=()=>{};\n'+src+'\nexport {app};';
  const {app}=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));
  await app.ready();
  const roles={1:'OWNER',2:'SUPERVISOR',3:'ACCOUNTANT',4:'MANAGER',5:'ENGINEER',6:'TRAINEE',7:'MANAGER',8:'ENGINEER'};
  const tokens=Object.fromEntries(Object.entries(roles).map(([id,role])=>[id,app.jwt.sign({id:Number(id),role})]));
  async function call(method,url,payload,user=1){
    const res=await app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[user]}});
    let body;try{body=res.json()}catch{body={raw:res.body}}
    return {status:res.statusCode,...body};
  }
  return {db,query,pool,app,call,kst,other,own,foreign,close:async()=>{await app.close();await db.close();delete globalThis.__complaintsPool;}};
}

test('Претензии: регистрация, роли, rework, финвлияние и закрытие документированы',async t=>{
  const s=await setup();
  try{
    let complaint;
    await t.test('претензия создаётся к закрытому исходному заказу, не открывая его повторно',async()=>{
      const created=await s.call('POST','/api/v1/complaints',{source_request_id:s.own,text:'Повторная неисправность после ремонта',severity:'HIGH'},4);
      assert.equal(created.status,201,JSON.stringify(created));
      complaint=created.data;
      assert.match(complaint.number,/^KST-R-\d{4}-\d{7}$/);
      assert.equal(complaint.status,'OPEN');
      assert.equal(complaint.stage,'REGISTERED');
      assert.equal((await s.query('SELECT status FROM requests WHERE id=$1',[s.own])).rows[0].status,'CLOSED');
      const duplicate=await s.call('POST','/api/v1/complaints',{source_request_id:s.own,text:'Дубликат',severity:'NORMAL'},4);
      assert.equal(duplicate.status,409);
      assert.equal(duplicate.error?.code,'ACTIVE_COMPLAINT_EXISTS');
    });

    await t.test('MANAGER ограничен филиалом, ENGINEER/TRAINEE/ACCOUNTANT не регистрируют претензии',async()=>{
      assert.equal((await s.call('POST','/api/v1/complaints',{source_request_id:s.foreign,text:'Чужой филиал'},4)).status,403);
      assert.equal((await s.call('POST','/api/v1/complaints',{source_request_id:s.own,text:'Инженер не должен создавать'},5)).status,403);
      assert.equal((await s.call('POST','/api/v1/complaints',{source_request_id:s.own,text:'Стажёр не должен создавать'},6)).status,403);
      assert.equal((await s.call('POST','/api/v1/complaints',{source_request_id:s.own,text:'Бухгалтер не должен создавать'},3)).status,403);
    });

    await t.test('операционный workflow сохраняет классификацию, ответственного и причины',async()=>{
      const changed=await s.call('PATCH',`/api/v1/complaints/${complaint.id}`,{
        stage:'IN_REVIEW',classification:'REPAIR_QUALITY',responsible_id:5,
        root_cause:'Недостаточный контроль результата',prevention:'Обязательный контрольный тест перед выдачей'
      },4);
      assert.equal(changed.status,200,JSON.stringify(changed));
      assert.equal(changed.data.stage,'IN_REVIEW');
      assert.equal(changed.data.classification,'REPAIR_QUALITY');
      assert.equal(Number(changed.data.responsible_id),5);
      const foreignResponsible=await s.call('PATCH',`/api/v1/complaints/${complaint.id}`,{responsible_id:8},4);
      assert.equal(foreignResponsible.status,422);
    });

    await t.test('финансовый ущерб изменяют только OWNER/SUPERVISOR/ACCOUNTANT и инженер его не видит',async()=>{
      assert.equal((await s.call('PATCH',`/api/v1/complaints/${complaint.id}`,{financial_impact:3500,financial_note:'Повторный выезд и расходные материалы'},4)).status,403);
      const impact=await s.call('PATCH',`/api/v1/complaints/${complaint.id}`,{financial_impact:3500,financial_note:'Повторный выезд и расходные материалы'},3);
      assert.equal(impact.status,200,JSON.stringify(impact));
      const ownerView=await s.call('GET',`/api/v1/complaints/${complaint.id}`,undefined,1);
      assert.equal(Number(ownerView.data.financial_impact),3500);
      const engineerView=await s.call('GET',`/api/v1/complaints/${complaint.id}`,undefined,5);
      assert.equal(engineerView.status,200);
      assert.equal(Object.hasOwn(engineerView.data,'financial_impact'),false);
    });

    await t.test('rework можно привязать только через штатную parent/child связь',async()=>{
      const child=(await s.query("INSERT INTO requests(number,customer_id,manager_id,engineer_id,branch_id,status,complaint,original_request_id) VALUES('CMP-REWORK',1,4,5,$1,'REPAIR','Повторный ремонт',$2) RETURNING id",[s.kst,s.own])).rows[0].id;
      await s.query("INSERT INTO request_order_links(parent_request_id,child_request_id,link_type,reason,created_by) VALUES($1,$2,'REWORK','Повторный ремонт по претензии',4)",[s.own,child]);
      const linked=await s.call('PATCH',`/api/v1/complaints/${complaint.id}`,{rework_request_id:child,stage:'REWORK'},4);
      assert.equal(linked.status,200,JSON.stringify(linked));
      assert.equal(Number(linked.data.rework_request_id),Number(child));
      const invalid=await s.call('PATCH',`/api/v1/complaints/${complaint.id}`,{rework_request_id:s.foreign},4);
      assert.equal(invalid.status,409);
    });

    await t.test('закрытие требует классификацию и решение, после закрытия операционные поля неизменяемы',async()=>{
      const noResolution=await s.call('PATCH',`/api/v1/complaints/${complaint.id}`,{status:'CLOSED'},4);
      assert.equal(noResolution.status,409);
      assert.equal(noResolution.error?.code,'RESOLUTION_REQUIRED');
      const closed=await s.call('PATCH',`/api/v1/complaints/${complaint.id}`,{resolution:'Повторный ремонт выполнен, клиент подтвердил исправность',status:'CLOSED'},4);
      assert.equal(closed.status,200,JSON.stringify(closed));
      assert.equal(closed.data.status,'CLOSED');
      assert.equal(closed.data.stage,'RESOLVED');
      assert.ok(closed.data.closed_at);
      assert.equal((await s.call('PATCH',`/api/v1/complaints/${complaint.id}`,{root_cause:'Переписать после закрытия'},4)).status,409);
      const dashboard=await s.call('GET','/api/v1/dashboard',undefined,4);
      assert.equal(dashboard.status,200);
      assert.equal(dashboard.data.complaints_open,0);
    });

    await t.test('переоткрытие доступно OWNER/SUPERVISOR, но не MANAGER',async()=>{
      assert.equal((await s.call('POST',`/api/v1/complaints/${complaint.id}/reopen`,{reason:'Менеджер не должен переоткрывать'},4)).status,403);
      const reopened=await s.call('POST',`/api/v1/complaints/${complaint.id}/reopen`,{reason:'Клиент сообщил о повторном проявлении неисправности'},2);
      assert.equal(reopened.status,200,JSON.stringify(reopened));
      assert.equal(reopened.data.status,'OPEN');
      assert.equal(reopened.data.stage,'IN_REVIEW');
      assert.equal(reopened.data.closed_at,null);
    });

    await t.test('история исходного заказа содержит аудируемые события претензии',async()=>{
      const actions=(await s.query("SELECT action FROM request_history WHERE request_id=$1 AND action LIKE 'COMPLAINT_%' ORDER BY id",[s.own])).rows.map(x=>x.action);
      assert.ok(actions.includes('COMPLAINT_CREATED'));
      assert.ok(actions.includes('COMPLAINT_UPDATED'));
      assert.ok(actions.includes('COMPLAINT_CLOSED'));
      assert.ok(actions.includes('COMPLAINT_REOPENED'));
    });
  }finally{await s.close();}
});
