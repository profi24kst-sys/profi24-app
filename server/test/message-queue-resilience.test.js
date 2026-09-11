import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {createMessageQueueWorker,installMessageQueueLeaseSchema} from '../src/message-queue-worker.js';

async function harness(){
  const db=await PGlite.create();
  await db.exec(`CREATE TABLE message_queue(
    id BIGSERIAL PRIMARY KEY,
    channel TEXT NOT NULL,
    audience TEXT NOT NULL DEFAULT 'CUSTOMER',
    recipient TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'QUEUED',
    attempts INT NOT NULL DEFAULT 0,
    provider_message_id TEXT,
    error_text TEXT,
    dedupe_key TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await installMessageQueueLeaseSchema(db);
  return db;
}

async function seed(db,count,prefix='bulk'){
  for(let offset=0;offset<count;offset+=100){
    const size=Math.min(100,count-offset),values=[],params=[];
    for(let i=0;i<size;i++){
      const n=offset+i+1,base=params.length;
      values.push(`('WHATSAPP','CUSTOMER',$${base+1},$${base+2},'QUEUED',$${base+3})`);
      params.push(`+7701000${String(n).padStart(4,'0')}`,`${prefix} message ${n}`,`${prefix}:${n}`);
    }
    await db.query(`INSERT INTO message_queue(channel,audience,recipient,body,status,dedupe_key)
      SELECT v.channel,v.audience,v.recipient,v.body,v.status,v.dedupe_key
      FROM (VALUES ${values.join(',')}) AS v(channel,audience,recipient,body,status,dedupe_key)`,params);
  }
}

async function drain(worker,limit=100){
  let claimed=0,sent=0;
  for(let i=0;i<100;i++){
    const r=await worker.processQueue(limit);claimed+=r.claimed;sent+=r.sent;
    if(r.claimed===0)return{claimed,sent};
  }
  throw new Error('queue did not drain');
}

test('queue drains more than 500 events without loss or duplicates',async()=>{
  const db=await harness(),deliveries=new Map();
  try{
    await seed(db,620,'bulk');
    const worker=createMessageQueueWorker(db,{workerId:'worker-a',leaseSeconds:15,sendWhatsApp:async m=>{
      deliveries.set(Number(m.id),(deliveries.get(Number(m.id))||0)+1);
      return `provider-${m.id}`;
    }});
    const result=await drain(worker,100);
    assert.equal(result.sent,620);
    assert.equal(deliveries.size,620);
    assert.equal(Math.max(...deliveries.values()),1);
    const state=(await db.query(`SELECT status,count(*)::int c,min(attempts)::int min_attempts,max(attempts)::int max_attempts
      FROM message_queue GROUP BY status`)).rows;
    assert.deepEqual(state,[{status:'SENT',c:620,min_attempts:1,max_attempts:1}]);
  }finally{await db.close();}
});

test('stale PROCESSING claims are recovered after an interrupted worker without burning delivery attempts',async()=>{
  const db=await harness(),deliveries=new Map();
  try{
    await seed(db,560,'restart');
    const crashed=createMessageQueueWorker(db,{workerId:'worker-crashed',leaseSeconds:15});
    const claimed=await crashed.claim(180);
    assert.equal(claimed.length,180);
    assert.equal(Number((await db.query("SELECT count(*) c FROM message_queue WHERE status='PROCESSING'")).rows[0].c),180);
    assert.equal(Number((await db.query('SELECT count(*) c FROM message_queue WHERE attempts=0')).rows[0].c),560);

    await db.query("UPDATE message_queue SET processing_started_at=now()-interval '2 minutes' WHERE status='PROCESSING'");
    const restarted=createMessageQueueWorker(db,{workerId:'worker-restarted',leaseSeconds:15,sendWhatsApp:async m=>{
      deliveries.set(Number(m.id),(deliveries.get(Number(m.id))||0)+1);
      return `restart-${m.id}`;
    }});
    const result=await drain(restarted,100);
    assert.equal(result.sent,560);
    assert.equal(deliveries.size,560);
    assert.equal(Math.max(...deliveries.values()),1);
    const counts=(await db.query(`SELECT
      count(*) FILTER(WHERE status='SENT')::int sent,
      count(*) FILTER(WHERE status='QUEUED')::int queued,
      count(*) FILTER(WHERE status='PROCESSING')::int processing,
      count(*) FILTER(WHERE status='ERROR')::int errors
      FROM message_queue`)).rows[0];
    assert.deepEqual(counts,{sent:560,queued:0,processing:0,errors:0});
    assert.equal(Number((await db.query('SELECT count(*) c FROM message_queue WHERE attempts=1')).rows[0].c),560);
  }finally{await db.close();}
});

test('two workers cannot claim the same queued message',async()=>{
  const db=await harness(),deliveries=new Map();
  try{
    await seed(db,240,'parallel');
    const sender=async m=>{
      deliveries.set(Number(m.id),(deliveries.get(Number(m.id))||0)+1);
      await new Promise(resolve=>setTimeout(resolve,1));
      return `parallel-${m.id}`;
    };
    const a=createMessageQueueWorker(db,{workerId:'parallel-a',leaseSeconds:15,sendWhatsApp:sender});
    const b=createMessageQueueWorker(db,{workerId:'parallel-b',leaseSeconds:15,sendWhatsApp:sender});
    await Promise.all([a.processQueue(150),b.processQueue(150)]);
    await drain(a,100);
    assert.equal(deliveries.size,240);
    assert.equal(Math.max(...deliveries.values()),1);
    assert.equal(Number((await db.query("SELECT count(*) c FROM message_queue WHERE status='SENT'")).rows[0].c),240);
  }finally{await db.close();}
});

test('failed delivery retries safely and stops after max attempts',async()=>{
  const db=await harness();
  try{
    await seed(db,1,'failure');
    const worker=createMessageQueueWorker(db,{workerId:'failure-worker',leaseSeconds:15,maxAttempts:3,sendWhatsApp:async()=>{throw new Error('provider unavailable')}});
    await worker.processQueue(1);
    await worker.processQueue(1);
    await worker.processQueue(1);
    const row=(await db.query('SELECT status,attempts,error_text,processing_token FROM message_queue')).rows[0];
    assert.equal(row.status,'ERROR');
    assert.equal(row.attempts,3);
    assert.match(row.error_text,/provider unavailable/);
    assert.equal(row.processing_token,null);
  }finally{await db.close();}
});

test('missing provider configuration leaves the message queued without burning attempts',async()=>{
  const db=await harness();
  try{
    await seed(db,1,'unconfigured');
    const worker=createMessageQueueWorker(db,{workerId:'unconfigured-worker',leaseSeconds:15,sendWhatsApp:async()=>null});
    const result=await worker.processQueue(1);
    assert.deepEqual(result,{claimed:1,sent:0});
    const row=(await db.query('SELECT status,attempts,processing_token FROM message_queue')).rows[0];
    assert.equal(row.status,'QUEUED');
    assert.equal(row.attempts,0);
    assert.equal(row.processing_token,null);
  }finally{await db.close();}
});
