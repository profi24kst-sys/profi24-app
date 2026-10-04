import React,{useEffect,useState} from 'react';
export const DEFAULT_COLUMNS=['number','customer','complaint','engineer','status','total'];
export const COLUMN_LABELS={number:'№ / дата',customer:'Клиент и техника',complaint:'Неисправность',engineer:'Ответственный',status:'Статус',total:'Сумма'};
const BASE=(import.meta.env.VITE_API_URL||'/api/v1').replace(/\/$/,'')+'/directory';
async function call(path,method='GET',body,signal){
 const response=await fetch(BASE+path,{method,signal,headers:{Authorization:'Bearer '+localStorage.token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const data=await response.json();if(!response.ok)throw Error(data.error?.message||'Не удалось сохранить настройки');return data;
}
export function OrderViewControls({user,filters,onFilter,onApply,columns,onColumns,onFields}){
 const [views,setViews]=useState([]),[meta,setMeta]=useState({}),[ready,setReady]=useState(false),[name,setName]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[attempt,setAttempt]=useState(0);
 useEffect(()=>{
  const controller=new AbortController();setReady(false);setBusy(false);setName('');setViews([]);setMeta({});setError('');setNotice('');onColumns(DEFAULT_COLUMNS);onFields([]);
  call('/order-views','GET',null,controller.signal).then(body=>{if(controller.signal.aborted)return;setViews(body.data||[]);setMeta(body.meta||{});onColumns(body.meta?.columns||DEFAULT_COLUMNS);onFields(body.meta?.fields||[]);setReady(true)}).catch(e=>{if(e.name!=='AbortError')setError(e.message)});
  return()=>controller.abort();
 },[user?.id,localStorage.token,attempt]);
 async function mutate(operation,success){const token=localStorage.token;setBusy(true);setError('');setNotice('');try{await operation();if(token===localStorage.token)setNotice(success)}catch(e){if(token===localStorage.token)setError(e.message)}finally{if(token===localStorage.token)setBusy(false)}}
 const all=[...DEFAULT_COLUMNS,...(meta.fields||[]).map(f=>'custom:'+f.code)],label=code=>COLUMN_LABELS[code]||(meta.fields||[]).find(f=>'custom:'+f.code===code)?.label||code;
 const types=[['REPAIR','Ремонт'],['FIELD','Выездной'],['PAID_WORKSHOP','Стационар'],['SALE','Продажа'],['PARTS','Запчасти']];
 const chips=[
  filters.only_mine&&['only_mine','Мои заказы',false],
  filters.brand&&['brand','Бренд: '+filters.brand,''],
  filters.order_type&&['order_type','Тип: '+(types.find(([id])=>id===filters.order_type)?.[1]||filters.order_type),''],
  filters.engineer_id&&['engineer_id','Исполнитель: '+((meta.engineers||[]).find(e=>e.id===filters.engineer_id)?.name||'#'+filters.engineer_id),null],
  filters.contract_id&&['contract_id','Контракт: '+((meta.contracts||[]).find(c=>c.id===filters.contract_id)?.number||'#'+filters.contract_id),null]
 ].filter(Boolean);
 function quickGroup(title,options,value,onSelect){return <div className="dir-quick-group" role="group" aria-label={title}><span>{title}</span><div className="dir-quick-scroll">{options.map(([key,text])=><button type="button" key={key} aria-pressed={String(value||'')===String(key)} onClick={()=>onSelect(key)}>{text}</button>)}</div></div>}
 return <section className="dir-views" aria-label="Представления заказов">
  {quickGroup('Бренды',[['','Все бренды'],...(meta.brands||[]).map(b=>[b,b])],filters.brand,value=>onFilter('brand',value))}
  {quickGroup('Исполнители',[['','Все исполнители'],...(meta.engineers||[]).map(e=>[e.id,e.name])],filters.engineer_id,value=>onFilter('engineer_id',value?Number(value):null))}
  {views.length>0&&<div className="dir-quick-group" role="group" aria-label="Сохранённые представления"><span>Мои списки</span><div className="dir-quick-scroll">{views.map(view=><button type="button" key={view.id} onClick={()=>onApply(view.filters)}>{view.name}</button>)}</div></div>}
  <div className="dir-view-actions">
   <button type="button" aria-pressed={!!filters.only_mine} onClick={()=>onFilter('only_mine',!filters.only_mine)}>Мои заказы</button>
   <button type="button" onClick={()=>onApply({status:'ACTIVE',search:''})}>Сбросить фильтры</button>
  </div>
  {chips.length>0&&<div className="dir-filter-chips" aria-label="Применённые фильтры">{chips.map(([key,text,reset])=><button type="button" key={key} aria-label={'Убрать фильтр '+text} onClick={()=>onFilter(key,reset)}>{text}<span aria-hidden="true"> ×</span></button>)}</div>}
  <details className="dir-filter-details"><summary>Все фильтры{chips.length?' · '+chips.length:''}</summary>
  <div className="dir-view-filters">
   <label><input type="checkbox" checked={!!filters.only_mine} onChange={e=>onFilter('only_mine',e.target.checked)}/>Мои заказы</label>
   <label>Бренд <select aria-label="Фильтр по бренду" value={filters.brand||''} onChange={e=>onFilter('brand',e.target.value)}><option value="">Все бренды</option>{(meta.brands||[]).map(b=><option key={b}>{b}</option>)}</select></label>
   <label>Тип <select aria-label="Фильтр по типу заказа" value={filters.order_type||''} onChange={e=>onFilter('order_type',e.target.value)}><option value="">Все типы</option>{types.map(([k,v])=><option value={k} key={k}>{v}</option>)}</select></label>
   <label>Исполнитель <select aria-label="Фильтр по исполнителю" value={filters.engineer_id||''} onChange={e=>onFilter('engineer_id',e.target.value?Number(e.target.value):null)}><option value="">Все исполнители</option>{(meta.engineers||[]).map(e=><option value={e.id} key={e.id}>{e.name}</option>)}</select></label>
   <label>Контракт <select aria-label="Фильтр по контракту" value={filters.contract_id||''} onChange={e=>onFilter('contract_id',e.target.value?Number(e.target.value):null)}><option value="">Все контракты</option>{(meta.contracts||[]).map(c=><option value={c.id} key={c.id}>{c.number}</option>)}</select></label>
  </div>
  </details>
  <details className="dir-manage-views"><summary>Сохранить и настроить список</summary>
  <div className="dir-saved-tabs">{views.map(view=><span key={view.id}>{view.name}<button type="button" aria-label={'Удалить представление '+view.name} disabled={busy} onClick={()=>mutate(async()=>{const session=localStorage.token;await call('/order-views/'+view.id,'DELETE');if(session!==localStorage.token)return;setViews(current=>current.filter(v=>v.id!==view.id))},'Представление удалено')}>×</button></span>)}</div>
  <div className="dir-view-save"><input aria-label="Название представления" maxLength={60} value={name} onChange={e=>setName(e.target.value)} placeholder="Например: BOSCH — ждут деталь"/><button type="button" disabled={!ready||busy||!name.trim()} onClick={()=>mutate(async()=>{const session=localStorage.token;const saved=await call('/order-views','POST',{name:name.trim(),filters});if(session!==localStorage.token)return;setViews(current=>[...current,saved.data]);setName('')},'Представление сохранено')}>Сохранить представление</button>
   <details><summary>Колонки списка</summary><div className="dir-column-picker">{all.map(code=><label key={code}><input type="checkbox" checked={columns.includes(code)} disabled={code==='number'} onChange={e=>onColumns(e.target.checked?[...columns,code]:columns.filter(c=>c!==code))}/>{label(code)}</label>)}
   <ol>{columns.map((code,i)=><li key={code}>{label(code)} <button type="button" aria-label={'Поднять колонку '+label(code)} disabled={i===0} onClick={()=>{const next=[...columns];[next[i-1],next[i]]=[next[i],next[i-1]];onColumns(next)}}>↑</button><button type="button" aria-label={'Опустить колонку '+label(code)} disabled={i===columns.length-1} onClick={()=>{const next=[...columns];[next[i+1],next[i]]=[next[i],next[i+1]];onColumns(next)}}>↓</button></li>)}</ol>
   <button type="button" disabled={!ready||busy} onClick={()=>mutate(()=>call('/order-columns','PUT',{columns}),'Колонки сохранены')}>Сохранить колонки</button></div></details>
  </div></details>{!ready&&!error&&<p role="status">Загрузка личных списков…</p>}{error&&<p role="alert">{error}{!ready&&<button type="button" onClick={()=>setAttempt(value=>value+1)}>Повторить загрузку списков</button>}</p>}{notice&&<p role="status">{notice}</p>}
 </section>;
}
