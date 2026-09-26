import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inflateRawSync} from 'node:zlib';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {parseDirectoryQuery,registerDirectoryRoutes} from '../src/directory-routes.js';
import {xlsxBuffer} from '../src/xlsx-export.js';

function sheetXml(buffer){
  let offset=0;
  while(offset<buffer.length){
    const signature=buffer.readUInt32LE(offset);
    if(signature!==0x04034b50)break;
    const method=buffer.readUInt16LE(offset+8),length=buffer.readUInt32LE(offset+18);
    const filenameLength=buffer.readUInt16LE(offset+26),extraLength=buffer.readUInt16LE(offset+28);
    const filename=buffer.subarray(offset+30,offset+30+filenameLength).toString('utf8');
    const start=offset+30+filenameLength+extraLength;
    if(filename==='xl/worksheets/sheet1.xml'){
      const data=buffer.subarray(start,start+length);
      return (method===8?inflateRawSync(data):data).toString('utf8');
    }
    offset=start+length;
  }
  throw new Error('Missing worksheet XML');
}

async function setup(){
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(results=>results.at(-1));
  let queue=Promise.resolve();
  const pool={query,connect:async()=>{
    const previous=queue;
    let release;
    queue=new Promise(resolve=>{release=resolve});
    await previous;
    return{query,release};
  },end:async()=>{}};
  await migrateCore(pool);
  const kst=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id;
  const other=(await query("INSERT INTO branches(code,name) VALUES('ALT-DIR','Север') RETURNING id")).rows[0].id;
  await query("INSERT INTO users(name,email,password_hash,role) VALUES "+
    "('Owner','dir-owner@test.invalid','unused','OWNER'),"+
    "('Supervisor','dir-supervisor@test.invalid','unused','SUPERVISOR'),"+
    "('Manager KST','dir-manager@test.invalid','unused','MANAGER'),"+
    "('Manager ALT','dir-alt-manager@test.invalid','unused','MANAGER'),"+
    "('Engineer KST','dir-engineer@test.invalid','unused','ENGINEER'),"+
    "('Engineer ALT','dir-engineer-alt@test.invalid','unused','ENGINEER'),"+
    "('Accountant','dir-accountant@test.invalid','unused','ACCOUNTANT'),"+
    "('Trainee','dir-trainee@test.invalid','unused','TRAINEE')");
  await query('UPDATE users SET primary_branch_id=$1 WHERE id IN (4,6)',[other]);
  await query('DELETE FROM user_branches WHERE user_id IN (4,6) AND branch_id=$1',[kst]);
  await query("INSERT INTO customers(name,phone,phone_norm) VALUES "+
    "('=HYPERLINK(\"https://example.invalid\",\"hi\")','77001110001','77001110001'),"+
    "('Чужой филиал','77001110002','77001110002'),"+
    "('Без заказа','77001110003','77001110003')");
  await query("INSERT INTO requests(number,customer_id,engineer_id,manager_id,branch_id,status,complaint,total,paid,direct_cost,source) "+
    "VALUES ('KST-A',1,5,3,$1,'REPAIR','Тест <маркер> & проверка',1500,1000,300,'OTHER')",[kst]);
  await query("INSERT INTO requests(number,customer_id,engineer_id,manager_id,branch_id,status,complaint,total,paid,direct_cost,source) "+
    "VALUES ('ALT-B',1,6,4,$1,'REPAIR','Другой филиал',500,200,100,'OTHER')",[other]);
  await query("INSERT INTO requests(number,customer_id,engineer_id,manager_id,branch_id,status,complaint,total,paid,direct_cost,source) "+
    "VALUES ('ALT-C',2,6,4,$1,'CLOSED','Только другой филиал',1000,1000,100,'OTHER')",[other]);
  for(let i=0;i<31;i++){
    await query("INSERT INTO requests(number,customer_id,manager_id,branch_id,status,complaint,total) "+
      "VALUES($1,1,3,$2,'NEW','Проверка списка',10)",['KST-'+i,kst]);
  }
  const app=Fastify({logger:false});
  await app.register(jwt,{secret:'directory-test-secret'});
  registerDirectoryRoutes(app,pool);
  await app.ready();
  const roles={1:'OWNER',2:'SUPERVISOR',3:'MANAGER',4:'MANAGER',5:'ENGINEER',6:'ENGINEER',7:'ACCOUNTANT',8:'TRAINEE'};
  async function call(user,url){
    const authorization='Bearer '+app.jwt.sign({id:user,role:roles[user]});
    const res=await app.inject({method:'GET',url,headers:{authorization}});
    let body;
    try{body=res.json()}catch{body=null}
    return{status:res.statusCode,headers:res.headers,body,raw:res.rawPayload};
  }
  return{call,query,kst,other,close:async()=>{await app.close();await db.close()}};
}

test('directory query parser validates limits, dates and status',()=>{
  assert.equal(parseDirectoryQuery({page:2,limit:50,status:'all',month:'2026-09'}).value.offset,50);
  assert.ok(parseDirectoryQuery({page:0}).error);
  assert.ok(parseDirectoryQuery({page:1.5}).error);
  assert.ok(parseDirectoryQuery({limit:101}).error);
  assert.ok(parseDirectoryQuery({status:'UNKNOWN'}).error);
  assert.ok(parseDirectoryQuery({month:'2026-13'}).error);
});

test('XLSX uses literal text and a valid ZIP worksheet; caps exported rows',()=>{
  const buffer=xlsxBuffer({sheetName:'Тест',columns:[{header:'Имя'},{header:'Сумма',type:'number'}],
    rows:[['=HYPERLINK("https://example.invalid","x")',123.5],['< & >',0]]});
  assert.equal(buffer.readUInt32LE(0),0x04034b50);
  const worksheet=sheetXml(buffer);
  assert.match(worksheet,/t="inlineStr"/);
  assert.doesNotMatch(worksheet,/<f[\s>]/);
  assert.match(worksheet,/=HYPERLINK/);
  assert.match(worksheet,/&lt; &amp; &gt;/);
  assert.match(worksheet,/<v>123.5<\/v>/);
  assert.throws(()=>xlsxBuffer({columns:[{header:'A'}],rows:Array.from({length:10001},()=>['x'])}),/limit/);
});

test('directory: pagination, filter/search, role and branch visibility, Excel exports',async t=>{
  const s=await setup();
  try{
    await t.test('pagination is database-side, stable, and never silently drops record 1001+',async()=>{
      const first=await s.call(1,'/api/v1/directory/orders?status=ALL&page=1&limit=25');
      assert.equal(first.status,200,JSON.stringify(first.body));
      assert.equal(first.body.data.length,25);
      assert.equal(first.body.meta.total,34);
      assert.equal(first.body.meta.pages,2);
      const second=await s.call(1,'/api/v1/directory/orders?status=ALL&page=2&limit=25');
      assert.equal(second.status,200);
      assert.equal(second.body.data.length,9);
      const firstIds=new Set(first.body.data.map(r=>r.id));
      assert.ok(second.body.data.every(r=>!firstIds.has(r.id)));
      const filtered=await s.call(1,'/api/v1/directory/orders?status=NEW&search=KST-&limit=100');
      assert.equal(filtered.body.meta.total,31);
      assert.equal(filtered.body.meta.counts.new,31);
      const literal=await s.call(1,'/api/v1/directory/orders?search=KST-A&status=ALL');
      assert.equal(literal.body.data.length,1);
      assert.equal((await s.call(1,'/api/v1/directory/orders?page=-1')).status,422);
    });

    await t.test('branch isolation applies before LIMIT and before export; technicians see only assigned orders',async()=>{
      const manager=await s.call(3,'/api/v1/directory/orders?status=ALL&limit=100');
      assert.equal(manager.body.meta.total,32);
      assert.ok(manager.body.data.every(row=>row.branch_code==='KST'));
      const other=await s.call(4,'/api/v1/directory/orders?status=ALL&limit=100');
      assert.equal(other.body.meta.total,2);
      const engineer=await s.call(5,'/api/v1/directory/orders?status=ALL');
      assert.deepEqual(engineer.body.data.map(row=>row.number),['KST-A']);
      assert.ok(!('direct_cost' in engineer.body.data[0]));
      assert.equal((await s.call(5,'/api/v1/directory/orders/export?status=ALL')).status,403);
      const exportManager=await s.call(3,'/api/v1/directory/orders/export?status=ALL');
      assert.equal(exportManager.status,200);
      assert.match(exportManager.headers['content-type'],/spreadsheetml\.sheet/);
      const xml=sheetXml(exportManager.raw);
      assert.match(xml,/KST-A/);
      assert.doesNotMatch(xml,/ALT-B/);
      assert.doesNotMatch(xml,/<f[\s>]/);
      assert.match(xml,/&lt;маркер&gt; &amp; проверка/);
    });

    await t.test('customer totals are computed only from accessible branch, with no cross-branch PII',async()=>{
      const manager=await s.call(3,'/api/v1/directory/customers?limit=25');
      assert.equal(manager.status,200);
      assert.equal(manager.body.meta.total,1);
      assert.equal(Number(manager.body.data[0].lifetime_paid),1000);
      const owner=await s.call(1,'/api/v1/directory/customers?limit=25');
      assert.equal(owner.body.meta.total,3);
      const main=owner.body.data.find(row=>row.id===1);
      assert.equal(Number(main.lifetime_paid),1200);
      assert.equal(main.request_count,33);
      const focused=await s.call(3,'/api/v1/directory/customers?focus_id=1');
      assert.deepEqual(focused.body.data.map(row=>row.id),[1]);
      assert.equal(focused.body.meta.total,1);
      const foreignFocus=await s.call(3,'/api/v1/directory/customers?focus_id=2');
      assert.equal(foreignFocus.body.meta.total,0);
      assert.equal((await s.call(3,'/api/v1/directory/customers?focus_id=oops')).status,422);
      const engineer=await s.call(5,'/api/v1/directory/customers');
      assert.equal(engineer.body.data.length,1);
      assert.ok(!('lifetime_paid' in engineer.body.data[0]));
      const xlsx=await s.call(3,'/api/v1/directory/customers/export');
      assert.equal(xlsx.status,200);
      const xml=sheetXml(xlsx.raw);
      assert.match(xml,/HYPERLINK/);
      assert.doesNotMatch(xml,/<f[\s>]/);
      assert.doesNotMatch(xml,/Чужой филиал/);
    });

    await t.test('server search finds records beyond the legacy 1000 rows and isolates equipment by role',async()=>{
      await s.query("INSERT INTO customers(name,phone,phone_norm,created_at) "+
        "SELECT 'Архивный клиент '||g,'7700999'||lpad(g::text,4,'0'),'7700999'||lpad(g::text,4,'0'),"+
        "'2020-01-01T00:00:00Z'::timestamptz FROM generate_series(1,1001) g");
      const archive=(await s.query("SELECT id FROM customers WHERE name='Архивный клиент 1001'")).rows[0].id;
      const unused=(await s.query("INSERT INTO equipment(customer_id,category,brand,model,serial_number) "+
        "VALUES($1,'Холодильник','ArchiveBrand','Old','ARCHIVE-SERIAL-1001') RETURNING id",[archive])).rows[0].id;
      const owner=await s.call(1,'/api/v1/directory/customers?search='+encodeURIComponent('Архивный клиент 1001')+'&limit=5');
      assert.equal(owner.status,200);
      assert.deepEqual(owner.body.data.map(row=>row.id),[archive]);
      assert.equal((await s.call(3,'/api/v1/directory/customers?search='+encodeURIComponent('Архивный клиент 1001'))).body.meta.total,0);
      const archiveOrder=(await s.query("INSERT INTO requests(number,customer_id,equipment_id,manager_id,branch_id,status,complaint,created_at) "+
        "VALUES('ARCHIVE-ORDER-1001',$1,$2,3,$3,'CLOSED','Давний заказ','2020-01-01T00:00:00Z') RETURNING id",[archive,unused,s.kst])).rows[0].id;
      const managerOrders=await s.call(3,'/api/v1/directory/orders?status=ALL&search=ARCHIVE-ORDER-1001&limit=5');
      assert.deepEqual(managerOrders.body.data.map(row=>row.id),[archiveOrder]);
      const managerCustomers=await s.call(3,'/api/v1/directory/customers?search='+encodeURIComponent('Архивный клиент 1001')+'&limit=5');
      assert.deepEqual(managerCustomers.body.data.map(row=>row.id),[archive]);
      const formattedPhone=encodeURIComponent('+7 (700) 999 1001');
      assert.deepEqual((await s.call(3,'/api/v1/directory/customers?search='+formattedPhone)).body.data.map(row=>row.id),[archive]);
      assert.deepEqual((await s.call(3,'/api/v1/directory/orders?status=ALL&search='+formattedPhone)).body.data.map(row=>row.id),[archiveOrder]);
      const managerEquipment=await s.call(3,'/api/v1/directory/equipment?search=ARCHIVE-SERIAL-1001&limit=5');
      assert.equal(managerEquipment.status,200,JSON.stringify(managerEquipment.body));
      assert.deepEqual(managerEquipment.body.data.map(row=>row.id),[unused]);
      assert.ok(managerEquipment.body.data[0].created_at,'equipment directory includes created_at');
      const deepLink=await s.call(3,'/api/v1/directory/equipment?focus_id='+unused);
      assert.equal(deepLink.status,200);
      assert.deepEqual(deepLink.body.data.map(row=>row.id),[unused]);
      assert.equal(deepLink.body.meta.total,1);
      assert.equal((await s.call(4,'/api/v1/directory/equipment?focus_id='+unused)).body.meta.total,0);
      assert.equal((await s.call(6,'/api/v1/directory/equipment?focus_id='+unused)).body.meta.total,0);
      assert.equal((await s.call(1,'/api/v1/directory/equipment?focus_id=bogus')).status,422);
      assert.equal((await s.call(3,'/api/v1/directory/equipment?focus_id='+unused+'&customer_id=1')).body.meta.total,0);
      assert.equal((await s.call(4,'/api/v1/directory/equipment?search=ARCHIVE-SERIAL-1001')).body.meta.total,0);
      assert.equal((await s.call(6,'/api/v1/directory/equipment?search=ARCHIVE-SERIAL-1001')).body.meta.total,0);
      assert.deepEqual((await s.call(5,'/api/v1/directory/equipment?customer_id='+archive)).body.data.map(row=>row.id),[]);
      assert.deepEqual((await s.call(1,'/api/v1/directory/equipment?customer_id='+archive)).body.data.map(row=>row.id),[unused]);
      assert.equal((await s.call(1,'/api/v1/directory/equipment?customer_id=bad')).status,422);
      assert.equal((await s.call(1,'/api/v1/directory/equipment?search='+encodeURIComponent('A'.repeat(121)))).status,422);
      assert.equal((await s.call(1,'/api/v1/directory/equipment?search='+encodeURIComponent('%_\\'))).status,200);
    });

    await t.test('month limits exports and lists in the service centre time zone',async()=>{
      await s.query("INSERT INTO requests(number,customer_id,manager_id,branch_id,status,complaint,created_at) "+
        "VALUES('MONTH-BOUNDARY',1,3,$1,'CLOSED','UTC August, Kostanay September','2026-08-31T20:30:00Z')",[s.kst]);
      const sep=await s.call(3,'/api/v1/directory/orders?status=ALL&month=2026-09&search=MONTH-BOUNDARY');
      assert.equal(sep.status,200,JSON.stringify(sep.body));
      assert.deepEqual(sep.body.data.map(row=>row.number),['MONTH-BOUNDARY']);
      const aug=await s.call(3,'/api/v1/directory/orders?status=ALL&month=2026-08&search=MONTH-BOUNDARY');
      assert.equal(aug.body.meta.total,0);
      const sepCustomers=await s.call(3,'/api/v1/directory/customers?month=2026-09');
      assert.equal(sepCustomers.status,200);
      assert.equal(sepCustomers.body.meta.total,1);
    });
  }finally{await s.close()}
});
