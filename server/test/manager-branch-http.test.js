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

test('MANAGER не видит чужой филиал в списках и dashboard',async()=>{
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  let queue=Promise.resolve();
  const pool={query,connect:async()=>{const prior=queue;let release;queue=new Promise(r=>{release=r});await prior;return {query,release}},end:async()=>{}};
  globalThis.__managerBranchPool=pool;
  let app;
  try{
    await migrateCore(pool);
    const kst=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id;
    const other=(await query("INSERT INTO branches(code,name) VALUES('MB2','Чужой филиал') RETURNING id")).rows[0].id;
    await query(`INSERT INTO users(name,email,password_hash,role) VALUES
      ('Owner','mb-owner@test.invalid','unused','OWNER'),
      ('Manager','mb-manager@test.invalid','unused','MANAGER'),
      ('Engineer KST','mb-eng1@test.invalid','unused','ENGINEER'),
      ('Engineer Other','mb-eng2@test.invalid','unused','ENGINEER')`);
    await query('UPDATE users SET primary_branch_id=$1 WHERE id=4',[other]);
    await query("INSERT INTO customers(name,phone) VALUES('Shared client','701'),('Foreign-only client','702')");
    const ownEquipment=(await query("INSERT INTO equipment(customer_id,category,brand,serial_number) VALUES(1,'Холодильник','OwnBrand','OWN-DEVICE') RETURNING id")).rows[0].id;
    const foreignEquipment=(await query("INSERT INTO equipment(customer_id,category,brand,serial_number) VALUES(2,'Холодильник','ForeignBrand','FOREIGN-DEVICE') RETURNING id")).rows[0].id;
    const own=(await query("INSERT INTO requests(number,customer_id,manager_id,engineer_id,branch_id,status,complaint,total,paid,direct_cost) VALUES('MB-KST',1,2,3,$1,'REPAIR','Own',1000,200,100) RETURNING id",[kst])).rows[0].id;
    const foreign=(await query("INSERT INTO requests(number,customer_id,engineer_id,branch_id,status,complaint,total,paid,direct_cost) VALUES('MB-OTHER',1,4,$1,'REPAIR','Foreign',9000,8000,4000) RETURNING id",[other])).rows[0].id;
    await query('UPDATE requests SET equipment_id=$1 WHERE id=$2',[ownEquipment,own]);
    await query('UPDATE requests SET customer_id=2,equipment_id=$1 WHERE id=$2',[foreignEquipment,foreign]);
    await query("INSERT INTO requests(number,customer_id,engineer_id,branch_id,status,complaint,created_at) SELECT 'MB-BULK-'||g,2,4,$1,'REPAIR','Foreign bulk',now()+INTERVAL '1 second' FROM generate_series(1,1001) g",[other]);
    await query("INSERT INTO complaints(number,request_id,customer_id,text,status) VALUES('MB-C1',$1,1,'Own complaint','OPEN'),('MB-C2',$2,2,'Foreign complaint','OPEN')",[own,foreign]);

    let src=await readFile(path.join(root,'index2.js'),'utf8');
    src=src.replace(/import pg from\s*['"]pg['"];?/g,'const pg={Pool:class {constructor(){return globalThis.__managerBranchPool}}};');
    src=src.replace(/\bfrom\s*(['"])([^'"]+)\1/g,(m,quote,spec)=>{
      if(spec.startsWith('node:')||builtinModules.includes(spec))return m;
      return 'from '+JSON.stringify(pathToFileURL(spec.startsWith('.')?path.resolve(root,spec):require.resolve(spec)).href);
    });
    src=src.replace(/logger:\s*true/g,'logger:false').replaceAll('app.listen(','testListen(').replaceAll('process.on(','testOn(');
    src='const testListen=async()=>{};const testOn=()=>{};\n'+src+'\nexport {app};';
    ({app}=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64')));await app.ready();
    await query("INSERT INTO dispatch_controls(request_id,reason,status,created_by,updated_by) VALUES($1,'Own control','OPEN',1,1),($2,'Foreign control','OPEN',1,1)",[own,foreign]);

    const token=app.jwt.sign({id:2,role:'MANAGER'});
    const call=async url=>{const r=await app.inject({method:'GET',url,headers:{authorization:'Bearer '+token}});return {status:r.statusCode,...r.json()}};

    const orders=await call('/api/v1/requests');
    assert.equal(orders.status,200);assert.ok(orders.data.some(x=>x.id===own));assert.ok(!orders.data.some(x=>x.id===foreign));
    const complaints=await call('/api/v1/complaints');
    assert.equal(complaints.status,200);assert.ok(complaints.data.some(x=>x.request_id===own));assert.ok(!complaints.data.some(x=>x.request_id===foreign));
    const controls=await call('/api/v1/dispatch-controls');
    assert.equal(controls.status,200);assert.ok(controls.data.some(x=>x.request_id===own));assert.ok(!controls.data.some(x=>x.request_id===foreign));
    const dashboard=await call('/api/v1/dashboard');
    assert.equal(dashboard.status,200);assert.equal(dashboard.data.total,1);assert.equal(Number(dashboard.data.gross_profit),0);
    const finance=await call('/api/v1/dashboard/finance');
    assert.equal(finance.status,200);assert.equal(Number(finance.data.totals.revenue),1000);assert.equal(Number(finance.data.totals.paid),200);
    const customers=await call('/api/v1/customers');
    assert.equal(customers.status,200);const client=customers.data.find(x=>x.id===1);assert.equal(client.request_count,1);assert.equal(Number(client.lifetime_paid),200);
    assert.ok(!customers.data.some(x=>x.id===2),'foreign-only customer must not reach manager');
    const equipment=await call('/api/v1/equipment');
    assert.equal(equipment.status,200);assert.ok(equipment.data.some(x=>x.id===ownEquipment));
    assert.ok(!equipment.data.some(x=>x.id===foreignEquipment),'foreign equipment must not reach manager');
    const ownerToken=app.jwt.sign({id:1,role:'OWNER'});
    const ownerCustomers=await app.inject({method:'GET',url:'/api/v1/customers',headers:{authorization:'Bearer '+ownerToken}});
    assert.equal(ownerCustomers.statusCode,200);assert.ok(ownerCustomers.json().data.some(x=>x.id===2));

    // Real core HTTP create path must enforce owner-configured custom fields.
    const ownerHeaders={authorization:'Bearer '+ownerToken},managerHeaders={authorization:'Bearer '+token};
    const fieldResponse=await app.inject({method:'POST',url:'/api/v1/order-form/fields',headers:ownerHeaders,payload:{code:'external_condition',label:'Внешний вид',field_type:'TEXT',required:true}});
    assert.equal(fieldResponse.statusCode,201,fieldResponse.body);
    const invalidOrder=await app.inject({method:'POST',url:'/api/v1/requests',headers:managerHeaders,payload:{customer_id:1,complaint:'Тест на обязательное дополнительное поле'}});
    assert.equal(invalidOrder.statusCode,422,invalidOrder.body);
    assert.equal(invalidOrder.json().error.code,'CUSTOM_FIELD_REQUIRED');

    const unsupported=await app.inject({method:'POST',url:'/api/v1/requests',headers:managerHeaders,payload:{
      customer_id:1,complaint:'Продажа пока не должна использовать процесс ремонта',order_type:'SALE',custom_fields:{}
    }});
    assert.equal(unsupported.statusCode,422);
    assert.equal(unsupported.json().error.code,'ORDER_TYPE_NOT_READY');


    const fieldDef=await app.inject({method:'POST',url:'/api/v1/order-form/fields',headers:ownerHeaders,payload:{
      code:'route_note',label:'Примечание к выезду',field_type:'TEXT',required:true,order_types:['FIELD']
    }});
    assert.equal(fieldDef.statusCode,201,fieldDef.body);
    const fieldSchema=await app.inject({method:'GET',url:'/api/v1/order-form/schema?order_type=FIELD',headers:managerHeaders});
    assert.equal(fieldSchema.statusCode,200);
    assert.ok(fieldSchema.json().data.fields.some(x=>x.code==='route_note'));
    assert.ok(!fieldSchema.json().data.fields.some(x=>x.code==='external_condition'));
    const fieldMissing=await app.inject({method:'POST',url:'/api/v1/requests',headers:managerHeaders,payload:{
      customer_id:1,complaint:'Выезд без обязательной заметки',order_type:'FIELD'
    }});
    assert.equal(fieldMissing.statusCode,422);
    assert.equal(fieldMissing.json().error.code,'CUSTOM_FIELD_REQUIRED');
    const fieldCreated=await app.inject({method:'POST',url:'/api/v1/requests',headers:managerHeaders,payload:{
      customer_id:1,complaint:'Выезд с маршрутом',order_type:'FIELD',custom_fields:{route_note:'  Вход со двора  '}
    }});
    assert.equal(fieldCreated.statusCode,201,fieldCreated.body);
    assert.equal(fieldCreated.json().data.order_type,'FIELD');
    assert.equal(fieldCreated.json().data.visit_type,'FIELD');
    assert.equal(fieldCreated.json().data.custom_fields.route_note,'Вход со двора');
    const workshop=await app.inject({method:'POST',url:'/api/v1/requests',headers:managerHeaders,payload:{
      customer_id:1,complaint:'Стационарный ремонт с приёмкой',order_type:'PAID_WORKSHOP'
    }});
    assert.equal(workshop.statusCode,201,workshop.body);
    assert.equal(workshop.json().data.visit_type,'WORKSHOP');

    const fieldId=fieldCreated.json().data.id,workshopId=workshop.json().data.id;
    const fieldWrongSchedule=await app.inject({method:'PATCH',url:'/api/v1/requests/'+fieldId+'/schedule',headers:managerHeaders,payload:{visit_type:'WORKSHOP'}});
    assert.equal(fieldWrongSchedule.statusCode,422);
    assert.equal(fieldWrongSchedule.json().error.code,'VISIT_TYPE_MISMATCH');
    assert.equal((await query('SELECT visit_type FROM requests WHERE id=$1',[fieldId])).rows[0].visit_type,'FIELD');
    const workshopWrongSchedule=await app.inject({method:'PATCH',url:'/api/v1/requests/'+workshopId+'/schedule',headers:managerHeaders,payload:{visit_type:'FIELD'}});
    assert.equal(workshopWrongSchedule.statusCode,422);
    assert.equal(workshopWrongSchedule.json().error.code,'VISIT_TYPE_MISMATCH');
    const fieldCorrectSchedule=await app.inject({method:'PATCH',url:'/api/v1/requests/'+fieldId+'/schedule',headers:managerHeaders,payload:{visit_type:'FIELD'}});
    assert.equal(fieldCorrectSchedule.statusCode,200,fieldCorrectSchedule.body);
    const foreignSchedule=await app.inject({method:'PATCH',url:'/api/v1/requests/'+foreign+'/schedule',headers:managerHeaders,payload:{visit_type:'FIELD'}});
    assert.equal(foreignSchedule.statusCode,403,'manager must not reschedule a different branch');

    const conflicting=await app.inject({method:'POST',url:'/api/v1/requests',headers:managerHeaders,payload:{
      customer_id:1,complaint:'Недопустимая несовместимость типа и посещения',order_type:'PAID_WORKSHOP',visit_type:'FIELD'
    }});
    assert.equal(conflicting.statusCode,422);
    assert.equal(conflicting.json().error.code,'VISIT_TYPE_MISMATCH');
    const partsUnavailable=await app.inject({method:'POST',url:'/api/v1/requests',headers:managerHeaders,payload:{
      customer_id:1,complaint:'Запчасти должны оформляться отдельно',order_type:'PARTS'
    }});
    assert.equal(partsUnavailable.statusCode,422);
    assert.equal(partsUnavailable.json().error.code,'ORDER_TYPE_NOT_READY');
    const createOrder=await app.inject({method:'POST',url:'/api/v1/requests',headers:managerHeaders,payload:{
      customer_id:1,complaint:'Тест на настраиваемые поля',order_type:'REPAIR',custom_fields:{external_condition:'  Царапины на корпусе  '}
    }});
    assert.equal(createOrder.statusCode,201,createOrder.body);
    assert.equal(createOrder.json().data.custom_fields.external_condition,'Царапины на корпусе');
    const createdId=createOrder.json().data.id;
    const reread=await app.inject({method:'GET',url:'/api/v1/requests/'+createdId,headers:managerHeaders});
    assert.equal(reread.statusCode,200);assert.equal(reread.json().data.custom_fields.external_condition,'Царапины на корпусе');
    const injection=await app.inject({method:'POST',url:'/api/v1/requests',headers:managerHeaders,payload:{
      customer_id:1,complaint:'Unknown custom field',custom_fields:{unexpected:'bad'}
    }});
    assert.equal(injection.statusCode,422);assert.equal(injection.json().error.code,'UNKNOWN_CUSTOM_FIELD');

    // Isolated fixtures at local midnight; old test records must not affect totals.
    await query("UPDATE requests SET created_at='2020-01-01T00:00:00Z'");
    for(const [suffix,stamp,total,branch,status] of [
      ['PREVIOUS-START','2026-07-31T19:00:00Z',700,kst,'REPAIR'],
      ['BEFORE-PREVIOUS','2026-07-31T18:59:59Z',9000,kst,'REPAIR'],
      ['BEFORE-START','2026-08-31T18:59:59Z',100,kst,'REPAIR'],
      ['START','2026-08-31T19:00:00Z',1000,kst,'REPAIR'],
      ['END','2026-09-30T18:59:59Z',2000,kst,'REPAIR'],
      ['AFTER-END','2026-09-30T19:00:00Z',8000,kst,'REPAIR'],
      ['FOREIGN','2026-09-15T12:00:00Z',50000,other,'REPAIR'],
      ['CANCELLED','2026-09-15T12:00:00Z',70000,kst,'CANCELLED']
    ])await query('INSERT INTO requests(number,customer_id,manager_id,branch_id,status,complaint,total,created_at) VALUES($1,1,2,$2,$3,$4,$5,$6)',['PERIOD-'+suffix,branch,status,'Timezone fixture',total,stamp]);
    for(const timezone of ['UTC','America/New_York']){
      await query(`SET TIME ZONE '${timezone}'`);
      const url='/api/v1/dashboard/finance?from=2026-09-01&to=2026-09-30';
      const scoped=await call(url);assert.equal(scoped.status,200);
      assert.equal(Number(scoped.data.totals.revenue),3000,timezone+' manager current');
      assert.equal(Number(scoped.data.previous.revenue),800,timezone+' manager previous');
      assert.equal(scoped.data.period.previous_from,'2026-08-01');
      assert.equal(scoped.data.period.time_zone,'Asia/Qostanay');
      const global=await app.inject({method:'GET',url,headers:ownerHeaders});assert.equal(global.statusCode,200,global.body);
      assert.equal(Number(global.json().data.totals.revenue),53000,timezone+' owner current');
      assert.equal(Number(global.json().data.previous.revenue),800,timezone+' owner previous');
    }

  }finally{
    if(app)await app.close();await db.close();delete globalThis.__managerBranchPool;
  }
});
