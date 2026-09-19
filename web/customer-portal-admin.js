const roles=new Set(['OWNER','SUPERVISOR','MANAGER']);
const currentUser=()=>{try{return JSON.parse(localStorage.getItem('user')||'null')}catch{return null}};
const auth=()=>localStorage.getItem('token')||'';

async function createLink(button,id){
 const original=button.textContent;button.disabled=true;button.textContent='Создаём…';
 try{
  const r=await fetch('/approvals-api/api/v1/customer-portal/links',{method:'POST',headers:{Authorization:`Bearer ${auth()}`,'Content-Type':'application/json'},body:JSON.stringify({source_request_id:id,expires_days:30,send:true})});
  const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error?.message||'Не удалось создать кабинет');
  const url=location.origin+j.data.url;
  try{await navigator.clipboard.writeText(url)}catch{}
  window.prompt(j.data.message_queued?'Ссылка создана и добавлена в очередь WhatsApp. Также она скопирована:':'Ссылка создана. Скопируйте её клиенту:',url);
 }catch(error){alert(error.message)}finally{button.disabled=false;button.textContent=original}
}

function mount(){
 const user=currentUser();if(!roles.has(user?.role))return;
 const root=document.querySelector('.o360[data-current-request-id]'),top=root?.querySelector('.o360Top');if(!root||!top)return;
 const id=Number(root.dataset.currentRequestId);if(!Number.isSafeInteger(id)||id<1)return;
 const existing=top.querySelector('[data-customer-portal-action]');
 if(existing&&Number(existing.dataset.requestId)===id)return;
 if(existing)existing.remove();
 const button=document.createElement('button');button.type='button';button.dataset.customerPortalAction='true';button.dataset.requestId=String(id);button.title='Создать персональную ссылку на историю ремонтов';button.textContent='Кабинет клиента';button.addEventListener('click',()=>createLink(button,id));
 top.insertBefore(button,top.querySelector('[aria-label="Закрыть Заказ 360"]')||null);
}

window.addEventListener('profi24:o360-current',()=>setTimeout(mount,0));
new MutationObserver(()=>mount()).observe(document.documentElement,{subtree:true,childList:true});
