// Stable HelloClient header/geometry fix. Keeps React order state untouched.
(function(){
  const labels={NEW:'Новая',ASSIGNED:'Назначена',ACCEPTED:'Принята',DIAGNOSTICS:'Диагностика',APPROVAL_REQUIRED:'Согласование',WAITING_PART:'Ждёт деталь',REPAIR:'Ремонт',TESTING:'Проверка',PAYMENT_REQUIRED:'К оплате',CLOSED:'Закрыта',CANCELLED:'Отменена'};
  function clickTab(name){[...document.querySelectorAll('.ordertabs button')].find(b=>b.textContent.includes(name))?.click()}
  function mount(){
    const main=document.querySelector('main.hcOrderMode');
    const title=main?.querySelector('.ordertitle');
    if(!main||!title){document.querySelector('.hcHeroHeader')?.remove();return}
    const rawNumber=title.querySelector('h2')?.textContent?.replace(/^Заказ\s+/,'').trim();
    if(!rawNumber)return;
    const amount=title.querySelector('.total b')?.textContent?.trim()||'0 ₸';
    const pill=title.querySelector('.pill');
    const status=[...pill?.classList||[]].find(x=>labels[x])||'';
    let hero=main.querySelector('.hcHeroHeader');
    if(!hero){hero=document.createElement('section');hero.className='hcHeroHeader';title.parentElement.insertBefore(hero,title)}
    hero.innerHTML=`<div class="hcHeroLeft"><strong>Заказ ${rawNumber}</strong><span>${amount}</span><em class="hcHeroStatus ${status}">${labels[status]||pill?.textContent?.trim()||'—'}</em></div><div class="hcHeroActions"><button type="button" data-hc-final="diagnostic">🩺 Диагностика</button><button type="button" data-hc-final="approval">🤝 Согласование</button><button type="button" data-hc-final="parts">📦 Запчасти</button><button type="button" data-hc-final="completion">✅ Завершить ремонт</button><button type="button" data-hc-final="print">▣ Печать</button><button type="button" data-hc-final="more">••• Еще</button></div>`;
    hero.querySelector('[data-hc-final="diagnostic"]').onclick=()=>window.dispatchEvent(new CustomEvent('profi24:open-diagnostics',{detail:{number:rawNumber}}));
    hero.querySelector('[data-hc-final="approval"]').onclick=()=>window.dispatchEvent(new CustomEvent('profi24:open-approval',{detail:{number:rawNumber}}));
    hero.querySelector('[data-hc-final="parts"]').onclick=()=>window.dispatchEvent(new CustomEvent('profi24:open-parts-waiting',{detail:{number:rawNumber}}));
    hero.querySelector('[data-hc-final="completion"]').onclick=()=>window.dispatchEvent(new CustomEvent('profi24:open-completion',{detail:{number:rawNumber}}));
    hero.querySelector('[data-hc-final="print"]').onclick=()=>clickTab('Документы');
    hero.querySelector('[data-hc-final="more"]').onclick=()=>clickTab('История');
  }
  const obs=new MutationObserver(()=>requestAnimationFrame(mount));
  function start(){obs.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class']});mount()}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();