// PROFI24 Dispatch Control Enhancer v1.0
(function(){
  const parseDate=s=>{if(!s)return null;const m=String(s).match(/(\d{2})\.(\d{2})(?:\.(\d{2,4}))?,?\s*(\d{2}):(\d{2})/);if(!m)return null;let y=m[3]?Number(m[3]):new Date().getFullYear();if(y<100)y+=2000;return new Date(y,Number(m[2])-1,Number(m[1]),Number(m[4]),Number(m[5]))};
  const elapsed=d=>{if(!d)return'';const mins=Math.max(0,Math.floor((Date.now()-d.getTime())/60000));if(mins<60)return `${mins} мин`;const h=Math.floor(mins/60),m=mins%60;if(h<24)return `${h} ч ${m} мин`;const days=Math.floor(h/24),rh=h%24;return `${days} д ${rh} ч`};
  function openOrder(number){
    const nav=[...document.querySelectorAll('.shell>aside nav button')].find(b=>(b.dataset.coreLabel||b.textContent||'').trim().startsWith('Заказы')&&!b.hidden);
    if(nav)nav.click();
    let tries=0;const timer=setInterval(()=>{tries++;const row=[...document.querySelectorAll('.trow')].find(r=>(r.textContent||'').includes(number));if(row){clearInterval(timer);row.click()}else if(tries>20)clearInterval(timer)},100);
  }
  function enhance(){
    document.querySelectorAll('.controlCard').forEach(card=>{
      if(card.dataset.controlEnhanced)return;card.dataset.controlEnhanced='1';
      const order=card.querySelector('.controlOrder>b');if(order){order.classList.add('controlOrderLink');order.title='Открыть карточку заказа';order.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();openOrder(order.textContent.trim())})}
      const reason=card.querySelector('.controlOrder>em');
      if(reason){
        let base=null;const text=reason.textContent||'';
        if(text.includes('SLA')){const metric=[...card.querySelectorAll('.controlMeta span')].find(x=>(x.textContent||'').includes('Выезд'));base=parseDate(metric?.textContent)}
        if(!base){const metric=[...card.querySelectorAll('.controlMeta span')].find(x=>/\d{2}\.\d{2}.*\d{2}:\d{2}/.test(x.textContent||''));base=parseDate(metric?.textContent)}
        const badge=document.createElement('strong');badge.className='controlElapsed';badge.dataset.since=base?base.toISOString():'';badge.textContent=base?'Просрочка '+elapsed(base):'';if(badge.textContent)reason.after(badge);
      }
    });
    document.querySelectorAll('.controlElapsed[data-since]').forEach(b=>{if(b.dataset.since)b.textContent='Просрочка '+elapsed(new Date(b.dataset.since))});
  }
  const obs=new MutationObserver(enhance);function start(){obs.observe(document.body,{childList:true,subtree:true});enhance();setInterval(enhance,30000)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();