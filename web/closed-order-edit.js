// PROFI24 owner-only closed order correction control. Layout-independent.
(function(){
  const getUser=()=>{try{return JSON.parse(localStorage.getItem('user')||'null')}catch{return null}};
  const token=()=>localStorage.getItem('token')||'';
  function jwtRole(){try{return JSON.parse(atob((token().split('.')[1]||'').replace(/-/g,'+').replace(/_/g,'/'))).role||''}catch{return''}}
  const isOwner=()=>String(getUser()?.role||jwtRole()).toUpperCase()==='OWNER';
  function visibleText(el){return (el?.textContent||'').replace(/\s+/g,' ').trim()}
  function findOrderNumber(){for(const el of document.querySelectorAll('h1,h2,h3,strong,b')){const m=visibleText(el).match(/(?:Заказ\s+)?(KST-\d{4}-\d+)/i);if(m)return m[1]}return''}
  function findStatus(){const a=[...document.querySelectorAll('.pill,.hcHeroStatus,[class*="status"],button,span')].map(visibleText);if(a.some(x=>/^Закрыта?$/i.test(x)))return'CLOSED';return''}
  function findHeader(){const n=findOrderNumber();if(!n)return null;const title=[...document.querySelectorAll('h1,h2,h3,strong,b')].find(x=>visibleText(x).includes(n));return title?.closest('.hcHeroHeader,.ordertitle,header')||title?.parentElement||null}
  async function api(path,body){const r=await fetch('/owner-api/v1'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token()}`},body:JSON.stringify(body||{})});let j={};try{j=await r.json()}catch{}if(!r.ok)throw new Error(j?.error?.message||`Ошибка ${r.status}`);return j.data}
  function mount(){
    if(!isOwner()){document.querySelector('.ownerClosedEditBox')?.remove();return}
    const n=findOrderNumber(),s=findStatus(),host=findHeader();if(!n||!host)return;
    const editKey=localStorage.getItem('profi24_owner_edit_order');
    // IMPORTANT: after reopening, normal CRM workflow may move the order from PAYMENT_REQUIRED
    // to APPROVAL_REQUIRED/REPAIR/etc. Correction mode therefore follows the explicit owner edit key,
    // not the current workflow status.
    const mode=s==='CLOSED'?'reopen':(editKey===n?'finish':'');
    if(!mode){document.querySelector('.ownerClosedEditBox')?.remove();return}
    let box=host.querySelector('.ownerClosedEditBox');if(!box){box=document.createElement('span');box.className='ownerClosedEditBox';host.appendChild(box)}
    let b=box.querySelector('.ownerClosedEditBtn');if(!b){b=document.createElement('button');b.type='button';b.className='ownerClosedEditBtn';box.appendChild(b)}
    b.textContent=mode==='reopen'?'✎ Редактировать закрытый заказ':'✓ Завершить корректировку';
    b.onclick=async e=>{e.preventDefault();e.stopPropagation();try{
      if(mode==='reopen'){
        if(!confirm(`Открыть закрытый заказ ${n} для редактирования?\nДействие будет записано в историю.`))return;
        const reason=prompt('Причина корректировки','Исправление данных закрытого заказа')||'Исправление данных закрытого заказа';b.disabled=true;b.textContent='Открываю…';await api(`/orders/${encodeURIComponent(n)}/reopen`,{reason});localStorage.setItem('profi24_owner_edit_order',n);location.reload();
      }else{
        if(!confirm(`Завершить корректировку заказа ${n} и снова закрыть его?`))return;
        const reason=prompt('Комментарий','Корректировка завершена')||'Корректировка завершена';b.disabled=true;b.textContent='Закрываю…';await api(`/orders/${encodeURIComponent(n)}/close`,{reason});localStorage.removeItem('profi24_owner_edit_order');location.reload();
      }
    }catch(x){b.disabled=false;b.textContent=mode==='reopen'?'✎ Редактировать закрытый заказ':'✓ Завершить корректировку';alert(x.message)}};
  }
  let scheduled=false;const schedule=()=>{if(scheduled)return;scheduled=true;setTimeout(()=>{scheduled=false;mount()},120)};new MutationObserver(schedule).observe(document.body,{subtree:true,childList:true});mount();setInterval(mount,1500);
})();
