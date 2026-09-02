// Order 360 payment modal: handles full/partial payments from the yellow action button.
(function(){
  const token=()=>localStorage.token||'';
  const role=()=>{try{return JSON.parse(localStorage.user||'null')?.role||''}catch{return''}};
  const currentBtn=()=>document.querySelector('.o360List button.on');
  const requestId=()=>Number(currentBtn()?.dataset?.id||0);
  const requestNumber=()=>currentBtn()?.querySelector('b')?.textContent?.trim()||document.querySelector('.o360Hero small')?.textContent?.trim()||'';
  const money=v=>Number(v||0).toLocaleString('ru-RU')+' ₸';
  async function api(url,opt={}){const headers={Authorization:`Bearer ${token()}`,...(opt.body!=null?{'Content-Type':'application/json'}:{})};const r=await fetch(url,{...opt,headers:{...headers,...(opt.headers||{})}});let j={};try{j=await r.json()}catch{}if(!r.ok)throw new Error(j?.error?.message||`Ошибка ${r.status}`);return j.data}
  function close(){document.querySelector('.o360PayShade')?.remove()}
  async function open(detail={}){
    if(role()==='ENGINEER')return alert('Инженер не может проводить оплату');
    const id=requestId();if(!id)return;
    try{
      const r=await api('/api/v1/requests/'+id);
      const debt=Math.max(0,Number(r.total||0)-Number(r.paid||0));
      if(debt<=0)return alert('Заказ уже оплачен полностью');
      close();
      const sh=document.createElement('div');sh.className='o360PayShade';
      sh.innerHTML=`<div class="o360PayModal"><header><div><h2>Принять оплату</h2><p>${requestNumber()} · долг ${money(debt)}</p></div><button data-close>×</button></header><div class="o360PayBody"><label>Сумма оплаты<input name="amount" type="number" min="1" max="${debt}" step="1" value="${Math.min(Number(detail.amount||debt),debt)}"></label><div class="o360PayQuick"><button data-amt="full">Весь долг ${money(debt)}</button>${debt>1000?`<button data-amt="half">50% · ${money(Math.round(debt/2))}</button>`:''}</div><label>Способ оплаты<select name="method"><option value="KASPI">Kaspi</option><option value="CASH">Наличные</option><option value="CARD">Банковская карта</option><option value="BANK">Банковский перевод</option></select></label><label>Комментарий / номер операции<input name="reference" placeholder="Необязательно"></label><div class="o360PaySummary"><span>После оплаты останется</span><b data-left>${money(0)}</b></div><div class="o360PayError"></div></div><footer><button data-close>Отмена</button><button class="save" data-save>Принять оплату</button></footer></div>`;
      document.body.appendChild(sh);
      const amount=sh.querySelector('[name="amount"]'),left=sh.querySelector('[data-left]'),err=sh.querySelector('.o360PayError'),save=sh.querySelector('[data-save]');
      const calc=()=>{const a=Math.max(0,Number(amount.value||0));left.textContent=money(Math.max(0,debt-a));save.textContent=a>=debt?'Принять полную оплату':'Принять частичную оплату'};calc();amount.oninput=calc;
      sh.querySelectorAll('[data-close]').forEach(b=>b.onclick=close);sh.onclick=e=>{if(e.target===sh)close()};
      sh.querySelector('[data-amt="full"]').onclick=()=>{amount.value=debt;calc()};const half=sh.querySelector('[data-amt="half"]');if(half)half.onclick=()=>{amount.value=Math.round(debt/2);calc()};
      save.onclick=async()=>{try{err.textContent='';save.disabled=true;const a=Number(amount.value||0);if(a<=0)throw new Error('Введите сумму оплаты');if(a>debt)throw new Error(`Сумма оплаты не может превышать долг ${money(debt)}`);await api(`/api/v1/requests/${id}/payment`,{method:'POST',body:JSON.stringify({amount:a,method:sh.querySelector('[name="method"]').value,reference:sh.querySelector('[name="reference"]').value.trim()||null})});close();window.dispatchEvent(new CustomEvent('profi24:request-updated',{detail:{id}}));window.dispatchEvent(new CustomEvent('profi24:open-order360',{detail:{id}}))}catch(e){err.textContent=e.message;save.disabled=false}};
    }catch(e){alert(e.message)}
  }
  window.addEventListener('profi24:order-payment',e=>open(e.detail||{}));
})();