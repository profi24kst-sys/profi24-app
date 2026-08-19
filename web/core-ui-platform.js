// PROFI24 Core UI v1.1 — central navigation registry with legacy migration bridge.
(function(){
  const groups={
    work:{title:'Работа',order:10,items:['Заказы','Заказ 360','Диспетчер','Диагностика','Завершение ремонта','Ожидание запчастей']},
    clients:{title:'Клиенты',order:20,items:['Клиенты','Техника','Согласования','Коммуникации','Уведомления']},
    stock:{title:'Склад и снабжение',order:30,items:['Склад','Закупки','Прайс работ']},
    team:{title:'Команда',order:40,items:['Сотрудники','Зарплата','Мастер','Эффективность','Мои KPI','Задачи']},
    management:{title:'Управление',order:50,items:['Пульт управления','Финансы','Прибыль заказов','Маржа','Отчеты','Рекламации','Надёжность']}
  };
  const state={nav:null,observer:null,scheduled:false,registry:new Map(),seq:0};
  const textOf=b=>(b?.querySelector('span')?.textContent||b?.textContent||'').trim().replace(/\s+\d+$/,'');
  const groupFor=label=>Object.entries(groups).find(([,g])=>g.items.includes(label))?.[0]||'management';
  function section(nav,key){let s=nav.querySelector(`[data-core-group="${key}"]`);if(s)return s;s=document.createElement('section');s.dataset.coreGroup=key;s.className='coreNavGroup';const h=document.createElement('div');h.className='coreNavGroupTitle';h.textContent=groups[key].title;const body=document.createElement('div');body.className='coreNavGroupBody';s.append(h,body);return s}
  function removeDuplicateLegacy(label,except){const nav=state.nav||document.querySelector('.shell>aside nav');if(!nav)return;[...nav.querySelectorAll('button')].forEach(b=>{if(b===except)return;if(textOf(b)===label&&!b.dataset.coreNavId)b.closest('div')?.remove?.()||b.remove()})}
  function mountRegistered(item){const nav=document.querySelector('.shell>aside nav');if(!nav)return false;let b=nav.querySelector(`[data-core-nav-id="${item.id}"]`);if(!b){b=document.createElement('button');b.type='button';b.dataset.coreNavId=item.id;b.dataset.coreManaged='1';b.dataset.coreLabel=item.label;b.addEventListener('click',()=>item.onClick?.());const span=document.createElement('span');span.textContent=item.label;b.appendChild(span);if(item.badge!==undefined&&item.badge!==null&&item.badge!==''){const badge=document.createElement('b');badge.textContent=String(item.badge);b.appendChild(badge)}let sec=section(nav,groups[item.group]?item.group:'management'),body=sec.querySelector('.coreNavGroupBody');if(!sec.isConnected)nav.appendChild(sec);body.appendChild(b)}removeDuplicateLegacy(item.label,b);return true}
  function rebuild(){state.scheduled=false;const nav=document.querySelector('.shell>aside nav');if(!nav)return;state.nav=nav;state.registry.forEach(mountRegistered);const buttons=[...nav.querySelectorAll(':scope > button,:scope > div > button,:scope > section:not(.coreNavGroup) button')];const buckets={};Object.keys(groups).forEach(k=>buckets[k]=[]);buttons.forEach((b,i)=>{if(b.dataset.coreManaged==='1')return;const label=textOf(b);if([...state.registry.values()].some(x=>x.label===label)){b.closest('div')?.remove?.()||b.remove();return}b.dataset.coreManaged='1';b.dataset.coreLabel=label;b.dataset.coreSeq=String(i);buckets[groupFor(label)].push(b)});Object.entries(groups).sort((a,b)=>a[1].order-b[1].order).forEach(([key])=>{let sec=section(nav,key),body=sec.querySelector('.coreNavGroupBody');if(!sec.isConnected)nav.appendChild(sec);buckets[key].forEach(b=>body.appendChild(b))});[...nav.querySelectorAll('.coreNavGroup')].forEach(s=>s.hidden=!s.querySelector('button'))}
  function schedule(){if(state.scheduled)return;state.scheduled=true;requestAnimationFrame(rebuild)}
  function start(){const nav=document.querySelector('.shell>aside nav');if(!nav){setTimeout(start,200);return}state.nav=nav;state.observer?.disconnect();state.observer=new MutationObserver(schedule);state.observer.observe(nav,{childList:true,subtree:true});schedule();window.dispatchEvent(new CustomEvent('profi24:core-ui-ready'))}
  const api={
    registerNav(cfg){if(!cfg?.id||!cfg?.label)return()=>{};const item={group:'management',order:++state.seq,...cfg};state.registry.set(item.id,item);schedule();return()=>{state.registry.delete(item.id);document.querySelector(`[data-core-nav-id="${item.id}"]`)?.remove();schedule()}},
    updateNav(id,patch={}){const x=state.registry.get(id);if(!x)return false;Object.assign(x,patch);const b=document.querySelector(`[data-core-nav-id="${id}"]`);if(b){b.dataset.coreLabel=x.label;b.querySelector('span').textContent=x.label;const old=b.querySelector('b');if(x.badge===undefined||x.badge===null||x.badge==='')old?.remove();else if(old)old.textContent=String(x.badge);else{const z=document.createElement('b');z.textContent=String(x.badge);b.appendChild(z)}}schedule();return true},
    unregisterNav(id){state.registry.delete(id);document.querySelector(`[data-core-nav-id="${id}"]`)?.remove();schedule()},
    refresh:schedule,
    getRegistry(){return [...state.registry.values()].map(x=>({...x,onClick:undefined}))},
    version:'1.1.0'
  };
  window.Profi24UI=api;if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();window.addEventListener('storage',e=>{if(e.key==='user')setTimeout(start,100)});
})();