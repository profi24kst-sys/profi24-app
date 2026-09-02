// Order 360 UI sanity: distinguish the all-orders navigator from the current order
// and never call a zero-value order "paid in full".
(function(){
  function moneyNum(text){
    const n=String(text||'').replace(/[^\d,.-]/g,'').replace(',','.');
    return Number(n||0)||0;
  }
  function selected(){return document.querySelector('.o360List button.on')}
  function currentTotal(){
    const hero=document.querySelector('.o360Hero');
    const amount=[...hero?.querySelectorAll('b')||[]].map(x=>moneyNum(x.textContent)).find(n=>Number.isFinite(n));
    return Number(amount||0);
  }
  function mountListHeader(){
    const list=document.querySelector('.o360List');
    if(!list||list.querySelector('.o360ListCaption'))return;
    const search=list.querySelector('.o360Search');
    const cap=document.createElement('div');
    cap.className='o360ListCaption';
    cap.innerHTML='<b>Все заказы</b><small>Отдельные заявки сервисного центра</small>';
    list.insertBefore(cap,search||list.firstChild);
  }
  function fixZeroState(){
    const hero=document.querySelector('.o360Hero');
    if(!hero)return;
    const total=currentTotal();
    const right=hero.lastElementChild;
    const sub=right?.querySelector('small');
    if(total<=0&&sub){sub.textContent='Стоимость не сформирована';sub.dataset.zeroState='1'}
    else if(sub?.dataset.zeroState==='1')delete sub.dataset.zeroState;
    // Zero-value orders are not financially completed even though balance is mathematically zero.
    document.querySelectorAll('.o360PrimaryAction').forEach(b=>{if(total<=0)b.remove()});
    const finance=[...document.querySelectorAll('.o360Card')].find(c=>c.querySelector('header b')?.textContent.trim()==='Финансы');
    if(finance&&total<=0){
      const rows=[...finance.querySelectorAll('.o360Row')];
      const paid=rows.find(r=>r.querySelector('span')?.textContent.trim()==='Оплачено');
      const debt=rows.find(r=>r.querySelector('span')?.textContent.trim()==='Долг');
      if(paid)paid.title='Оплата ещё не требуется: стоимость заказа не сформирована';
      if(debt)debt.title='Долг появится после формирования стоимости заказа';
    }
  }
  function markSelected(){
    const list=document.querySelector('.o360List');
    if(!list)return;
    list.querySelectorAll('button[data-id]').forEach(b=>{
      const tag=b.querySelector('.o360CurrentTag');
      if(b.classList.contains('on')){
        if(!tag){const x=document.createElement('span');x.className='o360CurrentTag';x.textContent='Текущий';b.appendChild(x)}
      }else tag?.remove();
    });
  }
  function styles(){
    if(document.getElementById('o360SanityStyle'))return;
    const s=document.createElement('style');s.id='o360SanityStyle';s.textContent=`
      .o360ListCaption{padding:12px 14px 8px;display:flex;flex-direction:column;gap:2px;border-bottom:1px solid #eef1f5;background:#fff;position:sticky;top:0;z-index:2}
      .o360ListCaption b{font-size:13px;color:#172033}.o360ListCaption small{font-size:11px;color:#7b8494}
      .o360List button[data-id]{position:relative}.o360CurrentTag{position:absolute;right:8px;bottom:7px;font-size:9px;font-weight:800;color:#165d2c;background:#eaf7ee;border-radius:999px;padding:2px 6px}
    `;document.head.appendChild(s)
  }
  function mount(){if(!document.querySelector('.o360'))return;styles();mountListHeader();fixZeroState();markSelected()}
  let t;new MutationObserver(()=>{clearTimeout(t);t=setTimeout(mount,40)}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
  window.addEventListener('profi24:order360-switched',()=>setTimeout(mount,20));
  setInterval(mount,1500);setTimeout(mount,300);
})();