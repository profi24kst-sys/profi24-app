const token=()=>localStorage.token;
const currentUser=()=>window.Profi24RBAC?.user?.()||null;
const isOffice=()=>['OWNER','SUPERVISOR','MANAGER'].includes(currentUser()?.role);
const isEngineer=()=>currentUser()?.role==='ENGINEER';
const isOwner=()=>currentUser()?.role==='OWNER';
const canWarranty=()=>['OWNER','SUPERVISOR'].includes(currentUser()?.role);
const holdLabels={WAITING_CUSTOMER:'Ожидаем клиента',WAITING_APPROVAL:'Ожидаем согласование',WAITING_PART:'Ожидаем запчасть',REPEAT_VISIT:'Нужен повторный выезд',EXTERNAL_SERVICE:'Внешний сервис/подрядчик',WAITING_DELIVERY:'Ожидаем доставку',OTHER:'Другое ожидание'};
const outcomeLabels={SCHEDULED:'Запланирован',COMPLETED:'Выполнен',NO_ACCESS:'Нет доступа',CUSTOMER_NO_SHOW:'Клиент отсутствовал',REPEAT_REQUIRED:'Нужен повторный визит',CANCELLED:'Отменён'};
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n};
const input=(type,placeholder)=>{const n=el('input','lifeInput');n.type=type;n.placeholder=placeholder||'';return n};
const button=(text,cls='')=>{const n=el('button','lifeBtn '+cls,text);n.type='button';return n};
const fmt=v=>v?new Date(v).toLocaleString('ru-RU'):'—';
const key=()=>`lifecycle-${Date.now()}-${crypto.randomUUID?.()||Math.random().toString(36).slice(2)}`;
async function api(path,options={}){
  const method=options.method||'GET';
  const headers={Authorization:`Bearer ${token()}`,...(options.body?{'Content-Type':'application/json'}:{}),...(method==='GET'?{}:{'Idempotency-Key':key()}),...(options.headers||{})};
  const r=await fetch('/lifecycle-api'+path,{...options,method,headers});
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(j.error?.message||'Не удалось выполнить действие');
  return j.data;
}
let currentId=0,loading=false;
function root(){return document.querySelector('.o360')}
function host(){const r=root();if(!r)return null;let h=r.querySelector('.o360Lifecycle');if(!h){h=el('section','o360Lifecycle');r.appendChild(h)}return h}
function notify(id){window.dispatchEvent(new CustomEvent('profi24:request-updated',{detail:{id:Number(id)}}))}
async function run(id,fn){const h=host();if(h)h.classList.add('lifeBusy');try{await fn();notify(id);await load(id,true)}catch(e){renderError(e.message)}finally{host()?.classList.remove('lifeBusy')}}
function renderError(message){const h=host();if(!h)return;let box=h.querySelector('.lifeError');if(!box){box=el('div','lifeError');h.prepend(box)}box.textContent=message||'';box.hidden=!message}
function holdForm(id,data){
  if(['CLOSED','CANCELLED'].includes(data.request_status)||data.active_hold||(!isOffice()&&!isEngineer()))return null;
  const box=el('div','lifeActionBox'),title=el('b','','Поставить на ожидание');box.appendChild(title);
  const select=el('select','lifeInput');
  const types=isEngineer()?['WAITING_PART','REPEAT_VISIT','EXTERNAL_SERVICE','OTHER']:Object.keys(holdLabels);
  for(const t of types)select.appendChild(new Option(holdLabels[t],t));
  const reason=input('text','Причина ожидания');const expected=input('datetime-local');
  const pause=el('label','lifeCheck');const check=document.createElement('input');check.type='checkbox';check.checked=true;pause.append(check,document.createTextNode(' Приостановить SLA'));
  const go=button('Начать ожидание','lifePrimary');
  go.onclick=()=>{if(reason.value.trim().length<3)return renderError('Укажите причину ожидания');run(id,()=>api(`/v1/requests/${id}/holds`,{method:'POST',body:JSON.stringify({hold_type:select.value,reason:reason.value.trim(),expected_until:expected.value?new Date(expected.value).toISOString():null,pause_sla:check.checked})}))};
  box.append(select,reason,expected,pause,go);return box;
}
function activeHoldBox(id,hold){
  if(!hold)return null;const box=el('div','lifeHoldActive');
  const head=el('div','lifeHoldHead');head.append(el('strong','',holdLabels[hold.hold_type]||hold.hold_type),el('span','lifeBadge','ПАУЗА'));box.appendChild(head);
  box.append(el('p','',hold.reason),el('small','',`Начало: ${fmt(hold.started_at)}${hold.expected_until?' · контроль: '+fmt(hold.expected_until):''}${hold.responsible_name?' · ответственный: '+hold.responsible_name:''}`));
  if(isOffice()){
    const resolution=input('text','Результат ожидания / что изменилось');const resume=button('Возобновить заказ','lifePrimary');
    resume.onclick=()=>{if(resolution.value.trim().length<3)return renderError('Укажите результат ожидания');run(id,()=>api(`/v1/requests/${id}/holds/${hold.id}/resume`,{method:'POST',body:JSON.stringify({resolution:resolution.value.trim()})}))};
    const controls=el('div','lifeInline');controls.append(resolution,resume);box.appendChild(controls);
  }
  return box;
}
function visitForm(id,data){
  if(!isOffice()||data.active_hold||['CLOSED','CANCELLED'].includes(data.request_status))return null;
  const box=el('div','lifeActionBox');box.append(el('b','','Повторный визит'));
  const when=input('datetime-local');const type=el('select','lifeInput');[['FIELD','Выезд'],['SHOP','В сервисе'],['DELIVERY','Доставка'],['REMOTE','Удалённо']].forEach(([v,l])=>type.appendChild(new Option(l,v)));
  const go=button('Запланировать','');go.onclick=()=>{if(!when.value)return renderError('Укажите дату и время визита');run(id,()=>api(`/v1/requests/${id}/visits`,{method:'POST',body:JSON.stringify({scheduled_at:new Date(when.value).toISOString(),visit_type:type.value})}))};
  box.append(when,type,go);return box;
}
function visitOutcome(id,visit){
  const user=currentUser();const allowed=isOffice()||(isEngineer()&&Number(visit.engineer_id)===Number(user?.id));if(visit.outcome!=='SCHEDULED'||!allowed)return null;
  const wrap=el('div','lifeVisitOutcome');const select=el('select','lifeInput');[['COMPLETED','Выполнен'],['NO_ACCESS','Нет доступа'],['CUSTOMER_NO_SHOW','Клиент отсутствовал'],['REPEAT_REQUIRED','Нужен повторный визит'],['CANCELLED','Отменён']].forEach(([v,l])=>select.appendChild(new Option(l,v)));
  const reason=input('text','Комментарий к результату');const save=button('Зафиксировать','');save.onclick=()=>{if(select.value!=='COMPLETED'&&reason.value.trim().length<3)return renderError('Укажите причину результата');run(id,()=>api(`/v1/requests/${id}/visits/${visit.id}/outcome`,{method:'POST',body:JSON.stringify({outcome:select.value,reason:reason.value.trim()})}))};wrap.append(select,reason,save);return wrap;
}
function reworkForm(id,data){
  if(!isOffice()||data.request_status!=='CLOSED')return null;
  const box=el('div','lifeActionBox');box.append(el('b','','Повторное обращение'));
  const type=el('select','lifeInput');type.appendChild(new Option('Повторный ремонт','REWORK'));if(canWarranty())type.appendChild(new Option('Гарантийная переделка','WARRANTY_REWORK'));
  const reason=input('text','Причина повторного обращения');const when=input('datetime-local');const go=button('Создать связанный заказ','lifePrimary');
  go.onclick=()=>{if(reason.value.trim().length<3)return renderError('Укажите причину повторного обращения');run(id,()=>api(`/v1/requests/${id}/rework`,{method:'POST',body:JSON.stringify({link_type:type.value,reason:reason.value.trim(),scheduled_at:when.value?new Date(when.value).toISOString():null})}))};
  box.append(type,reason,when,go);return box;
}
function returnForm(id,data){
  if(!isOwner()||data.active_hold||['CLOSED','CANCELLED'].includes(data.request_status))return null;
  const d=el('details','lifeReturn');const s=el('summary','','Возврат техники без ремонта');d.appendChild(s);const box=el('div','lifeActionBox');
  const reason=input('text','Причина возврата без ремонта'),doc=input('text','Акт / документ-основание'),handover=input('text','Подтверждение выдачи клиенту');
  const ack=el('label','lifeCheck');const check=document.createElement('input');check.type='checkbox';ack.append(check,document.createTextNode(' Подтверждаю сохранение документированных расходов, если они есть'));
  const go=button('Оформить возврат без ремонта','lifeDanger');go.onclick=()=>{if([reason,doc,handover].some(x=>x.value.trim().length<3))return renderError('Заполните причину, акт и подтверждение выдачи');if(!confirm('Заказ будет документированно отменён и техника отмечена как возвращённая без ремонта. Продолжить?'))return;run(id,()=>api(`/v1/requests/${id}/return-without-repair`,{method:'POST',body:JSON.stringify({reason:reason.value.trim(),document_reference:doc.value.trim(),handover_reference:handover.value.trim(),acknowledge_expenses:check.checked})}))};
  box.append(reason,doc,handover,ack,go);d.appendChild(box);return d;
}
function render(id,data){
  const h=host();if(!h)return;h.replaceChildren();const top=el('div','lifeTop');top.append(el('h3','','Жизненный цикл заказа'),el('small','',data.sla_deadline?'SLA: '+fmt(data.sla_deadline):data.active_hold?'SLA приостановлен':'SLA не задан'));h.appendChild(top);
  const active=activeHoldBox(id,data.active_hold);if(active)h.appendChild(active);
  for(const node of [holdForm(id,data),visitForm(id,data),reworkForm(id,data),returnForm(id,data)])if(node)h.appendChild(node);
  const visits=el('div','lifeSection');visits.append(el('b','','Визиты'));
  if(!data.visits?.length)visits.append(el('p','lifeMuted','Повторных визитов ещё нет.'));else for(const v of data.visits.slice(0,8)){const row=el('div','lifeRow');const info=el('div');info.append(el('strong','',`№${v.attempt_no} · ${outcomeLabels[v.outcome]||v.outcome}`),el('small','',`${fmt(v.scheduled_at)}${v.engineer_name?' · '+v.engineer_name:''}${v.reason?' · '+v.reason:''}`));row.appendChild(info);const outcome=visitOutcome(id,v);if(outcome)row.appendChild(outcome);visits.appendChild(row)}h.appendChild(visits);
  const links=[...(data.parent_links||[]),...(data.links||[])];const related=el('div','lifeSection');related.append(el('b','','Связанные ремонты'));if(!links.length)related.append(el('p','lifeMuted','Связанных повторных заказов нет.'));else for(const l of links){related.append(el('div','lifeRow',`${l.link_type==='WARRANTY_REWORK'?'Гарантия':'Повторный ремонт'} · ${l.parent_number||l.child_number||''} · ${l.parent_status||l.child_status||''}`))}h.appendChild(related);
  if(data.return_without_repair){const rr=el('div','lifeReturned');rr.append(el('strong','','Техника возвращена без ремонта'),el('small','',`${data.return_without_repair.document_reference} · ${data.return_without_repair.handover_reference}`));h.appendChild(rr)}
  renderError('');
}
async function load(id=currentId,force=false){id=Number(id||window.Profi24O360State?.id||0);if(!id||loading||!root())return;if(!force&&id===currentId&&host()?.dataset.loaded==='1')return;currentId=id;loading=true;try{const data=await api(`/v1/requests/${id}/lifecycle`);render(id,data);host().dataset.loaded='1'}catch(e){const h=host();if(h){h.replaceChildren(el('div','lifeError',e.message));h.dataset.loaded='1'}}finally{loading=false}}
function refresh(id){const h=host();if(h)h.dataset.loaded='0';setTimeout(()=>load(id||currentId,true),40)}
window.addEventListener('profi24:o360-current',e=>{currentId=Number(e.detail?.id||0);refresh(currentId)});
window.addEventListener('profi24:request-updated',e=>{if(!e.detail?.id||Number(e.detail.id)===Number(currentId))refresh(currentId)});
window.addEventListener('profi24:rbac-ready',()=>refresh(currentId));
let timer;new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(()=>{if(root())load(window.Profi24O360State?.id||currentId)},80)}).observe(document.body,{childList:true,subtree:true});
