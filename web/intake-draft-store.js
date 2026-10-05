const PREFIX='profi24:intake-draft:v1:',TTL=7*86400000,MAX=131072;
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export const emptyIntake=()=>({cid:'',eid:'',cust:{name:'',phone:'',address:''},dev:{category:'Холодильник',brand:'',model:'',serial_number:''},form:{complaint:'',source:'OTHER',priority:'NORMAL',scheduled_at:'',engineer_id:'',visit_type:'FIELD',manager_comment:''},orderType:'REPAIR',extraValues:{},selectedCustomer:null});
function key(scope){return scope&&Number.isSafeInteger(scope.userId)&&scope.userId>0&&['OWNER','MANAGER','SUPERVISOR'].includes(scope.role)?PREFIX+scope.userId+':'+scope.role:null}
export function normalizeIntake(value){
 const next=emptyIntake();if(!plain(value))return next;
 for(const group of ['cust','dev','form'])for(const field of Object.keys(next[group]))if(typeof value[group]?.[field]==='string')next[group][field]=value[group][field];
 for(const field of ['cid','eid'])if(/^\d+$/.test(String(value[field]||'')))next[field]=String(value[field]);
 if(['REPAIR','FIELD','PAID_WORKSHOP'].includes(value.orderType))next.orderType=value.orderType;
 if(plain(value.extraValues))next.extraValues=Object.fromEntries(Object.entries(value.extraValues).filter(([k,v])=>/^[a-z][a-z0-9_]{1,49}$/.test(k)&&['string','number'].includes(typeof v)));
 if(next.cid&&plain(value.selectedCustomer)&&String(value.selectedCustomer.id)===next.cid)next.selectedCustomer={id:Number(next.cid),...Object.fromEntries(['name','phone','address'].map(k=>[k,String(value.selectedCustomer[k]||'')]))};
 if(!next.cid)next.eid='';return next;
}
function pendingOperation(value){
 if(value==null)return null;
 if(!plain(value)||typeof value.key!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.key)||!plain(value.body)||!plain(value.body.order))throw Error('Повреждён ключ незавершённого сохранения. Не создавайте повторный заказ до проверки списка заказов.');
 return {key:value.key,body:value.body};
}
export function readIntake(storage,scope,now=Date.now()){
 const k=key(scope);if(!k)return null;
 const raw=storage.getItem(k);if(!raw)return null;
 let record;try{record=JSON.parse(raw)}catch{throw Error('Не удалось прочитать черновик приёма. Проверьте список заказов перед повторным созданием.')}
 if(record.version!==1||raw.length>MAX||!Number.isFinite(record.updatedAt)||record.updatedAt>now||!plain(record.values))throw Error('Не удалось прочитать черновик приёма');
 const pending=pendingOperation(record.pending);
 // An uncertain write never expires: losing its key would make a retry unsafe.
 if(!pending&&now-record.updatedAt>TTL){storage.removeItem(k);return null}
 return {values:normalizeIntake(record.values),pending,updatedAt:record.updatedAt};
}
export function writeIntake(storage,scope,values,pending=null,now=Date.now(),resolvedKey=null){
 const k=key(scope);if(!k)throw Error('Не удалось определить владельца черновика');
 const clean=normalizeIntake(values),operation=pendingOperation(pending);
 const previous=readIntake(storage,scope,now);
 if(previous?.pending&&previous.pending.key!==operation?.key&&previous.pending.key!==resolvedKey)throw Error('В другой вкладке есть незавершённое сохранение. Закройте и откройте форму для проверки результата.');
 if(!operation&&JSON.stringify(clean)===JSON.stringify(emptyIntake())){storage.removeItem(k);return}
 const raw=JSON.stringify({version:1,updatedAt:now,values:clean,pending:operation});
 if(raw.length>MAX)throw Error('Черновик слишком большой');storage.setItem(k,raw);
}
export function clearIntake(storage,scope,confirmedKey=null,now=Date.now()){const k=key(scope);if(!k)return;const previous=readIntake(storage,scope,now);if(previous?.pending&&previous.pending.key!==confirmedKey)throw Error('Сначала подтвердите незавершённое сохранение');storage.removeItem(k)}
export function clearSessionKeepingIntake(storage){
 const keys=Array.from({length:storage.length},(_,i)=>storage.key(i));
 for(const k of keys)if(k&&!k.startsWith(PREFIX))storage.removeItem(k);
}
