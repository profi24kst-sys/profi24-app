const transientSchemaCodes=new Set(['40P01','40001','55P03']);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export async function runSchemaStatements(pool,statements,{attempts=6,baseDelayMs=80,logger=console}={}){
  for(const sql of statements){
    let attempt=0;
    for(;;){
      try{
        await pool.query(sql);
        break;
      }catch(error){
        attempt+=1;
        if(!transientSchemaCodes.has(error?.code)||attempt>=attempts)throw error;
        const delay=baseDelayMs*Math.pow(2,attempt-1)+Math.floor(Math.random()*baseDelayMs);
        logger?.warn?.({code:error.code,attempt,delay},'Transient schema lock/deadlock; retrying');
        await sleep(delay);
      }
    }
  }
}
