// PROFI24 owner-only closed order correction control. Layout-independent.
(function(){
  const getUser=()=>{try{return JSON.parse(localStorage.getItem('user')||'null')}catch{return null}};
  const token=()=>localStorage.getItem('token')||'';
  function jwtRole(){try{return JSON.parse(atob((token().split('.')[1]||'').replace(/-/g,'+').replace(/_/g,'/'))).role||''}catch{return''}}
  const isOwner=()=>String(getUser()?.role||jwtRole()).toUpperCase()==='OWNER';
  function visibleText(el){return (el?.textContent||'').replace(/\s+/g,' ').trim()}
  function findOrderNumber(){
    const candidates=[...document.querySelectorAll('h1,h2,h3,strong,b')];
    for(const el of candidates){const m=visibleText(el).match(/(?:Заказ\s+)?(KST-\d{4}-\d+)/i);if(m)return m[1]}
    return '';
  }
  function findStatus(){
    const pills=[...document.querySelectorAll('.pill,.hcHeroStatus,[class*="status"],button,span')];
    if(pills.some(x=>/^Закрыта?$/i.test(visibleText(x))))return'CLOSED';
    if(pills.some(x=>/^(К оплате|Ожидает оплаты)$/i.test(visibleText(x))))return'PAYMENT_REQUIRED';
    return'';
  }
  function findHeader(){
    const n=findOrderNumber();if(!n)return null;
    const nodes=[...document.querySelectorAll('h1,h2,h3,strong,b')];
    const title=nodes.find(x=>visibleText(x).includes(n));
    if(!title)return null;
    return title.closest('.hcHeroHeader,.ordertitle,header')||title.parentElement;
  }
  async function api(path,body){const r=await fetch('/owner-api/v1'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token()}`},body:JSON.stringify(body||{})});let j={};try{j=await r.json()}catch{}if(!r.ok)throw new Error(j?.error?.message||`Ошибка ${r.status}`);return j.data}
  function mount(){
    if(!isOwner()){document.querySelector('.ownerClosedEditBtn')?.remove();return}
    const n=findOrderNumber(),s=findStatus(),host=findHeader();
    if(!n||!host){document.querySelector('.ownerClosedEditBtn')?.remove();return}
    const editKey=localStorage.getItem('profi24_owner_edit_order');
    const mode=s==='CLOSED'?'reopen':(s==='PAYMENT_REQUIRED'&&editKey===n?'finish':'');
    if(!mode){document.querySelector('.ownerClosedEditBtn')?.remove();return}
    let box=host.querySelector('.ownerClosedEditBox');
    if(!box){box=document.createElement('span');box.className='ownerClosedEditBox';host.appendChild(box)}
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
  let scheduled=false;const schedule=()=>{if(scheduled)return;scheduled=true;setTimeout(()=>{scheduled=false;mount()},120)};
  const obs=new MutationObserver(schedule);
  function start(){obs.observe(document.body,{subtree:true,childList:true});mount();setInterval(mount,1500)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();
