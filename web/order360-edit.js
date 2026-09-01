// PROFI24 Order 360 editor — OWNER-safe correction of order metadata with audit history.
(function(){
  const token=()=>localStorage.token||'';
  const role=()=>{try{return JSON.parse(localStorage.user||'null')?.role||''}catch{return''}};
  const api=async(path,opt={})=>{const r=await fetch(path,{...opt,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token()}`,...(opt.headers||{})}});let j={};try{j=await r.json()}catch{}if(!r.ok)throw new Error(j?.error?.message||`Ошибка ${r.status}`);return j.data};
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const current=()=>document.querySelector('.o360List button.on');
  const currentId=()=>current()?.dataset?.id||'';
  const currentNumber=()=>current()?.querySelector('b')?.textContent?.trim()||document.querySelector('.o360Hero small')?.textContent?.trim()||'';
  function close(){document.querySelector('.o360EditShade')?.remove()}
  async function open(){
    if(role()!=='OWNER')return alert('Редактирование заказа доступно владельцу');
    const number=currentNumber(); if(!number)return;
    try{
      const [r,users]=await Promise.all([
        api('/owner-api/v1/orders/'+encodeURIComponent(number)+'/admin-details'),
        api('/api/v1/users').catch(()=>[])
      ]);
      const engineers=(users||[]).filter(x=>x.active!==false&&x.role==='ENGINEER');
      const managers=(users||[]).filter(x=>x.active!==false&&['OWNER','MANAGER'].includes(x.role));
      const shade=document.createElement('div');shade.className='o360EditShade';
      shade.innerHTML=`<div class="o360EditModal"><header><div><h2>Редактировать заказ</h2><p>${esc(number)} · изменения будут записаны в историю</p></div><button data-close>×</button></header><div class="o360EditGrid">
      <label class="wide">Причина обращения<textarea name="complaint">${esc(r.complaint||'')}</textarea></label>
      <label class="wide">Диагностика<textarea name="diagnosis">${esc(r.diagnosis||'')}</textarea></label>
      <label>Источник<select name="source">${['GOOGLE_ADS','GOOGLE','2GIS','INSTAGRAM','TIKTOK','OLX','REFERRAL','REPEAT','B2B','OTHER'].map(x=>`<option ${x===r.source?'selected':''}>${x}</option>`).join('')}</select></label>
      <label>Приоритет<select name="priority">${['LOW','NORMAL','HIGH','URGENT'].map(x=>`<option value="${x}" ${x===(r.priority||'NORMAL')?'selected':''}>${({LOW:'Низкий',NORMAL:'Обычный',HIGH:'Высокий',URGENT:'Срочный'})[x]}</option>`).join('')}</select></label>
      <label>Статус<select name="status">${['NEW','ASSIGNED','ACCEPTED','ON_ROUTE','DIAGNOSTICS','APPROVAL_REQUIRED','WAITING_PART','REPAIR','TESTING','PAYMENT_REQUIRED','CLOSED','CANCELLED'].map(x=>`<option value="${x}" ${x===r.status?'selected':''}>${x}</option>`).join('')}</select></label>
      <label>Дата / время выезда<input name="scheduled_at" type="datetime-local" value="${r.scheduled_at?new Date(r.scheduled_at).toISOString().slice(0,16):''}"></label>
      <label>Инженер<select name="engineer_id"><option value="">Не назначен</option>${engineers.map(x=>`<option value="${x.id}" ${Number(x.id)===Number(r.engineer_id)?'selected':''}>${esc(x.name)}</option>`).join('')}</select></label>
      <label>Менеджер<select name="manager_id"><option value="">Не назначен</option>${managers.map(x=>`<option value="${x.id}" ${Number(x.id)===Number(r.manager_id)?'selected':''}>${esc(x.name)}</option>`).join('')}</select></label>
      <label class="wide">Результат проверки<textarea name="test_result">${esc(r.test_result||'')}</textarea></label>
      </div><div class="o360EditNote">Клиент и карточка техники являются отдельными справочниками. Их имя, телефон, модель и серийный номер редактируются в разделах «Клиенты» и «Техника», чтобы не менять историю других заказов этого клиента.</div><div class="o360EditError"></div><footer><button data-close>Отмена</button><button class="save" data-save>Сохранить изменения</button></footer></div>`;
      document.body.appendChild(shade); shade.querySelectorAll('[data-close]').forEach(b=>b.onclick=close); shade.onclick=e=>{if(e.target===shade)close()};
      shade.querySelector('[data-save]').onclick=async()=>{
        const b=shade.querySelector('[data-save]'),err=shade.querySelector('.o360EditError');
        try{b.disabled=true;err.textContent='';const v=n=>shade.querySelector(`[name="${n}"]`)?.value??'';const complaint=v('complaint').trim();if(!complaint)throw new Error('Причина обращения обязательна');
          await api('/owner-api/v1/orders/'+encodeURIComponent(number),{method:'PATCH',body:JSON.stringify({complaint,diagnosis:v('diagnosis').trim()||null,source:v('source'),priority:v('priority'),status:v('status'),scheduled_at:v('scheduled_at')?new Date(v('scheduled_at')).toISOString():null,engineer_id:v('engineer_id')||null,manager_id:v('manager_id')||null,test_result:v('test_result').trim()||null})});
          close(); window.dispatchEvent(new CustomEvent('profi24:request-updated',{detail:{id:currentId()}})); window.dispatchEvent(new CustomEvent('profi24:open-order360',{detail:{id:currentId()}}));
        }catch(e){err.textContent=e.message;b.disabled=false}
      };
    }catch(e){alert(e.message)}
  }
  function mount(){if(role()!=='OWNER')return;const hero=document.querySelector('.o360Hero');if(!hero){document.querySelector('.o360EditBtn')?.remove();return}if(hero.querySelector('.o360EditBtn'))return;const q=hero.querySelector('.o360Quick');if(!q)return;const b=document.createElement('button');b.type='button';b.className='o360EditBtn';b.textContent='✎ Редактировать заказ';b.onclick=open;q.appendChild(b)}
  let t;new MutationObserver(()=>{clearTimeout(t);t=setTimeout(mount,200)}).observe(document.body,{childList:true,subtree:true});setInterval(()=>{if(document.querySelector('.o360'))mount()},3000);setTimeout(mount,500);
})();