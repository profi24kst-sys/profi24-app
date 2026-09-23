import React,{useEffect,useState} from 'react';
import {ChevronLeft,ChevronRight,Download,Search} from 'lucide-react';
import './directory-pages.css';

const BASE=(import.meta.env.VITE_API_URL||'/api/v1').replace(/\/$/,'')+'/directory';
const EXPORT_ROLES=new Set(['OWNER','SUPERVISOR','ACCOUNTANT','MANAGER']);
const TABS=[
  ['ACTIVE','Активные','active'],['NEW','Новые','new'],['PART','Ждут деталь','part'],
  ['PAY','К оплате','pay'],['OVERDUE','Просроченные','overdue'],
  ['CLOSED','Закрытые','closed'],['ALL','Все','total']
];
const LABELS={
  NEW:'Новая',ASSIGNED:'Назначена',ACCEPTED:'Принята',DIAGNOSTICS:'Диагностика',
  APPROVAL_REQUIRED:'Согласование',WAITING_PART:'Ждет деталь',REPAIR:'Ремонт',
  TESTING:'Проверка',PAYMENT_REQUIRED:'К оплате',CLOSED:'Закрыта',CANCELLED:'Отменена'
};
const money=n=>new Intl.NumberFormat('ru-KZ').format(Number(n||0))+' ₸';
const date=value=>value?new Date(value).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
const overdue=row=>row.sla_deadline&&new Date(row.sla_deadline)<new Date()&&!['CLOSED','CANCELLED'].includes(row.status);

function params(object){
  const query=new URLSearchParams();
  Object.entries(object).forEach(([name,value])=>{if(value!=null&&value!=='')query.set(name,String(value))});
  return query.toString();
}
async function read(path,signal){
  const token=localStorage.getItem('token');
  const response=await fetch(BASE+path,{signal,headers:token?{Authorization:'Bearer '+token}:{}});
  const body=await response.json();
  if(!response.ok)throw new Error(body.error?.message||'Не удалось загрузить список');
  return body;
}
async function download(kind,filter){
  const token=localStorage.getItem('token'),query=params(filter);
  const response=await fetch(BASE+'/'+kind+'/export?'+query,{
    headers:token?{Authorization:'Bearer '+token}:{},cache:'no-store'
  });
  if(!response.ok){
    let detail;
    try{detail=(await response.json()).error?.message}catch{}
    throw new Error(detail||'Не удалось выгрузить Excel');
  }
  const blob=await response.blob();
  const href=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=href;
  link.download='PROFI24-'+kind+'-'+new Date().toISOString().slice(0,10)+'.xlsx';
  document.body.appendChild(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(href),30000);
}
function useDirectory(kind,filter,refreshKey=0){
  const [state,setState]=useState({rows:[],meta:{page:1,total:0,pages:0,counts:{}},loading:true,error:''});
  useEffect(()=>{
    let mounted=true;
    const controller=new AbortController();
    setState(previous=>({...previous,loading:true,error:''}));
    read('/'+kind+'?'+params(filter),controller.signal).then(body=>{
      if(mounted)setState({rows:body.data||[],meta:body.meta||{page:1,total:0,pages:0,counts:{}},loading:false,error:''});
    }).catch(error=>{
      if(mounted&&error.name!=='AbortError')setState(previous=>({...previous,loading:false,error:error.message}));
    });
    return()=>{mounted=false;controller.abort()};
  },[kind,filter.search,filter.status,filter.page,filter.limit,filter.month,filter.focus_id,refreshKey]);
  return state;
}
function Pagination({meta,limit,onPage,onLimit,loading}){
  const total=Number(meta.total)||0,page=Number(meta.page)||1,pages=Number(meta.pages)||0;
  const first=total?(page-1)*limit+1:0,last=Math.min(total,page*limit);
  return <div className="dir-pagination" aria-live="polite">
    <span>{total?first+'–'+last+' из '+total:'Нет записей'}{loading?' · Обновление…':''}</span>
    <label>Строк <select value={limit} onChange={e=>onLimit(Number(e.target.value))}>
      {[25,50,100].map(value=><option key={value} value={value}>{value}</option>)}
    </select></label>
    <div className="dir-page-controls">
      <button type="button" onClick={()=>onPage(page-1)} disabled={loading||page<=1} aria-label="Предыдущая страница"><ChevronLeft size={17}/></button>
      <span>Стр. {page} / {Math.max(1,pages)}</span>
      <button type="button" onClick={()=>onPage(page+1)} disabled={loading||page>=pages} aria-label="Следующая страница"><ChevronRight size={17}/></button>
    </div>
  </div>;
}
function ExportButton({kind,filter}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  return <div className="dir-export">
    <button type="button" disabled={busy} className="dir-export-btn" onClick={async()=>{
      setBusy(true);setError('');
      try{await download(kind,filter)}catch(problem){setError(problem.message)}finally{setBusy(false)}
    }}><Download size={16}/>{busy?'Формирование…':'Excel (.xlsx)'}</button>
    {error&&<small className="dir-inline-error" role="alert">{error}</small>}
  </div>;
}
function SearchBox({value,onChange,placeholder}){
  return <div className="search"><Search size={18}/><input value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} aria-label="Поиск по списку"/></div>;
}
function useSearch(){
  const [draft,setDraft]=useState(''),[search,setSearch]=useState('');
  useEffect(()=>{
    const timer=setTimeout(()=>setSearch(draft.trim()),320);
    return()=>clearTimeout(timer);
  },[draft]);
  return{draft,setDraft,search};
}
export function OrdersDirectory({open,user,refreshKey=0}){
  const [updates,setUpdates]=useState(0);
  useEffect(()=>{const refresh=()=>setUpdates(x=>x+1);window.addEventListener('profi24:request-updated',refresh);return()=>window.removeEventListener('profi24:request-updated',refresh)},[]);
  const {draft,setDraft,search}=useSearch();
  const [status,setStatus]=useState('ACTIVE'),[page,setPage]=useState(1),[limit,setLimit]=useState(25);
  useEffect(()=>setPage(1),[search,status,limit]);
  const filter={search,status,page,limit},state=useDirectory('orders',filter,refreshKey+updates);
  const counts=state.meta.counts||{},exportable=EXPORT_ROLES.has(user?.role);
  return <>
    <div className="toolbar dir-toolbar"><SearchBox value={draft} onChange={setDraft} placeholder="Номер, клиент, телефон, техника, мастер…"/>
      <div className="dir-tools"><span>Найдено: <b>{state.meta.total||0}</b></span>{exportable&&<ExportButton kind="orders" filter={{search,status}}/>}</div>
    </div>
    <div className="tabs" role="tablist" aria-label="Статусы заказов">
      {TABS.map(([key,label,count])=><button type="button" role="tab" aria-selected={status===key} className={status===key?'on':''}
        onClick={()=>{setStatus(key);setPage(1)}} key={key}>{label} <small>{counts[count]??0}</small></button>)}
    </div>
    {state.error&&<div className="errorbox" role="alert">{state.error}</div>}
    <section className="table" aria-busy={state.loading}>
      <div className="thead"><span>№ / дата</span><span>Клиент и техника</span><span>Неисправность</span><span>Ответственный</span><span>Статус</span><span>Сумма</span></div>
      {state.rows.length?state.rows.map(order=><div key={order.id} role="button" tabIndex={0}
        className={'trow'+(overdue(order)?' slaOverdue':'')}
        onClick={()=>open(order.id)}
        onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open(order.id)}}}>
        <div><b>{order.number}</b><small>{date(order.created_at)}</small></div>
        <div><b>{order.customer_name}</b><small>{order.phone} · {[order.brand,order.model||order.category].filter(Boolean).join(' ')}</small></div>
        <div className="ellipsis" title={order.complaint||''}>{order.complaint}</div>
        <div><b>{order.engineer_name||'Не назначен'}</b><small>{overdue(order)?'SLA просрочен':order.scheduled_at?'Выезд '+date(order.scheduled_at):'Без времени'}</small></div>
        <span className={'pill '+order.status}>{LABELS[order.status]||order.status}</span>
        <b className="right">{money(order.total)}</b>
      </div>):<div className="empty">{state.loading?'Загрузка заказов…':'По выбранным фильтрам заказов нет'}</div>}
    </section>
    <Pagination meta={state.meta} limit={limit} onPage={setPage} onLimit={value=>{setLimit(value);setPage(1)}} loading={state.loading}/>
  </>;
}
export function CustomersDirectory({user,refreshKey=0,focusCustomer=null}){
  const [updates,setUpdates]=useState(0);
  useEffect(()=>{const refresh=()=>setUpdates(x=>x+1);window.addEventListener('profi24:request-updated',refresh);return()=>window.removeEventListener('profi24:request-updated',refresh)},[]);
  const {draft,setDraft,search}=useSearch();
  const [page,setPage]=useState(1),[limit,setLimit]=useState(25);
  const [focus,setFocus]=useState(focusCustomer);
  useEffect(()=>{setFocus(focusCustomer);if(focusCustomer)setPage(1)},[focusCustomer?.id]);
  useEffect(()=>setPage(1),[search,limit]);
  const filter={search:focus?'':search,focus_id:focus?.id,page,limit},state=useDirectory('customers',filter,refreshKey+updates),exportable=EXPORT_ROLES.has(user?.role);
  useEffect(()=>{
    if(!focus||state.loading||!state.rows.some(x=>String(x.id)===String(focus.id)))return;
    const row=document.querySelector('[data-search-record="customers-'+focus.id+'"]');
    if(!row)return;
    row.scrollIntoView({behavior:'smooth',block:'center'});
    row.classList.add('searchHit');row.focus({preventScroll:true});
    const timeout=setTimeout(()=>row.classList.remove('searchHit'),2200);
    return()=>clearTimeout(timeout);
  },[focus?.id,state.loading,state.rows]);
  return <>
    <div className="toolbar dir-toolbar"><SearchBox value={draft} onChange={value=>{setFocus(null);setDraft(value);setPage(1)}} placeholder="Имя, телефон или электронная почта"/>
      <div className="dir-tools"><span>Клиентов: <b>{state.meta.total||0}</b></span>{exportable&&<ExportButton kind="customers" filter={focus?{focus_id:focus.id}:{search}}/>}</div>
    </div>
    {focus&&<div className="dir-focus">Выбранный клиент: <b>{focus.title||focus.name||'#'+focus.id}</b><button type="button" onClick={()=>{setFocus(null);setDraft('');setPage(1)}}>Показать всех</button></div>}
    {state.error&&<div className="errorbox" role="alert">{state.error}</div>}
    <section className="table" aria-busy={state.loading}>
      {state.rows.length?state.rows.map(customer=><div className="simple dir-customer" key={customer.id}
        data-search-record={'customers-'+customer.id} tabIndex="-1">
        <div><b>{customer.name}</b><small>{customer.address||'Адрес не указан'}</small></div>
        <b>{customer.phone}</b><span>{customer.request_count||0} заказов</span>
        <b>{customer.lifetime_paid==null?'—':money(customer.lifetime_paid)}</b>
      </div>):<div className="empty">{state.loading?'Загрузка клиентов…':'Клиентов по запросу нет'}</div>}
    </section>
    <Pagination meta={state.meta} limit={limit} onPage={setPage} onLimit={value=>{setLimit(value);setPage(1)}} loading={state.loading}/>
  </>;
}
function localMonth(){
  return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Qostanay',year:'numeric',month:'2-digit'}).format(new Date());
}
export function ReportExports({user}){
  const [month,setMonth]=useState(localMonth());
  if(!EXPORT_ROLES.has(user?.role))return null;
  return <section className="dir-report-box">
    <div><h2>Выгрузка данных в Excel</h2><p>Все строки за выбранный месяц, независимо от количества страниц. Учитываются права доступа к филиалам.</p></div>
    <label>Месяц <input type="month" min="2023-01" value={month} onChange={e=>setMonth(e.target.value)}/></label>
    <div className="dir-report-actions"><ExportButton kind="orders" filter={{status:'ALL',month}}/><ExportButton kind="customers" filter={{month}}/></div>
    <small>Не более 10 000 строк в одном файле. Для более крупных выгрузок выберите меньший период.</small>
  </section>;
}
