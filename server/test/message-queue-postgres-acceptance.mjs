import pg from 'pg';
import {createMessageQueueWorker,installMessageQueueLeaseSchema} from '../src/message-queue-worker.js';

const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:8});
const fail=message=>{throw new Error(`QUEUE_RESILIENCE_ACCEPTANCE: ${message}`)};

async function count(status){return Number((await pool.query('SELECT count(*) c FROM message_queue WHERE status=$1',[status])).rows[0].c)}
async function drain(workers,limit=80){
  for(let round=0;round<30;round++){
    const results=await Promise.all(workers.map(worker=>worker.processQueue(limit)));
    if(results.every(x=>x.claimed===0))return;
  }
  fail('queue did not drain in 30 rounds');
}

try{
  await pool.query('DROP TABLE IF EXISTS message_queue');
  await pool.query(`CREATE TABLE message_queue(
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
  await installMessageQueueLeaseSchema(pool);
  await pool.query(`INSERT INTO message_queue(channel,audience,recipient,body,status,dedupe_key)
    SELECT 'WHATSAPP','CUSTOMER','+7701000'||lpad(g::text,4,'0'),'Queue event '||g,'QUEUED','acceptance:'||g
    FROM generate_series(1,620) g`);

  const crashed=createMessageQueueWorker(pool,{workerId:'acceptance-crashed',leaseSeconds:15});
  const abandoned=await crashed.claim(180);
  if(abandoned.length!==180)fail(`expected 180 abandoned claims, got ${abandoned.length}`);
  if(await count('PROCESSING')!==180)fail('interrupted worker did not leave 180 PROCESSING rows');

  // A hard-killed worker cannot release its claims. Expire the lease to model restart recovery.
  await pool.query("UPDATE message_queue SET processing_started_at=now()-interval '2 minutes' WHERE status='PROCESSING'");

  const deliveries=new Map();
  const sender=async message=>{
    const id=Number(message.id),seen=(deliveries.get(id)||0)+1;
    deliveries.set(id,seen);
    if(seen>1)fail(`duplicate provider dispatch for message ${id}`);
    await new Promise(resolve=>setTimeout(resolve,id%3));
    return `provider-${id}`;
  };
  const workerA=createMessageQueueWorker(pool,{workerId:'acceptance-a',leaseSeconds:15,sendWhatsApp:sender});
  const workerB=createMessageQueueWorker(pool,{workerId:'acceptance-b',leaseSeconds:15,sendWhatsApp:sender});
  await drain([workerA,workerB]);

  const sent=await count('SENT'),queued=await count('QUEUED'),processing=await count('PROCESSING'),errors=await count('ERROR');
  if(sent!==620||queued!==0||processing!==0||errors!==0)fail(`unexpected final state sent=${sent} queued=${queued} processing=${processing} errors=${errors}`);
  if(deliveries.size!==620)fail(`provider received ${deliveries.size}/620 unique messages`);
  const recovered=Number((await pool.query('SELECT count(*) c FROM message_queue WHERE attempts=2')).rows[0].c);
  if(recovered!==180)fail(`expected 180 recovered claims with attempts=2, got ${recovered}`);

  await pool.query('TRUNCATE message_queue RESTART IDENTITY');
  await pool.query("INSERT INTO message_queue(channel,audience,recipient,body,status,dedupe_key) VALUES('WHATSAPP','CUSTOMER','+77010000000','Failure event','QUEUED','failure:1')");
  const failing=createMessageQueueWorker(pool,{workerId:'acceptance-failure',leaseSeconds:15,maxAttempts:3,sendWhatsApp:async()=>{throw new Error('simulated provider outage')}});
  await failing.processQueue(1);await failing.processQueue(1);await failing.processQueue(1);
  const failed=(await pool.query('SELECT status,attempts,processing_token FROM message_queue')).rows[0];
  if(failed.status!=='ERROR'||Number(failed.attempts)!==3||failed.processing_token!==null)fail(`retry terminal state invalid: ${JSON.stringify(failed)}`);

  console.log(`queue_resilience_acceptance=ok bulk=620 abandoned=180 recovered=${recovered} unique_deliveries=${deliveries.size} terminal_retry_attempts=${failed.attempts}`);
}finally{
  await pool.end();
}
