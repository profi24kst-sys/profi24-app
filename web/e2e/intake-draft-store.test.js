import {test} from 'node:test';
import assert from 'node:assert/strict';
import {emptyIntake,normalizeIntake,readIntake,writeIntake,clearIntake,clearSessionKeepingIntake} from '../intake-draft-store.js';
const scope={userId:41,role:'MANAGER'},now=1800000000000,key='9191519f-63b4-440d-ae4c-9494d4c71bff';
const storage=()=>{const entries=new Map();return{getItem:k=>entries.get(k)||null,setItem:(k,v)=>entries.set(k,v),removeItem:k=>entries.delete(k),get length(){return entries.size},key:i=>[...entries.keys()][i]||null,entries}};
test('intake draft survives reopen and is isolated by account and role',()=>{
 const s=storage(),value=emptyIntake();value.cust.name='Synthetic';value.extraValues={custom:'Saved'};writeIntake(s,scope,value,null,now);
 assert.deepEqual(readIntake(s,scope,now).values,value);assert.equal(readIntake(s,{...scope,userId:42},now),null);assert.equal(readIntake(s,{...scope,role:'OWNER'},now),null);
 clearIntake(s,scope);assert.equal(readIntake(s,scope,now),null);
});
test('normal drafts expire while uncertain operations retain the exact key and body',()=>{
 const s=storage(),v=emptyIntake();v.form.complaint='Fixture';writeIntake(s,scope,v,null,now);assert.equal(readIntake(s,scope,now+8*86400000),null);
 const pending={key,body:{customer:{name:'Synthetic'},equipment:{category:'Fixture'},order:{complaint:'Exact immutable payload',custom_fields:{number:0}}}};
 writeIntake(s,scope,v,pending,now);assert.deepEqual(readIntake(s,scope,now+365*86400000).pending,pending);
});
test('only declared form fields persist; new customer cannot carry stale equipment',()=>{
 const v={...emptyIntake(),eid:'12',token:'secret',extraValues:{good:'text',bad:{secret:'hidden'}},form:{complaint:'Fixture',password:'secret'}};
 const clean=normalizeIntake(v);assert.equal(clean.eid,'');assert.equal(clean.token,undefined);assert.equal(clean.form.password,undefined);assert.deepEqual(clean.extraValues,{good:'text'});
});
test('corrupt uncertain operations block saving instead of silently losing their key',()=>{
 const s=storage();s.setItem('profi24:intake-draft:v1:41:MANAGER',JSON.stringify({version:1,updatedAt:now,values:emptyIntake(),pending:{key:'broken',body:{order:{}}}}));
 assert.throws(()=>readIntake(s,scope,now),/Повреждён ключ/);assert.equal(s.entries.size,1);
});
test('unavailable storage and missing account fail before submission',()=>{
 const blocked={setItem(){throw Error('quota')},getItem(){throw Error('blocked')}};
 assert.throws(()=>writeIntake(blocked,scope,emptyIntake(),{key,body:{order:{}}},now),/quota/);assert.throws(()=>readIntake(blocked,scope,now),/blocked/);
 assert.throws(()=>writeIntake(storage(),{userId:0,role:'OWNER'},emptyIntake()),/владельца/);
});
test('logout removes credentials but keeps the account-scoped recovery operation',()=>{
 const s=storage(),pending={key,body:{order:{complaint:'Fixture'}}};writeIntake(s,scope,emptyIntake(),pending,now);s.setItem('token','secret');s.setItem('user','owner');s.setItem('unrelated','cache');
 clearSessionKeepingIntake(s);assert.equal(s.getItem('token'),null);assert.equal(s.getItem('user'),null);assert.equal(s.getItem('unrelated'),null);assert.deepEqual(readIntake(s,scope,now).pending,pending);assert.equal(s.length,1);
});
