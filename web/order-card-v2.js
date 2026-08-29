// PROFI24 Order Card v2 — non-destructive workflow layer for the main order card.
(function(){
  const stages=[
    ['NEW','Новая'],['ASSIGNED','Назначена'],['DIAGNOSTICS','Диагностика'],['APPROVAL_REQUIRED','Согласование'],['WAITING_PART','Запчасти'],['REPAIR','Ремонт'],['TESTING','Проверка'],['PAYMENT_REQUIRED','Оплата'],['CLOSED','Закрыта']
  ];
  const statusAliases={ACCEPTED:'ASSIGNED'};
  const nextActions={
    NEW:{title:'Назначьте инженера и время',detail:'Заполните блок управления справа и сохраните назначение.',action:'Управление',kind:'side'},
    ASSIGNED:{title:'Перейдите к диагностике',detail:'После осмотра зафиксируйте причину неисправности и результат диагностики.',action:'Диагностика',kind:'main'},
    ACCEPTED:{title:'Перейдите к диагностике',detail:'После осмотра зафиксируйте причину неисправности и результат диагностики.',action:'Диагностика',kind:'main'},
    DIAGNOSTICS:{title:'Подготовьте работы и стоимость',detail:'Добавьте работы, запчасти и сформируйте итоговую сумму для клиента.',action:'Работы',kind:'tab',tab:'Работы'},
    APPROVAL_REQUIRED:{title:'Ожидается решение клиента',detail:'Проверьте согласование и не запускайте ремонт до подтверждения.',action:'Согласования',kind:'nav'},
    WAITING_PART:{title:'Контролируйте поступление запчасти',detail:'Проверьте заказанные позиции и ожидаемую дату поступления.',action:'Запчасти',kind:'tab',tab:'Запчасти'},
    REPAIR:{title:'Выполните ремонт',detail:'После выполнения работ перейдите к контрольной проверке.',action:'Основное',kind:'main'},
    TESTING:{title:'Завершите контрольную проверку',detail:'Зафиксируйте результат проверки после ремонта.',action:'Основное',kind:'main'},
    PAYMENT_REQUIRED:{title:'Примите оплату',detail:'Проверьте начисленную сумму, долг и способ оплаты.',action:'Оплаты',kind:'tab',tab:'Оплаты'},
    CLOSED:{title:'Заказ завершён',detail:'Все ключевые этапы заказа пройдены.',action:null,kind:null}
  };
  const getStatus=pill=>stages.map(x=>x[0]).concat(['ACCEPTED','CANCELLED']).find(s=>pill.classList.contains(s))||'';
  const clickTab=name=>{const b=[...document.querySelectorAll('.ordertabs button')].find(x=>x.textContent.trim().includes(name));b?.click()};
  const clickNav=name=>{const b=[...document.querySelectorAll('.shell>aside nav button')].find(x=>x.textContent.trim().includes(name));b?.click()};
  const perform=(cfg)=>{
    if(!cfg)return;
    if(cfg.kind==='tab')clickTab(cfg.tab||cfg.action);
    else if(cfg.kind==='main'){clickTab('Основное');setTimeout(()=>document.querySelector('.maincol')?.scrollIntoView({behavior:'smooth',block:'start'}),60)}
    else if(cfg.kind==='side')document.querySelector('.sidecol')?.scrollIntoView({behavior:'smooth',block:'start'});
    else if(cfg.kind==='nav')clickNav(cfg.action);
  };
  function render(){
    const title=document.querySelector('.ordertitle');
    const tabs=document.querySelector('.ordertabs');
    if(!title||!tabs){document.querySelector('.orderFlowV2')?.remove();return}
    const pill=title.querySelector('.pill');if(!pill)return;
    const raw=getStatus(pill),status=statusAliases[raw]||raw;
    const idx=Math.max(0,stages.findIndex(x=>x[0]===status));
    let root=document.querySelector('.orderFlowV2');
    if(!root){root=document.createElement('section');root.className='orderFlowV2';tabs.parentElement.insertBefore(root,tabs)}
    const cfg=nextActions[raw]||nextActions[status]||nextActions.NEW;
    root.innerHTML=`<div class="orderFlowHead"><div><small>ЭТАП ЗАКАЗА</small><b>${cfg.title}</b><span>${cfg.detail}</span></div>${cfg.action?'<button type="button" class="orderFlowAction">'+cfg.action+' →</button>':''}</div><div class="orderFlowSteps">${stages.map((s,i)=>`<div class="${i<idx?'done':i===idx?'current':''}"><i>${i<idx?'✓':i+1}</i><span>${s[1]}</span></div>`).join('')}</div>`;
    root.querySelector('.orderFlowAction')?.addEventListener('click',()=>perform(cfg));
    const total=title.querySelector('.total');if(total){const amount=Number((total.querySelector('b')?.textContent||'').replace(/[^0-9,-]/g,'').replace(',','.'))||0;const note=total.querySelector('span');if(note&&amount===0)note.textContent='Сумма не начислена';}
  }
  const obs=new MutationObserver(()=>requestAnimationFrame(render));
  function start(){obs.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});render()}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();