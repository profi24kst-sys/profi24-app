// PROFI24 owner-only closed order correction control. Layout-independent.
(function(){
  const getUser=()=>{try{return JSON.parse(localStorage.getItem('user')||'null')}catch{return null}};
  const token=()=>localStorage.getItem('token')||'';
  function jwtRole(){try{return JSON.parse(atob((token().split('.')[1]||'').replace(/-/g,'+').replace(/_/g,'/'))).role||''}catch{return''}}
  const isOwner=()=>String(getUser()?.role||jwtRole()).toUpperCase()==='OWNER';
  const text=el=>(el?.textContent||'').replace(/\s+/g,' ').trim();
  function orderNo(){for(const el of document.querySelectorAll('h1,h2,h3,strong,b')){const m=text(el).match(/(?:Заказ\s+)?(KST-\d{4}-\d+)/i);if(m)return m[1]}return''}
  function closed(){return [...document.querySelectorAll('.pill,.hcHeroStatus,[class*="status"],button,span')].some(x=>/^Закрыта?$/i.test(text(x)))}
  function titleNode(n){return [...document.querySelectorAll('h1,h2,h3,strong,b')].find(x=>text(x).includes(n))||null}
  async function api(path,body){const r=await fetch('/owner-api/v1'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token()}`},body:JSON.stringify(body||{})});let j={};try{j=await r.json()}catch{}if(!r.ok)throw new Error(j?.error?.message||`Ошибка ${r.status}`);return j.data}
  function remove(){document.querySelector('.ownerCorrectionBar')?.remove();document.querySelector('.ownerClosedEditBox')?.remove()}
  function mount(){
    if(!isOwner()){remove();return}
    const n=orderNo();if(!n){remove();return}
    const key=localStorage.getItem('profi24_owner_edit_order');
    const mode=closed()?'reopen':(key===n?'finish':'');
    if(!mode){remove();return}
    const title=titleNode(n);if(!title)return;
    if(mode==='finish'){
      document.querySelector('.ownerClosedEditBox')?.remove();
      let bar=document.querySelector('.ownerCorrectionBar');
      if(!bar){bar=document.createElement('div');bar.className='ownerCorrectionBar';bar.innerHTML='<div><b>Режим корректировки закрытого заказа</b><span>OWNER может исправить данные. После проверки завершите корректировку.</span></div><button type="button">✓ Завершить корректировку</button>';const anchor=title.closest('.hcHeroHeader,.ordertitle,header')||title.parentElement;anchor.parentElement.insertBefore(bar,anchor);}
      const b=bar.querySelector('button');b.onclick=async()=>{try{if(!confirm(`Завершить корректировку заказа ${n} и снова закрыть его?`))return;const reason=prompt('Комментарий','Корректировка завершена')||'Корректировка завершена';b.disabled=true;b.textContent='Закрываю…';await api(`/orders/${encodeURIComponent(n)}/close`,{reason});localStorage.removeItem('profi24_owner_edit_order');location.reload()}catch(e){b.disabled=false;b.textContent='✓ Завершить корректировку';alert(e.message)}};return;
    }
    document.querySelector('.ownerCorrectionBar')?.remove();
    const host=title.closest('.hcHeroHeader,.ordertitle,header')||title.parentElement;let box=host.querySelector('.ownerClosedEditBox');if(!box){box=document.createElement('span');box.className='ownerClosedEditBox';host.appendChild(box)}let b=box.querySelector('button');if(!b){b=document.createElement('button');b.type='button';b.className='ownerClosedEditBtn';box.appendChild(b)}b.textContent='✎ Редактировать закрытый заказ';b.onclick=async()=>{try{if(!confirm(`Открыть закрытый заказ ${n} для редактирования?\nДействие будет записано в историю.`))return;const reason=prompt('Причина корректировки','Исправление данных закрытого заказа')||'Исправление данных закрытого заказа';b.disabled=true;b.textContent='Открываю…';await api(`/orders/${encodeURIComponent(n)}/reopen`,{reason});localStorage.setItem('profi24_owner_edit_order',n);location.reload()}catch(e){b.disabled=false;b.textContent='✎ Редактировать закрытый заказ';alert(e.message)}};
  }
  let pending=false;const schedule=()=>{if(pending)return;pending=true;setTimeout(()=>{pending=false;mount()},150)};new MutationObserver(schedule).observe(document.body,{subtree:true,childList:true});mount();setInterval(mount,1000);
})();