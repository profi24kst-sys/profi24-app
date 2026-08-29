// PROFI24 Core UI v1.2.2 — stable central navigation registry with delegated clicks.
(function(){
  const groups={
    work:{title:'Работа',order:10,items:['Заказы','Заказ 360','Диспетчерская','Диспетчер','Диагностика','Завершение ремонта','Ожидание запчастей']},
    service:{title:'Сервис',order:20,items:['Клиенты','Техника','Согласования','Коммуникации','Уведомления','Рекламации','Задачи']},
    stock:{title:'Склад',order:30,items:['Склад','Закупки','Прайс работ']},
    team:{title:'Команда',order:40,items:['Сотрудники','Зарплата','Зарплаты','Мастер','Эффективность','Мои KPI']},
    finance:{title:'Финансы',order:50,items:['Финансы','Прибыль заказов','Маржа']},
    analytics:{title:'Аналитика',order:60,items:['Аналитика','Отчеты','Пульт управления','Надёжность']}
  };
  const state={nav:null,observer:null,scheduled:false,registry:new Map(),seq:0,rebuilding:false,clickHandler:null};
  const textOf=b=>(b?.querySelector('span')?.textContent||b?.textContent||'').trim().replace(/\s+\d+$/,'');
  const groupFor=label=>Object.entries(groups).find(([,g])=>g.items.includes(label))?.[0]||'analytics';
  function section(nav,key){let s=nav.querySelector(`[data-core-group="${key}"]`);if(s)return s;s=document.createElement('section');s.dataset.coreGroup=key;s.className='coreNavGroup';const h=document.createElement('div');h.className='coreNavGroupTitle';h.textContent=groups[key].title;const body=document.createElement('div');body.className='coreNavGroupBody';s.append(h,body);return s}
  function samePlace(node,parent,index){return node.parentElement===parent&&parent.children[index]===node}
  function place(node,parent,index){if(!samePlace(node,parent,index))parent.insertBefore(node,parent.children[index]||null)}
  function removeDuplicateLegacy(label,except){const nav=state.nav;if(!nav)return;[...nav.querySelectorAll('button')].forEach(b=>{if(b===except)return;if(textOf(b)===label&&!b.dataset.coreNavId){const wrap=b.parentElement;if(wrap&&wrap.parentElement===nav&&wrap.tagName==='DIV')wrap.remove();else b.remove()}})}
  function mountRegistered(item){const nav=state.nav;if(!nav)return;let b=nav.querySelector(`[data-core-nav-id="${item.id}"]`);if(!b){b=document.createElement('button');b.type='button';b.dataset.coreNavId=item.id;b.dataset.coreManaged='1';b.dataset.coreLabel=item.label;const span=document.createElement('span');b.appendChild(span)}b.disabled=false;b.style.pointerEvents='auto';b.querySelector('span').textContent=item.label;const old=b.querySelector('b');if(item.badge===undefined||item.badge===null||item.badge==='')old?.remove();else if(old)old.textContent=String(item.badge);else{const badge=document.createElement('b');badge.textContent=String(item.badge);b.appendChild(badge)}const key=groups[item.group]?item.group:groupFor(item.label),sec=section(nav,key),body=sec.querySelector('.coreNavGroupBody');if(!sec.isConnected)nav.appendChild(sec);if(b.parentElement!==body)body.appendChild(b);removeDuplicateLegacy(item.label,b)}
  function reorderBody(body,key){const preferred=groups[key].items;const ordered=[...body.children].sort((a,b)=>{const ai=preferred.indexOf(textOf(a)),bi=preferred.indexOf(textOf(b));return(ai<0?999:ai)-(bi<0?999:bi)});ordered.forEach((node,i)=>place(node,body,i))}
  function reconnectObserver(){if(!state.nav||!state.observer)return;state.observer.observe(state.nav,{childList:true,subtree:true})}
  function rebuild(){state.scheduled=false;const nav=document.querySelector('.shell>aside nav');if(!nav||state.rebuilding)return;state.rebuilding=true;if(state.nav!==nav)state.nav=nav;state.observer?.disconnect();try{state.registry.forEach(mountRegistered);const buttons=[...nav.querySelectorAll(':scope > button,:scope > div > button,:scope > section:not(.coreNavGroup) button')];const buckets={};Object.keys(groups).forEach(k=>buckets[k]=[]);buttons.forEach((b,i)=>{if(b.dataset.coreNavId)return;const label=textOf(b);if([...state.registry.values()].some(x=>x.label===label)){b.remove();return}b.dataset.coreManaged='legacy';b.dataset.coreLabel=label;b.dataset.coreSeq=String(i);buckets[groupFor(label)].push(b)});Object.entries(groups).sort((a,b)=>a[1].order-b[1].order).forEach(([key])=>{const sec=section(nav,key),body=sec.querySelector('.coreNavGroupBody');if(!sec.isConnected)nav.appendChild(sec);buckets[key].forEach(b=>{if(b.parentElement!==body)body.appendChild(b)});reorderBody(body,key)});[...nav.querySelectorAll('.coreNavGroup')].forEach(s=>s.hidden=!s.querySelector('button'))}finally{state.rebuilding=false;reconnectObserver()}}
  function schedule(){if(state.scheduled||state.rebuilding)return;state.scheduled=true;requestAnimationFrame(rebuild)}
  function attachClicks(nav){if(state.clickHandler&&state.nav)state.nav.removeEventListener('click',state.clickHandler,true);state.clickHandler=e=>{const b=e.target.closest?.('button[data-core-nav-id]');if(!b||!nav.contains(b))return;const item=state.registry.get(b.dataset.coreNavId);if(!item?.onClick)return;e.stopPropagation();item.onClick()};nav.addEventListener('click',state.clickHandler,true)}
  function bindNav(){const nav=document.querySelector('.shell>aside nav');if(!nav){setTimeout(bindNav,150);return}if(state.nav!==nav||!state.observer){state.observer?.disconnect();state.nav=nav;state.observer=new MutationObserver(()=>schedule());reconnectObserver();attachClicks(nav)}schedule();window.dispatchEvent(new CustomEvent('profi24:core-ui-ready'))}
  const api={
    registerNav(cfg){if(!cfg?.id||!cfg?.label)return()=>{};const item={group:groupFor(cfg.label),order:++state.seq,...cfg};state.registry.set(item.id,item);bindNav();schedule();return()=>{state.registry.delete(item.id);document.querySelector(`[data-core-nav-id="${item.id}"]`)?.remove();schedule()}},
    updateNav(id,patch={}){const x=state.registry.get(id);if(!x)return false;Object.assign(x,patch);schedule();return true},
    unregisterNav(id){state.registry.delete(id);document.querySelector(`[data-core-nav-id="${id}"]`)?.remove();schedule()},
    refresh(){bindNav();schedule()},
    getRegistry(){return [...state.registry.values()].map(x=>({...x,onClick:undefined}))},
    version:'1.2.2'
  };
  window.Profi24UI=api;if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bindNav);else bindNav();window.addEventListener('storage',e=>{if(e.key==='user')setTimeout(bindNav,100)});window.addEventListener('profi24:ui-refresh',bindNav);
})();