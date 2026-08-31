// PROFI24 owner-only closed order correction mode.
(function(){
  function user(){try{return JSON.parse(localStorage.user||'null')}catch{return null}}
  function token(){return localStorage.token||''}
  function orderNumber(){return document.querySelector('.hcHeroLeft strong')?.textContent?.replace(/^Заказ\s+/,'').trim()||document.querySelector('.ordertitle h2')?.textContent?.replace(/^Заказ\s+/,'').trim()||''}
  function status(){const p=document.querySelector('.hcHeroStatus')||document.querySelector('.ordertitle .pill');if(!p)return'';if(p.classList.contains('CLOSED')||/закрыт/i.test(p.textContent||''))return'CLOSED';if(p.classList.contains('PAYMENT_REQUIRED')||/к оплате/i.test(p.textContent||''))return'PAYMENT_REQUIRED';return''}
  async function api(path,body){const r=await fetch('/owner-api/v1'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token()}`},body:JSON.stringify(body||{})});let j={};try{j=await r.json()}catch{}if(!r.ok)throw new Error(j?.error?.message||'Ошибка операции');return j.data}
  function mount(){
    if(user()?.role!=='OWNER'){document.querySelector('.ownerClosedEditBtn')?.remove();return}
    const host=document.querySelector('.hcHeroActions')||document.querySelector('.ordertitle');
    const n=orderNumber(),s=status();
    if(!host||!n){document.querySelector('.ownerClosedEditBtn')?.remove();return}
    let b=document.querySelector('.ownerClosedEditBtn');
    const editKey=localStorage.getItem('profi24_owner_edit_order');
    const mode=s==='CLOSED'?'reopen':(s==='PAYMENT_REQUIRED'&&editKey===n?'finish':'');
    if(!mode){b?.remove();return}
    if(!b){b=document.createElement('button');b.type='button';b.className='ownerClosedEditBtn';host.prepend(b)}
    b.dataset.mode=mode;
    b.textContent=mode==='reopen'?'✎ Редактировать закрытый заказ':'✓ Завершить корректировку';
    b.onclick=async e=>{
      e.preventDefault();e.stopPropagation();
      try{
        if(mode==='reopen'){
          if(!confirm(`Открыть закрытый заказ ${n} для редактирования?\n\nДействие будет записано в историю заказа.`))return;
          const reason=prompt('Причина корректировки','Исправление данных закрытого заказа')||'Исправление данных закрытого заказа';
          b.disabled=true;b.textContent='Открываю…';
          await api(`/orders/${encodeURIComponent(n)}/reopen`,{reason});
          localStorage.setItem('profi24_owner_edit_order',n);
          alert(`Заказ ${n} открыт для редактирования.\nТеперь можно изменить работы, запчасти, суммы и другие данные.`);
          location.reload();
        }else{
          if(!confirm(`Завершить корректировку и снова закрыть заказ ${n}?\nCRM проверит, что заказ полностью оплачен.`))return;
          const reason=prompt('Комментарий к завершению корректировки','Корректировка завершена')||'Корректировка завершена';
          b.disabled=true;b.textContent='Закрываю…';
          await api(`/orders/${encodeURIComponent(n)}/close`,{reason});
          localStorage.removeItem('profi24_owner_edit_order');
          alert(`Заказ ${n} снова закрыт.`);
          location.reload();
        }
      }catch(x){b.disabled=false;mount();alert(x.message)}
    };
  }
  const obs=new MutationObserver(()=>requestAnimationFrame(mount));
  function start(){obs.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});mount()}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();
