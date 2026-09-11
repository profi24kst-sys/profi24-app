import {randomUUID} from 'node:crypto';

export const messageQueueLeaseStatements=[
  `ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ`,
  `ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS processing_token TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_message_queue_processing ON message_queue(status,processing_started_at)`
];

export async function installMessageQueueLeaseSchema(db){
  for(const sql of messageQueueLeaseStatements)await db.query(sql);
}

export function createMessageQueueWorker(db,{
  sendTelegram=async()=>null,
  sendWhatsApp=async()=>null,
  workerId=randomUUID(),
  leaseSeconds=Number(process.env.MESSAGE_QUEUE_LEASE_SECONDS||360),
  maxAttempts=3,
  logger=null
}={}){
  const q=(sql,params=[])=>db.query(sql,params);
  const safeLimit=value=>Math.max(1,Math.min(500,Number(value)||30));
  const safeLease=Math.max(15,Math.min(3600,Number(leaseSeconds)||360));
  const safeAttempts=Math.max(1,Math.min(20,Number(maxAttempts)||3));

  async function claim(limit=30){
    return (await q(`WITH candidates AS (
      SELECT id FROM message_queue
      WHERE status='QUEUED'
         OR (status='PROCESSING' AND processing_started_at < now()-($2::int*interval '1 second'))
      ORDER BY created_at,id
      FOR UPDATE SKIP LOCKED
      LIMIT $1
    )
    UPDATE message_queue mq
       SET status='PROCESSING',processing_started_at=now(),processing_token=$3,updated_at=now()
      FROM candidates c
     WHERE mq.id=c.id
     RETURNING mq.*`,[safeLimit(limit),safeLease,workerId])).rows;
  }

  async function beginAttempt(message){
    return (await q(`UPDATE message_queue
      SET processing_started_at=now(),attempts=attempts+1,updated_at=now()
      WHERE id=$1 AND status='PROCESSING' AND processing_token=$2 RETURNING *`,[message.id,workerId])).rows[0]||null;
  }

  async function markSent(message,providerMessageId){
    return (await q(`UPDATE message_queue
      SET status='SENT',provider_message_id=$1,sent_at=now(),updated_at=now(),
          processing_started_at=NULL,processing_token=NULL,error_text=NULL
      WHERE id=$2 AND status='PROCESSING' AND processing_token=$3 RETURNING *`,[
      String(providerMessageId||''),message.id,workerId
    ])).rows[0]||null;
  }

  async function releaseUnconfigured(message){
    await q(`UPDATE message_queue
      SET status='QUEUED',attempts=GREATEST(attempts-1,0),updated_at=now(),
          processing_started_at=NULL,processing_token=NULL
      WHERE id=$1 AND status='PROCESSING' AND processing_token=$2`,[message.id,workerId]);
  }

  async function markFailure(message,error){
    const terminal=Number(message.attempts)>=safeAttempts;
    await q(`UPDATE message_queue
      SET status=$1,error_text=$2,updated_at=now(),processing_started_at=NULL,processing_token=NULL
      WHERE id=$3 AND status='PROCESSING' AND processing_token=$4`,[
      terminal?'ERROR':'QUEUED',String(error?.message||error).slice(0,500),message.id,workerId
    ]);
  }

  async function dispatch(message){
    if(message.channel==='TELEGRAM')return sendTelegram(message);
    if(message.channel==='WHATSAPP')return sendWhatsApp(message);
    throw new Error(`Unsupported communication channel: ${message.channel}`);
  }

  async function processQueue(limit=30){
    const rows=await claim(limit);
    let sent=0;
    for(const claimed of rows){
      let message=claimed;
      try{
        message=await beginAttempt(claimed);
        if(!message)continue;
        const providerId=await dispatch(message);
        if(providerId==null){await releaseUnconfigured(message);continue;}
        if(await markSent(message,providerId))sent++;
      }catch(error){
        logger?.error?.({err:error,message_id:message?.id||claimed.id},'communication queue delivery failed');
        if(message)await markFailure(message,error);
      }
    }
    return{claimed:rows.length,sent};
  }

  async function releaseOwnedClaims(){
    const result=await q(`UPDATE message_queue
      SET status='QUEUED',updated_at=now(),processing_started_at=NULL,processing_token=NULL
      WHERE status='PROCESSING' AND processing_token=$1`,[workerId]);
    return Number(result.rowCount||0);
  }

  return{workerId,leaseSeconds:safeLease,maxAttempts:safeAttempts,claim,processQueue,releaseOwnedClaims};
}
