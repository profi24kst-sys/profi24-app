import test from 'node:test';
import assert from 'node:assert/strict';
import {writeDraft,readDraft,clearDraft,normalizeDraft} from '../order-draft-store.js';
const memory=()=>{const map=new Map();return {map,getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)}};
const scope={userId:1,orderId:12,section:'diagnosis'},now=1800000000000;
test('Draft persists text, isolates user/order/section and includes only declared fields',()=>{
 const storage=memory();assert.equal(writeDraft(storage,scope,{diagnosis:'server'},{diagnosis:'unsent',token:'secret',payment:100},now),true);
 assert.deepEqual(readDraft(storage,scope,now).values,{diagnosis:'unsent'});
 for(const changed of [{userId:2},{orderId:13},{section:'completion'}])assert.equal(readDraft(storage,{...scope,...changed},now),null);
 assert.ok(![...storage.map.values()][0].includes('secret'));
});
test('Expired and corrupt drafts are removed without affecting other forms',()=>{
 const storage=memory();writeDraft(storage,scope,{}, {diagnosis:'draft'},now);
 assert.equal(readDraft(storage,scope,now+7*86400000+1),null);assert.equal(storage.map.size,0);
 writeDraft(storage,scope,{}, {diagnosis:'draft'},now);const key=[...storage.map.keys()][0];storage.setItem(key,'{bad');assert.equal(readDraft(storage,scope,now),null);
 writeDraft(storage,scope,{}, {diagnosis:'draft'},now+1000);assert.equal(readDraft(storage,scope,now),null);
});
test('Successful save clears only the submitted revision; newer edits survive',()=>{
 const storage=memory();writeDraft(storage,scope,{}, {diagnosis:'first'});
 writeDraft(storage,scope,{}, {diagnosis:'new edit'});
 assert.equal(clearDraft(storage,scope,{diagnosis:'first'}),false);assert.equal(readDraft(storage,scope).values.diagnosis,'new edit');
 assert.equal(clearDraft(storage,scope,{diagnosis:'new edit'}),true);assert.equal(readDraft(storage,scope),null);
});
test('Returning to server text removes a draft; invalid scopes cannot write',()=>{
 const storage=memory();writeDraft(storage,scope,{diagnosis:'saved'}, {diagnosis:'changed'},now);
 assert.equal(writeDraft(storage,scope,{diagnosis:'saved'}, {diagnosis:'saved'},now),false);assert.equal(storage.map.size,0);
 for(const changed of [{userId:null},{userId:0},{orderId:-1},{section:'payment'}])assert.equal(writeDraft(storage,{...scope,...changed},{},{diagnosis:'text'},now),false);
});
test('Storage errors propagate for a visible warning; oversized text is never saved',()=>{
 const storage=memory();assert.throws(()=>writeDraft(storage,scope,{}, {diagnosis:'x'.repeat(70000)},now));assert.equal(storage.map.size,0);
 assert.throws(()=>writeDraft({...storage,setItem(){throw Error('QuotaExceededError')}},scope,{}, {diagnosis:'draft'},now),/Quota/);
 assert.deepEqual(normalizeDraft('work',{qty:1,unit_price:500}),{name:'',qty:'1',unit_price:'500',direct_cost:'',performed_by:''});
});
