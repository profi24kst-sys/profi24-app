// PROFI24 Core UI v1 — central navigation registry and legacy addon compatibility layer.
// New modules register through window.Profi24UI.registerNav(). Legacy addon buttons are
// automatically absorbed into the same grouped navigation until they are migrated.
(function(){
  const groups={
    work:{title:'Работа',order:10,items:['Заказы','Заказ 360','Диспетчер','Диагностика','Завершение ремонта','Ожидание запчастей']},
    clients:{title:'Клиенты',order:20,items:['Клиенты','Техника','Согласования','Коммуникации','Уведомления']},
    stock:{title:'Склад и снабжение',order:30,items:['Склад','Закупки','Прайс работ']},
    team:{title:'Команда',order:40,items:['Сотрудники','Зарплата','Мастер','Эффективность','Мои KPI','Задачи']},
    management:{title:'Управление',order:50,items:['Пульт управления','Финансы','Прибыль заказов','Маржа','Отчеты','Рекламации','Надёжность']}
  };
  const state={nav:null,observer:null,scheduled:false};
  const textOf=b=>(b?.querySelector('span')?.textContent||b?.textContent||'').trim().replace(/\s+\d+$/,'');
  const groupFor=label=>Object.entries(groups).find(([,g])=>g.items.includes(label))?.[0]||'management';
  function section(nav,key){let s=nav.querySelector(`[data-core-group="${key}"]`);if(s)return s;s=document.createElement('section');s.dataset.coreGroup=key;s.className='coreNavGroup';const h=document.createElement('div');h.className='coreNavGroupTitle';h.textContent=groups[key].title;const body=document.createElement('div');body.className='coreNavGroupBody';s.append(h,body);return s}
  function rebuild(){state.scheduled=false;const nav=document.querySelector('.shell>aside nav');if(!nav)return;state.nav=nav;const buttons=[...nav.querySelectorAll(':scope > button,:scope > div > button,:scope > section:not(.coreNavGroup) button')];if(!buttons.length)return;
    const buckets={};Object.keys(groups).forEach(k=>buckets[k]=[]);
    buttons.forEach((b,i)=>{if(b.dataset.coreManaged==='1')return;const label=textOf(b);b.dataset.coreManaged='1';b.dataset.coreLabel=label;b.dataset.coreSeq=String(i);buckets[groupFor(label)].push(b)});
    Object.entries(groups).sort((a,b)=>a[1].order-b[1].order).forEach(([key])=>{let sec=section(nav,key),body=sec.querySelector('.coreNavGroupBody');if(!sec.isConnected)nav.appendChild(sec);buckets[key].forEach(b=>body.appendChild(b));});
    [...nav.querySelectorAll('.coreNavGroup')].forEach(s=>{if(!s.querySelector('button'))s.hidden=true;else s.hidden=false});
  }
  function schedule(){if(state.scheduled)return;state.scheduled=true;requestAnimationFrame(rebuild)}
  function start(){const nav=document.querySelector('.shell>aside nav');if(!nav){setTimeout(start,250);return}state.nav=nav;state.observer?.disconnect();state.observer=new MutationObserver(schedule);state.observer.observe(nav,{childList:true,subtree:true});schedule();window.dispatchEvent(new CustomEvent('profi24:core-ui-ready'))}
  const api={
    registerNav({id,label,group='management',onClick,badge}){const mount=()=>{const nav=document.querySelector('.shell>aside nav');if(!nav)return setTimeout(mount,150);if(nav.querySelector(`[data-core-nav-id="${id}"]`))return;const b=document.createElement('button');b.dataset.coreNavId=id;b.dataset.coreManaged='1';b.dataset.coreLabel=label;b.type='button';b.innerHTML=`<span>${label}</span>${badge?`<b>${badge}</b>`:''}`;b.addEventListener('click',onClick);let sec=section(nav,groups[group]?group:'management'),body=sec.querySelector('.coreNavGroupBody');if(!sec.isConnected)nav.appendChild(sec);body.appendChild(b);schedule()};mount()},
    refresh:schedule
  };
  window.Profi24UI=api;
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
  window.addEventListener('storage',e=>{if(e.key==='user')setTimeout(start,100)});
})();