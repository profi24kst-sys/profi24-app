import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runSchemaStatements,runSchemaTransaction} from '../src/schema-retry.js';

const transient=code=>Object.assign(new Error(code),{code});

test('schema statements retry transient PostgreSQL deadlocks without replaying completed statements',async()=>{
  const calls=[];let failed=false;
  const pool={query:async sql=>{
    calls.push(sql);
    if(sql==='B'&&!failed){failed=true;throw transient('40P01')}
    return{rows:[]};
  }};
  await runSchemaStatements(pool,['A','B','C'],{attempts:3,baseDelayMs:0,logger:{warn(){}}});
  assert.deepEqual(calls,['A','B','B','C']);
});

test('schema statements fail immediately on permanent SQL errors',async()=>{
  let calls=0;
  const pool={query:async()=>{calls+=1;throw transient('42601')}};
  await assert.rejects(
    ()=>runSchemaStatements(pool,['BROKEN'],{attempts:4,baseDelayMs:0,logger:{warn(){}}}),
    error=>error.code==='42601'
  );
  assert.equal(calls,1);
});

test('schema transaction rolls back and retries the whole DDL unit after a deadlock',async()=>{
  let attempt=0;const events=[];
  const pool={connect:async()=>{
    attempt+=1;const current=attempt;
    return{
      query:async sql=>{
        events.push(`${current}:${sql}`);
        if(current===1&&sql==='CREATE TRIGGER guard')throw transient('40P01');
        return{rows:[]};
      },
      release(){events.push(`${current}:RELEASE`)}
    };
  }};
  const result=await runSchemaTransaction(pool,async client=>{
    await client.query('DROP TRIGGER guard');
    await client.query('CREATE TRIGGER guard');
    return 'ok';
  },{attempts:3,baseDelayMs:0,logger:{warn(){}}});
  assert.equal(result,'ok');
  assert.deepEqual(events,[
    '1:BEGIN','1:DROP TRIGGER guard','1:CREATE TRIGGER guard','1:ROLLBACK','1:RELEASE',
    '2:BEGIN','2:DROP TRIGGER guard','2:CREATE TRIGGER guard','2:COMMIT','2:RELEASE'
  ]);
});
