import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {installWebsiteIntake} from '../src/website-intake.js';

async function harness(secret='website-test-secret-2026'){
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  let chain=Promise.resolve();
  const pool={
    query,
    connect:async()=>{
      const before=chain;let release;
      chain=new Promise(resolve=>{release=resolve});
      await before;
      return{query,release};
    },
    end:async()=>{}
  };
  await migrateCore(pool);
  const app=Fastify({logger:false});
  await app.register(rateLimit,{max:300,timeWindow:'1 minute'});
  installWebsiteIntake(app,pool,{secret});
  await app.ready();
  return{app,db,query,secret};
}

function headers(secret,key){
  return{'x-profi24-intake-secret':secret,'x-idempotency-key':key};
}

const basePayload={
  name:'Иван Клиент',
  phone:'+7 701 111 22 33',
  email:'ivan@example.com',
  address:'Костанай, ул. Тестовая 1',
  category:'Холодильник',
  brand:'LG',
  model:'GA-B509',
  complaint:'Не охлаждает холодильное отделение',
  visit_type:'FIELD',
  branch_code:'KST',
  page_url:'https://profi24.kz/kostanay/remont-holodilnikov.htm',
  utm_source:'google',
  utm_medium:'cpc',
  utm_campaign:'repair_fridge_kostanay'
};

test('website intake securely creates a normal SITE request and is idempotent',async()=>{
  const {app,db,query,secret}=await harness();
  try{
    let r=await app.inject({method:'POST',url:'/api/v1/website-intake',payload:basePayload,headers:headers('wrong-secret','site-test-001')});
    assert.equal(r.statusCode,401);
    assert.equal(Number((await query('SELECT count(*) c FROM website_intake_events')).rows[0].c),0);

    r=await app.inject({method:'POST',url:'/api/v1/website-intake',payload:basePayload,headers:headers(secret,'site-test-001')});
    assert.equal(r.statusCode,201,r.body);
    const first=r.json().data;
    assert.equal(first.status,'NEW');
    assert.equal(first.duplicate,false);
    assert.match(first.number,/^KST-\d{4}-\d{7}$/);

    const order=(await query('SELECT * FROM requests WHERE id=$1',[first.request_id])).rows[0];
    assert.equal(order.source,'SITE');
    assert.equal(order.status,'NEW');
    assert.equal(order.priority,'NORMAL');
    assert.equal(order.visit_type,'FIELD');
    assert.equal(order.manager_id,null);
    assert.equal(order.engineer_id,null);
    assert.ok(order.sla_deadline);
    const branch=(await query('SELECT code FROM branches WHERE id=$1',[order.branch_id])).rows[0];
    assert.equal(branch.code,'KST');

    const customer=(await query('SELECT * FROM customers WHERE id=$1',[first.customer_id])).rows[0];
    assert.equal(customer.phone_norm,'77011112233');
    assert.equal(customer.email,'ivan@example.com');
    const equipment=(await query('SELECT * FROM equipment WHERE id=$1',[first.equipment_id])).rows[0];
    assert.equal(equipment.category,'Холодильник');
    assert.equal(equipment.brand,'LG');

    const history=(await query('SELECT action,details FROM request_history WHERE request_id=$1 ORDER BY id',[first.request_id])).rows;
    assert.deepEqual(history.map(x=>x.action),['REQUEST_CREATED','WEBSITE_INTAKE_ACCEPTED']);
    const accepted=history.find(x=>x.action==='WEBSITE_INTAKE_ACCEPTED');
    assert.equal(accepted.details.utm_source,'google');
    assert.equal(accepted.details.utm_campaign,'repair_fridge_kostanay');
    assert.equal(accepted.details.branch_code,'KST');

    const event=(await query('SELECT * FROM website_intake_events WHERE idempotency_key=$1',['site-test-001'])).rows[0];
    assert.equal(event.status,'CREATED');
    assert.equal(Number(event.request_id),Number(first.request_id));

    r=await app.inject({method:'POST',url:'/api/v1/website-intake',payload:basePayload,headers:headers(secret,'site-test-001')});
    assert.equal(r.statusCode,200,r.body);
    assert.equal(r.json().data.duplicate,true);
    assert.equal(Number(r.json().data.id),Number(first.request_id));
    assert.equal(Number((await query('SELECT count(*) c FROM requests')).rows[0].c),1);
    assert.equal(Number((await query('SELECT count(*) c FROM customers')).rows[0].c),1);
    assert.equal(Number((await query('SELECT count(*) c FROM equipment')).rows[0].c),1);
    assert.equal(Number((await query('SELECT count(*) c FROM website_intake_events')).rows[0].c),1);

    r=await app.inject({method:'POST',url:'/api/v1/website-intake',payload:{...basePayload,complaint:'Другой текст'},headers:headers(secret,'site-test-001')});
    assert.equal(r.statusCode,409);
    assert.equal(r.json().error.code,'IDEMPOTENCY_CONFLICT');
    assert.equal(Number((await query('SELECT count(*) c FROM requests')).rows[0].c),1);
  }finally{
    await app.close();
    await db.close();
  }
});

test('website intake reuses customer by phone and rolls back rejected branch atomically',async()=>{
  const {app,db,query,secret}=await harness();
  try{
    let r=await app.inject({method:'POST',url:'/api/v1/website-intake',payload:basePayload,headers:headers(secret,'site-reuse-001')});
    assert.equal(r.statusCode,201,r.body);
    const customerId=r.json().data.customer_id;

    r=await app.inject({method:'POST',url:'/api/v1/website-intake',payload:{...basePayload,name:'Иван Повторно',email:'changed@example.com',complaint:'Теперь шумит компрессор'},headers:headers(secret,'site-reuse-002')});
    assert.equal(r.statusCode,201,r.body);
    assert.equal(Number(r.json().data.customer_id),Number(customerId));
    assert.equal(Number((await query('SELECT count(*) c FROM customers')).rows[0].c),1);
    assert.equal(Number((await query('SELECT count(*) c FROM requests')).rows[0].c),2);
    const customer=(await query('SELECT * FROM customers WHERE id=$1',[customerId])).rows[0];
    assert.equal(customer.email,'ivan@example.com','existing non-empty customer fields must not be overwritten by website retry');

    const before={
      events:Number((await query('SELECT count(*) c FROM website_intake_events')).rows[0].c),
      requests:Number((await query('SELECT count(*) c FROM requests')).rows[0].c),
      customers:Number((await query('SELECT count(*) c FROM customers')).rows[0].c),
      equipment:Number((await query('SELECT count(*) c FROM equipment')).rows[0].c)
    };
    r=await app.inject({method:'POST',url:'/api/v1/website-intake',payload:{...basePayload,phone:'+7 702 222 33 44',branch_code:'NOPE'},headers:headers(secret,'site-bad-branch-001')});
    assert.equal(r.statusCode,422,r.body);
    assert.equal(r.json().error.code,'BRANCH_NOT_FOUND');
    assert.equal(Number((await query('SELECT count(*) c FROM website_intake_events')).rows[0].c),before.events);
    assert.equal(Number((await query('SELECT count(*) c FROM requests')).rows[0].c),before.requests);
    assert.equal(Number((await query('SELECT count(*) c FROM customers')).rows[0].c),before.customers);
    assert.equal(Number((await query('SELECT count(*) c FROM equipment')).rows[0].c),before.equipment);
  }finally{
    await app.close();
    await db.close();
  }
});

test('website intake fails closed when integration secret is not configured',async()=>{
  const {app,db}=await harness('');
  try{
    const r=await app.inject({method:'POST',url:'/api/v1/website-intake',payload:basePayload,headers:{'x-idempotency-key':'site-disabled-001'}});
    assert.equal(r.statusCode,503);
    assert.equal(r.json().error.code,'WEBSITE_INTAKE_DISABLED');
  }finally{
    await app.close();
    await db.close();
  }
});

test('website intake resolves every merged phone alias to the surviving customer',async()=>{
  const {app,db,query,secret}=await harness();
  try{
    const target=Number((await query("INSERT INTO customers(name,phone,phone_norm) VALUES('Основной','+7 701 000 00 01','77010000001') RETURNING id")).rows[0].id);
    const source=Number((await query("INSERT INTO customers(name,phone,phone_norm,deleted_at,delete_reason) VALUES('Архивный','+7 702 000 00 02',NULL,now(),$1) RETURNING id",[`MERGED_INTO:${target}:test`])).rows[0].id);
    await query('INSERT INTO customer_merge_aliases(source_customer_id,target_customer_id,phone_norm) VALUES($1,$2,$3)',[source,target,'77020000002']);
    const r=await app.inject({method:'POST',url:'/api/v1/website-intake',payload:{...basePayload,phone:'+7 702 000 00 02'},headers:headers(secret,'site-merged-phone-001')});
    assert.equal(r.statusCode,201,r.body);
    assert.equal(Number(r.json().data.customer_id),target);
    assert.equal(Number((await query('SELECT count(*) c FROM customers')).rows[0].c),2,'website must not recreate a merged customer');
  }finally{
    await app.close();
    await db.close();
  }
});
