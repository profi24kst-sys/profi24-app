
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import './order-form-admin.css';
const endpoint='/api/v1/order-form';
const token=()=>localStorage.token;
async function api(url,options={}){
 const response=await fetch(endpoint+url,{...options,headers:{'Content-Type':'application/json',Authorization:'Bearer '+token()}});
 const payload=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(payload.error?.message||'Ошибка загрузки настроек');
 return payload.data;
}
const types=[['TEXT','Одна строка'],['TEXTAREA','Многострочное'],['NUMBER','Число'],['DATE','Дата'],['IMEI','IMEI (15 цифр)'],['SELECT','Справочник']];
const empty={code:'',label:'',field_type:'TEXT',required:false,sort_order:0,dictionary_id:''};
function OrderFormSettings(){
 const[open,setOpen]=useState(false),[fields,setFields]=useState([]),[dictionaries,setDictionaries]=useState([]),[items,setItems]=useState([]),[chosenDict,setChosenDict]=useState(''),[dictionary,setDictionary]=useState({code:'',label:''}),[item,setItem]=useState(''),[field,setField]=useState(empty),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const owner=()=>{try{return JSON.parse(localStorage.user||'null')?.role==='OWNER'}catch{return false}};
 async function refresh(){
  const [f,d]=await Promise.all([api('/fields'),api('/dictionaries')]);setFields(f||[]);setDictionaries(d||[]);
 }
 useEffect(()=>{
  const register=()=>window.Profi24UI?.registerNav({id:'order-form-settings',label:'Поля приёмки',group:'analytics',roles:['OWNER'],onClick:()=>{if(owner())setOpen(true)}});
  if(window.Profi24UI)register();else window.addEventListener('profi24:core-ui-ready',register,{once:true});
  return()=>{window.removeEventListener('profi24:core-ui-ready',register);window.Profi24UI?.removeNav?.('order-form-settings')}
 },[]);
 useEffect(()=>{if(open&&owner())refresh().catch(e=>setError(e.message))},[open]);
 useEffect(()=>{if(open&&chosenDict)api('/dictionaries/'+chosenDict+'/items').then(setItems).catch(e=>setError(e.message));else setItems([])},[open,chosenDict]);
 async function mutate(action,success){
  setBusy(true);setError('');setNotice('');
  try{await action();await refresh();setNotice(success)}catch(e){setError(e.message)}finally{setBusy(false)}
 }
 async function saveDictionary(){
  await mutate(()=>api('/dictionaries',{method:'POST',body:JSON.stringify(dictionary)}),'Справочник создан');
  setDictionary({code:'',label:''});
 }
 async function saveItem(){
  if(!chosenDict)return setError('Выберите справочник');
  await mutate(()=>api('/dictionaries/'+chosenDict+'/items',{method:'POST',body:JSON.stringify({value:item.trim()})}),'Значение добавлено');
  setItem('');setItems(await api('/dictionaries/'+chosenDict+'/items'));
 }
 async function saveField(){
  await mutate(()=>api('/fields',{method:'POST',body:JSON.stringify({...field,dictionary_id:field.field_type==='SELECT'?Number(field.dictionary_id):null,sort_order:Number(field.sort_order||0),order_types:['REPAIR']})}),'Поле добавлено в форму приёмки');
  setField(empty);
 }
 async function toggleField(f,key,value){await mutate(()=>api('/fields/'+f.id,{method:'PATCH',body:JSON.stringify({[key]:value})}),'Настройки обновлены')}
 if(!open||!owner())return null;
 return <div className="ofsLayer" role="dialog" aria-modal="true" aria-label="Настройки формы приёмки">
 <div className="ofsPanel">
  <header><div><h1>Поля приёмки</h1><p>Создавайте дополнительные поля ремонта без изменений программы</p></div><button onClick={()=>setOpen(false)} aria-label="Закрыть">✕</button></header>
  {error&&<p className="ofsError" role="alert">{error}</p>}
  {notice&&<p className="ofsSuccess" role="status">{notice}</p>}
  <div className="ofsGrid">
   <section><h2>Справочники</h2><p>Для полей с выпадающим списком</p>
    <form onSubmit={e=>{e.preventDefault();saveDictionary()}}>
     <label>Код (латинские буквы)<input required pattern="[a-z][a-z0-9_]{1,49}" value={dictionary.code} onChange={e=>setDictionary(v=>({...v,code:e.target.value}))}/></label>
     <label>Название<input required maxLength={120} value={dictionary.label} onChange={e=>setDictionary(v=>({...v,label:e.target.value}))}/></label>
     <button type="submit" disabled={busy}>Создать справочник</button>
    </form>
    <label>Добавить значение в справочник<select value={chosenDict} onChange={e=>setChosenDict(e.target.value)}><option value="">Выберите справочник</option>{dictionaries.filter(x=>x.active).map(d=><option key={d.id} value={d.id}>{d.label}</option>)}</select></label>
    {chosenDict&&<><form onSubmit={e=>{e.preventDefault();saveItem()}}><label>Новое значение<input required maxLength={160} value={item} onChange={e=>setItem(e.target.value)}/></label><button disabled={busy}>Добавить</button></form><p>Значения: {items.map(i=>i.value).join(', ')||'Пока пусто'}</p></>}
   </section>
   <section><h2>Новое поле заказа</h2>
    <form onSubmit={e=>{e.preventDefault();saveField()}}>
     <label>Код<input required pattern="[a-z][a-z0-9_]{1,49}" value={field.code} onChange={e=>setField(v=>({...v,code:e.target.value}))} placeholder="external_condition"/></label>
     <label>Название<input required maxLength={120} value={field.label} onChange={e=>setField(v=>({...v,label:e.target.value}))} placeholder="Внешний вид"/></label>
     <label>Тип<select value={field.field_type} onChange={e=>setField(v=>({...v,field_type:e.target.value,dictionary_id:''}))}>{types.map(([code,label])=><option value={code} key={code}>{label}</option>)}</select></label>
     {field.field_type==='SELECT'&&<label>Справочник<select required value={field.dictionary_id} onChange={e=>setField(v=>({...v,dictionary_id:e.target.value}))}><option value="">Выберите</option>{dictionaries.filter(d=>d.active).map(d=><option value={d.id} key={d.id}>{d.label}</option>)}</select></label>}
     <label>Порядок<input type="number" min="-100000" max="100000" value={field.sort_order} onChange={e=>setField(v=>({...v,sort_order:e.target.value}))}/></label>
     <label className="ofsCheck"><input type="checkbox" checked={field.required} onChange={e=>setField(v=>({...v,required:e.target.checked}))}/> Обязательное</label>
     <button disabled={busy}>Добавить поле</button>
    </form>
   </section>
  </div>
  <section><h2>Поля формы ремонта</h2>
   <div className="ofsScroll"><table><thead><tr><th>Порядок</th><th>Код</th><th>Название</th><th>Тип</th><th>Обязательное</th><th>Активно</th></tr></thead><tbody>
    {fields.map(f=><tr key={f.id}><td><input type="number" aria-label={'Порядок '+f.code} defaultValue={f.sort_order} onBlur={e=>Number(e.target.value)!==f.sort_order&&toggleField(f,'sort_order',Number(e.target.value))} style={{width:74}}/></td>
     <td>{f.code}</td><td>{f.label}</td><td>{types.find(t=>t[0]===f.field_type)?.[1]||f.field_type}</td>
     <td><input aria-label={'Обязательное '+f.code} type="checkbox" checked={f.required} onChange={e=>toggleField(f,'required',e.target.checked)} disabled={busy}/></td>
     <td><input aria-label={'Активно '+f.code} type="checkbox" checked={f.active} onChange={e=>toggleField(f,'active',e.target.checked)} disabled={busy}/></td></tr>)}
    {!fields.length&&<tr><td colSpan={6}>Дополнительных полей пока нет. Основные поля заявки сохраняются как прежде.</td></tr>}
   </tbody></table></div>
   <p className="ofsTip">Первый этап: поля формы ремонта (REPAIR). Устройство строгого жизненного цикла и старые заказы не меняются. Пароли устройств здесь не сохраняйте.</p>
  </section>
 </div></div>;
}
const host=document.createElement('div');document.body.appendChild(host);createRoot(host).render(<OrderFormSettings/>);
