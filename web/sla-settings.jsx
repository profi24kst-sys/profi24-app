import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import './order-form-admin.css';

async function api(path='',options={}){
 const response=await fetch('/api/v1/sla/policies'+path,{...options,headers:{'Content-Type':'application/json',Authorization:'Bearer '+localStorage.token}});
 const payload=await response.json();
 if(!response.ok)throw new Error(payload.error?.message||'Ошибка настроек SLA');
 return payload.data;
}
const typeNames={REPAIR:'Обычный ремонт',FIELD:'Выездной ремонт',PAID_WORKSHOP:'Стационарный ремонт'};
function Settings(){
 const [open,setOpen]=useState(false),[rows,setRows]=useState([]),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{
  const register=()=>window.Profi24UI?.registerNav({id:'sla-settings',label:'Сроки SLA',group:'analytics',roles:['OWNER','SUPERVISOR'],onClick:()=>setOpen(true)});
  if(window.Profi24UI)register();else window.addEventListener('profi24:core-ui-ready',register,{once:true});
  return()=>{window.removeEventListener('profi24:core-ui-ready',register);window.Profi24UI?.removeNav?.('sla-settings')};
 },[]);
 useEffect(()=>{let live=true;if(open){setRows([]);setError('');setNotice('');api().then(data=>{if(live)setRows(data)}).catch(e=>{if(live)setError(e.message)})}return()=>{live=false}},[open]);
 async function save(row){
  setBusy(true);setError('');setNotice('');
  try{await api('/'+row.order_type+'/'+row.priority,{method:'PUT',body:JSON.stringify({reaction_minutes:Number(row.reaction_minutes),execution_minutes:Number(row.execution_minutes)})});setNotice('Сроки сохранены. Они применяются к новым заказам.')}catch(e){setError(e.message)}finally{setBusy(false)}
 }
 if(!open)return null;
 return <div className="ofsLayer"><div className="ofsPanel" role="dialog" aria-label="Сроки SLA"><header><h1>Сроки SLA</h1><button onClick={()=>setOpen(false)}>Закрыть</button></header>
  <p>Реакция — от создания до принятия заказа. Выполнение — от принятия до завершения проверки и перехода к оплате. Сроки указаны в календарных минутах; ожидание с паузой SLA исключается. Настройки применяются только к новым заказам.</p>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <div className="ofsScroll"><table><thead><tr><th>Тип заказа</th><th>Приоритет</th><th>Реакция, мин</th><th>Выполнение, мин</th><th></th></tr></thead><tbody>{rows.map((row,i)=><tr key={row.order_type+row.priority}><td>{typeNames[row.order_type]}</td><td>{row.priority==='CRITICAL'?'Критический':'Обычный'}</td>{['reaction_minutes','execution_minutes'].map(field=><td key={field}><input aria-label={`${row.order_type} ${row.priority} ${field}`} type="number" min="1" max="525600" step="1" disabled={busy} value={row[field]} onChange={e=>setRows(current=>current.map((r,j)=>j===i?{...r,[field]:e.target.value}:r))}/></td>)}<td><button disabled={busy} onClick={()=>save(row)}>Сохранить</button></td></tr>)}</tbody></table></div>
 </div></div>;
}
const host=document.createElement('div');document.body.appendChild(host);createRoot(host).render(<Settings/>);
