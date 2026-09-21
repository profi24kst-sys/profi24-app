const transientSchemaCodes=new Set(['40P01','40001','55P03']);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function retryTransient(operation,{attempts=6,baseDelayMs=80,logger=console,label='schema operation'}={}){
  let attempt=0;
  for(;;){
    try{return await operation()}
    catch(error){
      attempt+=1;
      if(!transientSchemaCodes.has(error?.code)||attempt>=attempts)throw error;
      const delay=baseDelayMs*Math.pow(2,attempt-1)+Math.floor(Math.random()*Math.max(1,baseDelayMs));
      logger?.warn?.({code:error.code,attempt,delay},`Transient ${label} lock/deadlock; retrying`);
      await sleep(delay);
    }
  }
}

export async function runSchemaStatements(pool,statements,options={}){
  for(const sql of statements)await retryTransient(()=>pool.query(sql),{...options,label:'schema'});
}

export async function runSchemaTransaction(pool,operation,options={}){
  return retryTransient(async()=>{
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const result=await operation(client);
      await client.query('COMMIT');
      return result;
    }catch(error){
      try{await client.query('ROLLBACK')}catch{}
      throw error;
    }finally{client.release()}
  },{...options,label:'schema transaction'});
}
