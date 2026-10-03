const PREFIX='profi24:order-draft:v1:',TTL=7*86400000,MAX_CHARS=65536;
export const draftFields=Object.freeze({
 diagnostic:['symptoms','diagnosis','recommendation'],
 diagnosis:['diagnosis'],
 completion:['repair_result','test_result'],
 work:['name','qty','unit_price','direct_cost','performed_by'],
 mobile_work:['name','price']
});
export const draftUser=()=>{try{const u=JSON.parse(localStorage.getItem('user')||'null');return Number.isSafeInteger(Number(u?.id))&&Number(u.id)>0?Number(u.id):null}catch{return null}};
export const draftSession=()=>{try{const u=JSON.parse(localStorage.getItem('user')||'null');return u?String(u.id)+'|'+u.role+'|'+Boolean(localStorage.getItem('token')):''}catch{return ''}};
export function normalizeDraft(section,value={}){
 if(!draftFields[section])throw Error('Unknown draft section');
 return Object.fromEntries(draftFields[section].map(field=>[field,String(value[field]??'')]));
}
export const equalDraft=(section,a,b)=>JSON.stringify(normalizeDraft(section,a))===JSON.stringify(normalizeDraft(section,b));
function key(scope){
 if(!scope||!Number.isSafeInteger(Number(scope.userId))||Number(scope.userId)<=0||!Number.isSafeInteger(Number(scope.orderId))||Number(scope.orderId)<=0||!draftFields[scope.section])return null;
 return PREFIX+Number(scope.userId)+':'+Number(scope.orderId)+':'+scope.section;
}
export function readDraft(storage,scope,now=Date.now()){
 const k=key(scope);if(!k)return null;
 const raw=storage.getItem(k);if(!raw)return null;
 let record;try{record=JSON.parse(raw)}catch{storage.removeItem(k);return null}
 if(!record||typeof record!=='object'||Array.isArray(record)||record.version!==1||record.updatedAt>now||now-record.updatedAt>TTL||!Number.isFinite(record.updatedAt)||!record.values||typeof record.values!=='object'||Array.isArray(record.values)||!record.baseline||typeof record.baseline!=='object'||Array.isArray(record.baseline)||JSON.stringify(record).length>MAX_CHARS){storage.removeItem(k);return null}
 return {...record,values:normalizeDraft(scope.section,record.values),baseline:normalizeDraft(scope.section,record.baseline)};
}
export function writeDraft(storage,scope,baseline,values,now=Date.now()){
 const k=key(scope);if(!k)return false;
 if(equalDraft(scope.section,baseline,values)){storage.removeItem(k);return false}
 const text=JSON.stringify({version:1,baseline:normalizeDraft(scope.section,baseline),values:normalizeDraft(scope.section,values),updatedAt:now});
 if(text.length>MAX_CHARS)throw Error('Draft too large');
 storage.setItem(k,text);return true;
}
export function clearDraft(storage,scope,submitted){
 const k=key(scope);if(!k)return false;
 if(submitted!==undefined){const record=readDraft(storage,scope);if(record&&!equalDraft(scope.section,record.values,submitted))return false}
 storage.removeItem(k);return true;
}
