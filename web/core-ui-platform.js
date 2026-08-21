// PROFI24 Core UI v1.2 — central navigation registry.
(function(){
  const groups={
    work:{title:'Работа',order:10,items:['Заказы','Заказ 360','Диспетчерская','Диспетчер','Диагностика','Завершение ремонта','Ожидание запчастей']},
    service:{title:'Сервис',order:20,items:['Клиенты','Техника','Согласования','Коммуникации','Уведомления','Рекламации','Задачи']},
    stock:{title:'Склад',order:30,items:['Склад','Закупки','Прайс работ']},
    team:{title:'Команда',order:40,items:['Сотрудники','Зарплата','Зарплаты','Мастер','Эффективность','Мои KPI']},
    finance:{title:'Финансы',order:50,items:['Финансы','Прибыль заказов','Маржа']},
    analytics:{title:'Аналитика',order:60,items:['Аналитика','Отчеты','Пульт управления','Надёжность']}
  };
  const state={nav:null,observer:null,scheduled:false,registry:new Map(),seq:0,ready:false};
  const textOf=b=>(b?.querySelector('span')?.textContent||b?.textContent||'').trim().replace(/\s+\d+$/,'');
  const groupFor=label=>Object.entries(groups).find(([,g])=>g.items.includes(label))?.[0]||'analytics';
  function section(nav,key){let s=nav.querySelector(`[data-core-group="${key}"]`);if(s)return s;s=document.createElement('section');s.dataset.coreGroup=key;s.className='coreNavGroup';const h=document.createElement('div');h.className='coreNavGroupTitle';h.textContent=groups[key].title;const body=document.createElement('div');body.className='coreNavGroupBody';s.append(h,body);return s}
  function removeDuplicateLegacy(label,except){const nav=state.nav||document.querySelector('.shell>aside nav');if(!nav)return;[...nav.querySelectorAll('button')].forEach(b=>{if(b===except)return;if(textOf(b)===label&&!b.dataset.coreNavId){const wrap=b.parentElement;if(wrap&&wrap.parentElement===nav&&wrap.tagName==='DIV')wrap.remove();else b.remove()}})}
  function mountRegistered(item){const nav=document.querySelector('.shell>aside nav');if(!nav)return false;let b=nav.querySelector(`[data-core-nav-id="${item.id}"]`);if(!b){b=document.createElement('button');b.type='button';b.dataset.coreNavId=item.id;b.dataset.coreManaged='1';b.dataset.coreLabel=item.label;b.addEventListener('click',()=>state.registry.get(item.id)?.onClick?.());const span=document.createElement('span');span.textContent=item.label;b.appendChild(span)}else{b.querySelector('span').textContent=item.label}const old=b.querySelector('b');if(item.badge===undefined||item.badge===null||item.badge==='')old?.remove();else if(old)old.textContent=String(item.badge);else{const badge=document.createElement('b');badge.textContent=String(item.badge);b.appendChild(badge)}let sec=section(nav,groups[item.group]?item.group:groupFor(item.label)),body=sec.querySelector('.coreNavGroupBody');if(!sec.isConnected)nav.appendChild(sec);body.appendChild(b);removeDuplicateLegacy(item.label,b);return true}
  function rebuild(){state.scheduled=false;const nav=document.querySelector('.shell>aside nav');if(!nav)return;state.nav=nav;state.registry.forEach(mountRegistered);const buttons=[...nav.querySelectorAll(':scope > button,:scope > div > button,:scope > section:not(.coreNavGroup) button')];const buckets={};Object.keys(groups).forEach(k=>buckets[k]=[]);buttons.forEach((b,i)=>{if(b.dataset.coreNavId)return;const label=textOf(b);if([...state.registry.values()].some(x=>x.label===label)){b.remove();return}b.dataset.coreManaged='legacy';b.dataset.coreLabel=label;b.dataset.coreSeq=String(i);buckets[groupFor(label)].push(b)});Object.entries(groups).sort((a,b)=>a[1].order-b[1].order).forEach(([key])=>{let sec=section(nav,key),body=sec.querySelector('.coreNavGroupBody');if(!sec.isConnected)nav.appendChild(sec);buckets[key].forEach(b=>body.appendChild(b));sOrder(body,key)});[...nav.querySelectorAll('.coreNavGroup')].forEach(s=>s.hidden=!s.querySelector('button'))}
  function sOrder(body,key){const preferred=groups[key].items;[...body.children].sort((a,b)=>{const ai=preferred.indexOf(textOf(a)),bi=preferred.indexOf(textOf(b));return(ai<0?999:ai)-(bi<0?999:bi)}).forEach(x=>body.appendChild(x))}
  function schedule(){if(state.scheduled)return;state.scheduled=true;requestAnimationFrame(rebuild)}
  function bindNav(){const nav=document.querySelector('.shell>aside nav');if(!nav){setTimeout(bindNav,150);return}if(state.nav!==nav){state.observer?.disconnect();state.nav=nav;state.observer=new MutationObserver(schedule);state.observer.observe(nav,{childList:true,subtree:true})}state.ready=true;schedule();window.dispatchEvent(new CustomEvent('profi24:core-ui-ready'))}
  const api={
    registerNav(cfg){if(!cfg?.id||!cfg?.label)return()=>{};const item={group:groupFor(cfg.label),order:++state.seq,...cfg};state.registry.set(item.id,item);bindNav();schedule();return()=>{state.registry.delete(item.id);document.querySelector(`[data-core-nav-id="${item.id}"]`)?.remove();schedule()}},
    updateNav(id,patch={}){const x=state.registry.get(id);if(!x)return false;Object.assign(x,patch);schedule();return true},
    unregisterNav(id){state.registry.delete(id);document.querySelector(`[data-core-nav-id="${id}"]`)?.remove();schedule()},
    refresh(){bindNav();schedule()},
    getRegistry(){return [...state.registry.values()].map(x=>({...x,onClick:undefined}))},
    version:'1.2.0'
  };
  window.Profi24UI=api;
  // app3.jsx is a module and may render the sidebar after this classic script has executed.
  // Keep binding until the React shell exists; registered addons are retained in the registry meanwhile.
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bindNav);else bindNav();
  window.addEventListener('storage',e=>{if(e.key==='user')setTimeout(bindNav,100)});
  window.addEventListener('profi24:ui-refresh',bindNav);
})();