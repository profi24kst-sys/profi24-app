const roles=new Set(['OWNER','SUPERVISOR','MANAGER']);
const currentUser=()=>{try{return JSON.parse(localStorage.getItem('user')||'null')}catch{return null}};
const auth=()=>localStorage.getItem('token')||'';
const headers=()=>({Authorization:`Bearer ${auth()}`});
const formatExpiry=value=>value?new Date(value).toLocaleString('ru-RU'):'';

async function json(url,opt={}){
 const r=await fetch(url,{...opt,headers:{...headers(),...(opt.headers||{})}});
 const j=await r.json().catch(()=>({}));
 if(!r.ok)throw new Error(j.error?.message||'Не удалось выполнить действие');
 return j.data;
}

function renderState(action,revoke,state){
 const active=Boolean(state?.active);
 action.dataset.portalActive=active?'true':'false';
 action.dataset.linkId=state?.id?String(state.id):'';
 action.textContent=active?'Кабинет активен':'Кабинет клиента';
 action.title=active?`Активная ссылка до ${formatExpiry(state.expires_at)}. Нажмите, чтобы выпустить новую.`:'Создать персональную ссылку на историю ремонтов';
 revoke.hidden=!active;
 revoke.style.display=active?'':'none';
 revoke.setAttribute('aria-hidden',active?'false':'true');
 revoke.dataset.linkId=state?.id?String(state.id):'';
 revoke.title=active?`Отозвать ссылку, действующую до ${formatExpiry(state.expires_at)}`:'';
}

async function refresh(action,revoke,id){
 try{
  const state=await json(`/approvals-api/api/v1/customer-portal/requests/${id}/link`);
  renderState(action,revoke,state);
 }catch(error){
  action.dataset.portalActive='false';
  action.textContent='Кабинет клиента';
  action.title=error.message;
  revoke.hidden=true;
  revoke.style.display='none';
  revoke.setAttribute('aria-hidden','true');
 }
}

async function createLink(action,revoke,id){
 if(action.dataset.portalActive==='true'&&!window.confirm('У клиента уже есть активная ссылка. Выпустить новую? Предыдущая ссылка будет отозвана.'))return;
 const original=action.textContent;action.disabled=true;revoke.disabled=true;action.textContent='Создаём…';
 try{
  const data=await json('/approvals-api/api/v1/customer-portal/links',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source_request_id:id,expires_days:30,send:true})});
  const url=location.origin+data.url;
  try{await navigator.clipboard.writeText(url)}catch{}
  window.prompt(data.message_queued?'Ссылка создана и добавлена в очередь WhatsApp. Также она скопирована:':'Ссылка создана. Скопируйте её клиенту:',url);
 }catch(error){alert(error.message)}
 finally{action.disabled=false;revoke.disabled=false;action.textContent=original;await refresh(action,revoke,id)}
}

async function revokeLink(action,revoke,id){
 const linkId=Number(action.dataset.linkId||revoke.dataset.linkId);if(!Number.isSafeInteger(linkId)||linkId<1)return;
 if(!window.confirm('Отозвать доступ клиента к кабинету? Открытая у клиента ссылка перестанет работать.'))return;
 action.disabled=true;revoke.disabled=true;revoke.textContent='Отзываем…';
 try{await json(`/approvals-api/api/v1/customer-portal/links/${linkId}/revoke`,{method:'POST'})}
 catch(error){alert(error.message)}
 finally{action.disabled=false;revoke.disabled=false;revoke.textContent='Отозвать';await refresh(action,revoke,id)}
}

function mount(){
 const user=currentUser();if(!roles.has(user?.role))return;
 const root=document.querySelector('.o360[data-current-request-id]'),top=root?.querySelector('.o360Top');if(!root||!top)return;
 const id=Number(root.dataset.currentRequestId);if(!Number.isSafeInteger(id)||id<1)return;
 const existing=top.querySelector('[data-customer-portal-action]');
 if(existing&&Number(existing.dataset.requestId)===id)return;
 top.querySelector('[data-customer-portal-action]')?.remove();
 top.querySelector('[data-customer-portal-revoke]')?.remove();

 const action=document.createElement('button');action.type='button';action.dataset.customerPortalAction='true';action.dataset.requestId=String(id);action.textContent='Кабинет клиента';
 const revoke=document.createElement('button');revoke.type='button';revoke.dataset.customerPortalRevoke='true';revoke.dataset.requestId=String(id);revoke.textContent='Отозвать';revoke.hidden=true;revoke.style.display='none';revoke.setAttribute('aria-hidden','true');
 action.addEventListener('click',()=>createLink(action,revoke,id));
 revoke.addEventListener('click',()=>revokeLink(action,revoke,id));
 const close=top.querySelector('[aria-label="Закрыть Заказ 360"]')||null;
 top.insertBefore(action,close);top.insertBefore(revoke,close);
 refresh(action,revoke,id);
}

window.addEventListener('profi24:o360-current',()=>setTimeout(mount,0));
new MutationObserver(()=>mount()).observe(document.documentElement,{subtree:true,childList:true});
