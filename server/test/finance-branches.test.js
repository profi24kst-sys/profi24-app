import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {buildFinanceApp} from '../src/finance/app.js';

async function setup(){
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  const pool={query,connect:async()=>({query,release(){}}),end:async()=>{}};
  await migrateCore(pool);
  const owner=(await query("INSERT INTO users(name,email,password_hash,role) VALUES('Finance Owner','finance-owner@test.invalid','unused','OWNER') RETURNING id")).rows[0];
  const accountant=(await query("INSERT INTO users(name,email,password_hash,role) VALUES('Finance Accountant','finance-accountant@test.invalid','unused','ACCOUNTANT') RETURNING id")).rows[0];
  const manager=(await query("INSERT INTO users(name,email,password_hash,role) VALUES('Finance Manager','finance-manager@test.invalid','unused','MANAGER') RETURNING id,primary_branch_id")).rows[0];
  const app=await buildFinanceApp(pool,{logger:false,secret:'finance-branches-test-secret'});await app.ready();
  let seq=0;
  const token=id=>app.jwt.sign({id});
  const api=async(method,url,payload,user=owner.id)=>{
    const res=await app.inject({method,url,payload,headers:{authorization:'Bearer '+token(user),'idempotency-key':'finance-branch-'+String(++seq).padStart(8,'0')}});
    return {status:res.statusCode,...res.json()};
  };
  return {db,query,pool,app,api,owner,accountant,manager,close:async()=>{await app.close();await db.close();}};
}

test('денежный счёт требует явный филиал при multi-branch и проверяет ответственного',async()=>{
  const s=await setup();
  try{
    const kst=(await s.query("SELECT id FROM branches WHERE code='KST'")).rows[0].id;
    const second=(await s.query("INSERT INTO branches(code,name,address) VALUES('FIN2','Финансовый филиал 2','Адрес 2') RETURNING id")).rows[0].id;

    const missing=await s.api('POST','/api/v1/accounts',{name:'Без филиала',type:'CASH',initial_amount:0});
    assert.equal(missing.status,422);
    assert.equal(missing.error?.code,'BRANCH_REQUIRED');

    const kstAccount=await s.api('POST','/api/v1/accounts',{name:'Касса Костанай',type:'CASH',branch_id:kst,responsible_id:s.manager.id,initial_amount:0});
    assert.equal(kstAccount.status,201,JSON.stringify(kstAccount));
    assert.equal(Number(kstAccount.data.branch_id),Number(kst));

    const mismatch=await s.api('POST','/api/v1/accounts',{name:'Чужая касса',type:'CASH',branch_id:second,responsible_id:s.manager.id,initial_amount:0});
    assert.equal(mismatch.status,422);
    assert.equal(mismatch.error?.code,'RESPONSIBLE_BRANCH_MISMATCH');

    await s.query('INSERT INTO user_branches(user_id,branch_id,is_primary) VALUES($1,$2,false)',[s.manager.id,second]);
    const secondAccount=await s.api('POST','/api/v1/accounts',{name:'Касса филиала 2',type:'CASH',branch_id:second,responsible_id:s.manager.id,initial_amount:0},s.accountant.id);
    assert.equal(secondAccount.status,201,JSON.stringify(secondAccount));

    const accounts=await s.api('GET','/api/v1/accounts',undefined,s.accountant.id);
    assert.equal(accounts.status,200);
    const secondRow=accounts.data.find(x=>x.id===secondAccount.data.id);
    assert.equal(Number(secondRow.branch_id),Number(second));
    assert.equal(secondRow.branch_name,'Финансовый филиал 2');
  }finally{await s.close();}
});
