import React,{useEffect,useState} from 'react';
export const DEFAULT_COLUMNS=['number','customer','complaint','engineer','status','total'];
export const COLUMN_LABELS={number:'№ / дата',customer:'Клиент и техника',complaint:'Неисправность',engineer:'Ответственный',status:'Статус',total:'Сумма'};
const BASE=(import.meta.env.VITE_API_URL||'/api/v1').replace(/\/$/,'')+'/directory';
async function call(path,method='GET',body,signal){
 const response=await fetch(BASE+path,{method,signal,headers:{Authorization:'Bearer '+localStorage.token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const data=await response.json();if(!response.ok)throw Error(data.error?.message||'Не удалось сохранить настройки');return data;
}
export function OrderViewControls({user,filters,onFilter,onApply,columns,onColumns,onFields}){
 const [views,setViews]=useState([]),[meta,setMeta]=useState({}),[ready,setReady]=useState(false),[name,setName]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{
  const controller=new AbortController();setReady(false);setBusy(false);setName('');setViews([]);setMeta({});setError('');setNotice('');onColumns(DEFAULT_COLUMNS);onFields([]);
  call('/order-views','GET',null,controller.signal).then(body=>{if(controller.signal.aborted)return;setViews(body.data||[]);setMeta(body.meta||{});onColumns(body.meta?.columns||DEFAULT_COLUMNS);onFields(body.meta?.fields||[]);setReady(true)}).catch(e=>{if(e.name!=='AbortError')setError(e.message)});
  return()=>controller.abort();
 },[user?.id,localStorage.token]);
 async function mutate(operation,success){const token=localStorage.token;setBusy(true);setError('');setNotice('');try{await operation();if(token===localStorage.token)setNotice(success)}catch(e){if(token===localStorage.token)setError(e.message)}finally{if(token===localStorage.token)setBusy(false)}}
 const all=[...DEFAULT_COLUMNS,...(meta.fields||[]).map(f=>'custom:'+f.code)],label=code=>COLUMN_LABELS[code]||(meta.fields||[]).find(f=>'custom:'+f.code===code)?.label||code;
 return <section className="dir-views" aria-label="Представления заказов">
  <div className="dir-view-filters">
   <label><input type="checkbox" checked={!!filters.only_mine} onChange={e=>onFilter('only_mine',e.target.checked)}/>Мои заказы</label>
   <label>Бренд <select aria-label="Фильтр по бренду" value={filters.brand||''} onChange={e=>onFilter('brand',e.target.value)}><option value="">Все бренды</option>{(meta.brands||[]).map(b=><option key={b}>{b}</option>)}</select></label>
   <label>Тип <select aria-label="Фильтр по типу заказа" value={filters.order_type||''} onChange={e=>onFilter('order_type',e.target.value)}><option value="">Все типы</option>{[['REPAIR','Ремонт'],['FIELD','Выездной'],['PAID_WORKSHOP','Стационар'],['SALE','Продажа'],['PARTS','Запчасти']].map(([k,v])=><option value={k} key={k}>{v}</option>)}</select></label>
   <label>Исполнитель <select aria-label="Фильтр по исполнителю" value={filters.engineer_id||''} onChange={e=>onFilter('engineer_id',e.target.value?Number(e.target.value):null)}><option value="">Все исполнители</option>{(meta.engineers||[]).map(e=><option value={e.id} key={e.id}>{e.name}</option>)}</select></label>
   <label>Контракт <select aria-label="Фильтр по контракту" value={filters.contract_id||''} onChange={e=>onFilter('contract_id',e.target.value?Number(e.target.value):null)}><option value="">Все контракты</option>{(meta.contracts||[]).map(c=><option value={c.id} key={c.id}>{c.number}</option>)}</select></label>
   <button type="button" onClick={()=>onApply({status:'ACTIVE',search:''})}>Сбросить фильтры</button>
  </div>
  <div className="dir-saved-tabs" aria-label="Сохранённые представления">{views.map(view=><span key={view.id}><button type="button" onClick={()=>onApply(view.filters)}>{view.name}</button><button type="button" aria-label={'Удалить представление '+view.name} disabled={busy} onClick={()=>mutate(async()=>{const session=localStorage.token;await call('/order-views/'+view.id,'DELETE');if(session!==localStorage.token)return;setViews(current=>current.filter(v=>v.id!==view.id))},'Представление удалено')}>×</button></span>)}</div>
  <div className="dir-view-save"><input aria-label="Название представления" maxLength={60} value={name} onChange={e=>setName(e.target.value)} placeholder="Например: BOSCH — ждут деталь"/><button type="button" disabled={!ready||busy||!name.trim()} onClick={()=>mutate(async()=>{const session=localStorage.token;const saved=await call('/order-views','POST',{name:name.trim(),filters});if(session!==localStorage.token)return;setViews(current=>[...current,saved.data]);setName('')},'Представление сохранено')}>Сохранить представление</button>
   <details><summary>Колонки списка</summary><div className="dir-column-picker">{all.map(code=><label key={code}><input type="checkbox" checked={columns.includes(code)} disabled={code==='number'} onChange={e=>onColumns(e.target.checked?[...columns,code]:columns.filter(c=>c!==code))}/>{label(code)}</label>)}
   <ol>{columns.map((code,i)=><li key={code}>{label(code)} <button type="button" aria-label={'Поднять колонку '+label(code)} disabled={i===0} onClick={()=>{const next=[...columns];[next[i-1],next[i]]=[next[i],next[i-1]];onColumns(next)}}>↑</button><button type="button" aria-label={'Опустить колонку '+label(code)} disabled={i===columns.length-1} onClick={()=>{const next=[...columns];[next[i+1],next[i]]=[next[i],next[i+1]];onColumns(next)}}>↓</button></li>)}</ol>
   <button type="button" disabled={!ready||busy} onClick={()=>mutate(()=>call('/order-columns','PUT',{columns}),'Колонки сохранены')}>Сохранить колонки</button></div></details>
  </div>{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
 </section>;
}
