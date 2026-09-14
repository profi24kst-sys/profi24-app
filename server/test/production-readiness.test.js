import test from 'node:test';
import assert from 'node:assert/strict';
import {assessProductionReadiness} from '../src/production-readiness.js';

function pool({branches=[],roles=[],accounts=[],orphaned=0}){
  let n=0;
  return {query:async()=>({rows:[branches,roles,accounts,[{count:orphaned}]][n++]})};
}

const ready={
  branches:[{id:1,code:'KST',name:'Костанай',active_users:4,managers:1,engineers:1}],
  roles:[{role:'OWNER',count:1},{role:'ACCOUNTANT',count:1},{role:'MANAGER',count:1},{role:'ENGINEER',count:1}],
  accounts:[{branch_id:1,type:'CASH',count:1},{branch_id:1,type:'BANK',count:1}]
};
const env={WHATSAPP_TOKEN:'token',WHATSAPP_PHONE_NUMBER_ID:'phone',WEBSITE_INTAKE_SECRET:'secret',TELEGRAM_BOT_TOKEN:'telegram'};

test('go-live readiness accepts configured operational data',async()=>{
  const result=await assessProductionReadiness(pool(ready),{env});
  assert.equal(result.ok,true);assert.deepEqual(result.blockers,[]);
});

test('go-live readiness reports every missing launch dependency',async()=>{
  const result=await assessProductionReadiness(pool({branches:[{id:1,code:'KST',managers:0,engineers:0}],roles:[{role:'OWNER',count:1}],accounts:[],orphaned:2}),{env:{}});
  assert.equal(result.ok,false);
  assert.match(result.blockers.join('\n'),/ACCOUNTANT/);
  assert.match(result.blockers.join('\n'),/менеджер/);
  assert.match(result.blockers.join('\n'),/инженер/);
  assert.match(result.blockers.join('\n'),/CASH/);
  assert.match(result.blockers.join('\n'),/BANK\/CARD/);
  assert.match(result.blockers.join('\n'),/2 активных сотрудников/);
  assert.match(result.blockers.join('\n'),/WhatsApp/);
  assert.equal(result.warnings.length,2);
});

test('required operational roles can be adjusted for the real company model',async()=>{
  const minimal={...ready,roles:[{role:'OWNER',count:1},{role:'MANAGER',count:1},{role:'ENGINEER',count:1}]};
  const result=await assessProductionReadiness(pool(minimal),{env:{...env,GO_LIVE_REQUIRED_ROLES:'OWNER,MANAGER,ENGINEER'}});
  assert.equal(result.ok,true);
});
