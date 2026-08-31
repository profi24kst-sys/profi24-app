// PROFI24 unified order workflow — status action menu on the single order header.
(function(){
  const API='/api/v1';
  const token=()=>localStorage.token||'';
  const user=()=>{try{return JSON.parse(localStorage.user||'null')}catch{return null}};
  async function api(path,opt={}){const r=await fetch(API+path,{...opt,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token()}`,...(opt.headers||{})}});let j={};try{j=await r.json()}catch{}if(!r.ok)throw new Error(j?.error?.message||`Ошибка ${r.status}`);return j.data}
  function orderNumber(){return document.querySelector('.ordertitle h2')?.textContent?.replace(/^Заказ\s+/,'').trim()||''}
  async function loadOrder(){const n=orderNumber();if(!n)return null;const list=await api('/requests');const row=(list||[]).find(x=>x.number===n);return row?api('/requests/'+row.id):null}
  function tab(name){[...document.querySelectorAll('.ordertabs button')].find(x=>x.textContent.includes(name))?.click()}
  function nav(name){[...document.querySelectorAll('.shell>aside nav button')].find(x=>!x.hidden&&x.textContent.includes(name))?.click()}
  function nativeMain(){if(window.Profi24OrderWorkspace?.showNative){window.Profi24OrderWorkspace.showNative()}else{tab('Основное');document.querySelector('main')?.classList.remove('hcOverviewActive')}}
  function focusCard(name){nativeMain();setTimeout(()=>{const h=[...document.querySelectorAll('.cardhead')].find(x=>x.textContent.includes(name));const card=h?.closest('.card');card?.scrollIntoView({behavior:'smooth',block:'center'});card?.querySelector('textarea,input,select')?.focus()},120)}
  function pop(anchor,items){document.querySelector('.hcWorkflowPop')?.remove();const p=document.createElement('div');p.className='hcWorkflowPop';for(const item of items){const b=document.createElement('button');b.type='button';b.textContent=item.label;b.disabled=!!item.disabled;if(item.hint)b.dataset.hint=item.hint;b.onclick=async()=>{p.remove();try{await item.run?.()}catch(e){alert(e.message)}};p.appendChild(b)}document.body.appendChild(p);const r=anchor.getBoundingClientRect();p.style.left=Math.max(10,Math.min(window.innerWidth-p.offsetWidth-10,r.left))+'px';p.style.top=Math.min(window.innerHeight-p.offsetHeight-10,r.bottom+6)+'px';setTimeout(()=>document.addEventListener('click',function close(e){if(!p.contains(e.target)&&e.target!==anchor){p.remove();document.removeEventListener('click',close)}},true),0)}
  async function next(anchor){const r=await loadOrder();if(!r)return;const role=user()?.role;const items=[];
    if(r.status==='NEW')items.push({label:'Назначить инженера и время',run:()=>{nativeMain();setTimeout(()=>document.querySelector('.sidecol')?.scrollIntoView({behavior:'smooth',block:'start'}),80)}});
    else if(r.status==='ASSIGNED'){if(role==='ENGINEER')items.push({label:'Принять заказ',run:async()=>{await api('/requests/'+r.id+'/accept',{method:'POST',body:'{}'});await window.Profi24OrderWorkspace?.refresh?.()}});else items.push({label:'Изменить назначение',run:()=>{nativeMain();setTimeout(()=>document.querySelector('.sidecol')?.scrollIntoView({behavior:'smooth',block:'start'}),80)}});if(!r.scheduled_at)items.push({label:'⚠ Не указано время выезда',disabled:true})}
    else if(r.status==='ACCEPTED'||r.status==='DIAGNOSTICS')items.push({label:'Заполнить диагностику',run:()=>focusCard('Диагностика')});
    else if(r.status==='APPROVAL_REQUIRED'){items.push({label:'Открыть согласование',run:()=>nav('Согласования')});items.push({label:'Работы и стоимость',run:()=>tab('Работы')})}
    else if(r.status==='WAITING_PART')items.push({label:'Открыть запчасти',run:()=>tab('Запчасти')});
    else if(r.status==='REPAIR'||r.status==='TESTING')items.push({label:'Контроль после ремонта',run:()=>focusCard('Контроль после ремонта')});
    else if(r.status==='PAYMENT_REQUIRED')items.push({label:'Перейти к оплате',run:()=>tab('Оплаты')});
    else if(r.status==='CLOSED')items.push({label:'Документы',run:()=>tab('Документы')});
    else items.push({label:'История заказа',run:()=>tab('История')});
    if(!items.some(x=>x.label==='История заказа'))items.push({label:'История заказа',run:()=>tab('История')});
    pop(anchor,items)
  }
  function bind(){const s=document.querySelector('main.hcOrderMode .ordertitle .pill');if(!s||s.dataset.workflowBound)return;s.dataset.workflowBound='1';s.setAttribute('title','Нажмите для следующего действия');s.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();next(s)});const arrow=document.createElement('span');arrow.className='hcStatusArrow';arrow.textContent='▾';s.appendChild(arrow)}
  const obs=new MutationObserver(()=>requestAnimationFrame(bind));function start(){obs.observe(document.body,{childList:true,subtree:true});bind()}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();
