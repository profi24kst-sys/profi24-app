import React,{useEffect,useRef,useState} from 'react';
import {X,RefreshCw} from 'lucide-react';
import './order-intake.css';
const typeNames={REPAIR:'Обычный ремонт',FIELD:'Выездной ремонт',PAID_WORKSHOP:'Платный ремонт в сервисе'};
const sourceNames={GOOGLE_ADS:'Реклама Google',GOOGLE:'Поиск Google','2GIS':'2ГИС',INSTAGRAM:'Instagram',TIKTOK:'TikTok',OLX:'OLX',REFERRAL:'По рекомендации',REPEAT:'Повторное обращение',B2B:'Организация',OTHER:'Другое'};
export function NewOrder({close,users,reload,call,categories,sources}){
 const[cid,setCid]=useState(''),[eid,setEid]=useState(''),[cust,setCust]=useState({name:'',phone:'',address:''}),[dev,setDev]=useState({category:'Холодильник',brand:'',model:'',serial_number:''});
 const[form,setForm]=useState({complaint:'',source:'OTHER',priority:'NORMAL',scheduled_at:'',engineer_id:'',visit_type:'FIELD',manager_comment:''}),[orderType,setOrderType]=useState('REPAIR');
 const[error,setError]=useState(''),[errors,setErrors]=useState({}),[saving,setSaving]=useState(false),savingRef=useRef(false),dialog=useRef(null),confirmed=useRef({}),mounted=useRef(true),session=useRef(localStorage.token);
 const[customerQuery,setCustomerQuery]=useState(''),[customerMatches,setCustomerMatches]=useState([]),[selectedCustomer,setSelectedCustomer]=useState(null),[customersLoading,setCustomersLoading]=useState(false),[customersError,setCustomersError]=useState(''),[customerRetry,setCustomerRetry]=useState(0);
 const[devs,setDevs]=useState([]),[equipmentLoading,setEquipmentLoading]=useState(false),[loadedEquipmentCustomer,setLoadedEquipmentCustomer]=useState(''),[equipmentError,setEquipmentError]=useState(''),[equipmentRetry,setEquipmentRetry]=useState(0);
 const[extraDefinitions,setExtraDefinitions]=useState([]),[extraValues,setExtraValues]=useState({}),[extraState,setExtraState]=useState('loading'),[extraError,setExtraError]=useState(''),[schemaRetry,setSchemaRetry]=useState(0);
 const live=()=>mounted.current&&localStorage.token===session.current;
 useEffect(()=>{mounted.current=true;dialog.current?.querySelector('#new-order-type')?.focus();return()=>{mounted.current=false}},[]);
 useEffect(()=>{const escape=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!savingRef.current)close()}};document.addEventListener('keydown',escape,true);return()=>document.removeEventListener('keydown',escape,true)},[close]);
 useEffect(()=>{
  let active=true;setExtraState('loading');setExtraError('');
  call('/order-form/schema?order_type='+encodeURIComponent(orderType)).then(schema=>{if(active&&live()){setExtraDefinitions(schema?.fields||[]);setExtraState('ready')}}).catch(problem=>{if(active&&live()){setExtraState('error');setExtraError(problem.message||'Не удалось загрузить поля приёмки')}});
  return()=>{active=false};
 },[orderType,schemaRetry]);
 useEffect(()=>{
  let active=true;const controller=new AbortController();setCustomersLoading(true);setCustomersError('');
  const timer=setTimeout(async()=>{try{const rows=await call('/directory/customers?limit=25&search='+encodeURIComponent(customerQuery.trim()),{signal:controller.signal});if(active&&live())setCustomerMatches(rows||[])}catch(problem){if(active&&live()&&problem.name!=='AbortError'){setCustomerMatches([]);setCustomersError(problem.message||'Не удалось найти клиентов')}}finally{if(active&&live())setCustomersLoading(false)}},customerQuery?260:0);
  return()=>{active=false;clearTimeout(timer);controller.abort()};
 },[customerQuery,customerRetry]);
 useEffect(()=>{
  setLoadedEquipmentCustomer('');setEquipmentError('');setDevs([]);if(!cid){setEquipmentLoading(false);return}
  let active=true;const controller=new AbortController();setEquipmentLoading(true);
  call('/directory/equipment?limit=100&customer_id='+encodeURIComponent(cid),{signal:controller.signal}).then(rows=>{if(active&&live()){setDevs(rows||[]);setLoadedEquipmentCustomer(String(cid))}}).catch(problem=>{if(active&&live()&&problem.name!=='AbortError')setEquipmentError(problem.message||'Не удалось загрузить технику клиента')}).finally(()=>{if(active&&live())setEquipmentLoading(false)});
  return()=>{active=false;controller.abort()};
 },[cid,equipmentRetry]);
 const equipmentReady=!cid||(loadedEquipmentCustomer===String(cid)&&!equipmentLoading&&!equipmentError);
 const eng=users.filter(x=>x.role==='ENGINEER'&&x.active!==false);
 const change=(setter,key,value)=>{setter(previous=>({...previous,[key]:value}));setErrors(previous=>({...previous,[setter===setExtraValues?'field_'+key:key]:null}))};
 function chooseCustomer(value){setCid(value);setSelectedCustomer(value?customerMatches.find(x=>String(x.id)===value)||selectedCustomer:null);setEid('');setErrors({})}
 function chooseType(value){setOrderType(value);setExtraValues({});setExtraDefinitions([]);setExtraState('loading');setErrors({});setForm(previous=>({...previous,visit_type:value==='PAID_WORKSHOP'?'WORKSHOP':value==='FIELD'?'FIELD':previous.visit_type}))}
 function validate(){
  const next={};if(!cid){if(cust.name.trim().length<2)next.name='Укажите имя клиента';const digits=cust.phone.replace(/\D/g,'');if(digits.length<10||digits.length>15)next.phone='Введите корректный номер телефона'}
  if(!equipmentReady)next.equipment='Дождитесь загрузки техники клиента или повторите её';
  if(form.complaint.trim().length<3)next.complaint='Опишите неисправность минимум тремя символами';
  if(form.scheduled_at&&Number.isNaN(new Date(form.scheduled_at).getTime()))next.scheduled_at='Проверьте дату и время';
  if(extraState!=='ready')next.custom_fields='Не удалось загрузить обязательные поля приёмки';
  for(const def of extraDefinitions){const value=extraValues[def.code],empty=value===undefined||String(value).trim()==='';if(def.required&&empty)next['field_'+def.code]='Заполните поле «'+def.label+'»';else if(!empty&&def.field_type==='IMEI'&&!/^\d{15}$/.test(value))next['field_'+def.code]='IMEI должен содержать 15 цифр';else if(!empty&&def.field_type==='NUMBER'&&(!Number.isFinite(Number(value))||Math.abs(Number(value))>1e10))next['field_'+def.code]='Проверьте числовое значение'}
  return next;
 }
 function focusError(next){const field=Object.keys(next)[0],ids={name:'new-customer-name',phone:'new-customer-phone',equipment:'new-order-equipment',complaint:'new-order-complaint',scheduled_at:'new-order-scheduled',custom_fields:'intake-schema-error'};requestAnimationFrame(()=>document.getElementById(field.startsWith('field_')?'custom-field-'+field.slice(6):ids[field])?.focus())}
 async function save(event){
  event.preventDefault();if(savingRef.current)return;const next=validate();setErrors(next);setError('');if(Object.keys(next).length){focusError(next);return}
  savingRef.current=true;setSaving(true);
  try{
   const cleanCustomer={name:cust.name.trim(),phone:cust.phone.trim(),address:cust.address.trim()},customerKey=JSON.stringify(cleanCustomer);
   let c=cid||(confirmed.current.customerKey===customerKey?confirmed.current.customerId:null);
   if(!c){const x=await call('/customers',{method:'POST',body:JSON.stringify(cleanCustomer)});confirmed.current={customerKey,customerId:x.id};c=x.id}
   if(!live())return;
   const cleanEquipment={...dev,brand:dev.brand.trim(),model:dev.model.trim(),serial_number:dev.serial_number.trim(),customer_id:+c},equipmentKey=JSON.stringify(cleanEquipment);
   let e=eid||(confirmed.current.equipmentKey===equipmentKey?confirmed.current.equipmentId:null);
   if(!e){const x=await call('/equipment',{method:'POST',body:JSON.stringify(cleanEquipment)});Object.assign(confirmed.current,{equipmentKey,equipmentId:x.id});e=x.id}
   if(!live())return;
   await call('/requests',{method:'POST',body:JSON.stringify({...form,complaint:form.complaint.trim(),manager_comment:form.manager_comment.trim(),order_type:orderType,visit_type:orderType==='PAID_WORKSHOP'?'WORKSHOP':orderType==='FIELD'?'FIELD':form.visit_type,custom_fields:Object.fromEntries(extraDefinitions.filter(d=>extraValues[d.code]!==undefined&&String(extraValues[d.code]).trim()!=='').map(d=>[d.code,['NUMBER','SELECT'].includes(d.field_type)?Number(extraValues[d.code]):extraValues[d.code]])),customer_id:+c,equipment_id:+e,engineer_id:form.engineer_id?+form.engineer_id:null,scheduled_at:form.scheduled_at?new Date(form.scheduled_at).toISOString():null})});
   if(!live())return;close();await reload();
  }catch(problem){if(live())setError(problem.message)}finally{savingRef.current=false;if(live())setSaving(false)}
 }
 function keyDown(event){if(event.key==='Escape'){event.stopPropagation();if(!savingRef.current)close()}else if(event.key==='Tab'){const controls=[...dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary')].filter(el=>el.getClientRects().length);if(event.shiftKey&&document.activeElement===controls[0]){event.preventDefault();controls.at(-1)?.focus()}else if(!event.shiftKey&&document.activeElement===controls.at(-1)){event.preventDefault();controls[0]?.focus()}}}
 const fieldError=(key)=><small className="fieldError" id={'intake-error-'+key}>{errors[key]}</small>;
 const invalid=key=>({'aria-invalid':Boolean(errors[key]),'aria-describedby':errors[key]?'intake-error-'+key:undefined});
 return <div className="overlay intakeOverlay" onMouseDown={event=>{if(event.target===event.currentTarget&&!savingRef.current)close()}}><div ref={dialog} className="drawer intakeDrawer" data-order-intake="controlled" role="dialog" aria-modal="true" aria-labelledby="new-order-title" aria-busy={saving} onKeyDown={keyDown}>
  <div className="drawerhead intakeHead"><div><small>НОВЫЙ ЗАКАЗ</small><h2 id="new-order-title">Приём заказа</h2><p>Клиент, техника и обращение в одной форме</p></div><button type="button" className="icon" aria-label="Закрыть создание заказа" onClick={close} disabled={saving}><X/></button></div>
  <form className="intakeForm" onSubmit={save} noValidate><fieldset disabled={saving}>
   <section className="intakeType"><label htmlFor="new-order-type">Сценарий заказа</label><select id="new-order-type" value={orderType} onChange={event=>chooseType(event.target.value)}>{Object.entries(typeNames).map(([value,label])=><option key={value} value={value}>{label}</option>)}<option disabled>Продажа техники (отдельный модуль позднее)</option><option disabled>Заказ запчастей (отдельный модуль позднее)</option></select>
    <label htmlFor="new-order-visit">Тип заказа</label><select id="new-order-visit" value={orderType==='FIELD'?'FIELD':orderType==='PAID_WORKSHOP'?'WORKSHOP':form.visit_type} disabled={orderType!=='REPAIR'} onChange={event=>change(setForm,'visit_type',event.target.value)}><option value="FIELD">Выезд к клиенту</option><option value="WORKSHOP">Прием в сервисе</option></select></section>
   {error&&<div className="errorbox" role="alert">{error}</div>}
   <div className="intakeColumns">
    <section className="form intakeSection" aria-labelledby="intake-customer-title"><h3 id="intake-customer-title">Клиент</h3>
     <label htmlFor="new-order-customer-search">Поиск существующего клиента</label><input id="new-order-customer-search" value={customerQuery} onChange={event=>setCustomerQuery(event.target.value)} placeholder="Имя или телефон" autoComplete="off"/>
     <label htmlFor="new-order-customer-select">Существующий клиент</label><select id="new-order-customer-select" value={cid} onChange={event=>chooseCustomer(event.target.value)}><option value="">Новый клиент</option>{selectedCustomer&&cid&&!customerMatches.some(x=>String(x.id)===String(cid))&&<option value={cid}>{selectedCustomer.name} · {selectedCustomer.phone}</option>}{customerMatches.map(x=><option key={x.id} value={x.id}>{x.name} · {x.phone}</option>)}</select>
     {customersLoading&&<small role="status">Поиск клиентов…</small>}{customersError&&<div className="fieldError" role="alert">{customersError}<button type="button" onClick={()=>setCustomerRetry(v=>v+1)}><RefreshCw size={14}/>Повторить поиск клиентов</button></div>}
     {cid?<p className="intakeSelected">{selectedCustomer?.phone||'—'}<br/>{selectedCustomer?.address||'Адрес не указан'}</p>:<><label htmlFor="new-customer-name">Имя *</label><input id="new-customer-name" value={cust.name} autoComplete="name" {...invalid('name')} onChange={event=>change(setCust,'name',event.target.value)}/>{errors.name&&fieldError('name')}<label htmlFor="new-customer-phone">Телефон *</label><input id="new-customer-phone" type="tel" inputMode="tel" autoComplete="tel" value={cust.phone} {...invalid('phone')} onChange={event=>change(setCust,'phone',event.target.value)} placeholder="+7 777 000 00 00"/>{errors.phone&&fieldError('phone')}<label htmlFor="new-customer-address">Адрес</label><input id="new-customer-address" autoComplete="street-address" value={cust.address} onChange={event=>change(setCust,'address',event.target.value)}/></>}
    </section>
    <section className="form intakeSection" id="new-order-equipment" tabIndex={-1} aria-labelledby="intake-equipment-title"><h3 id="intake-equipment-title">Техника</h3>
     {cid&&equipmentLoading&&<small role="status">Загружаем технику клиента…</small>}{cid&&equipmentError&&<div role="alert" className="fieldError">{equipmentError}<button type="button" onClick={()=>setEquipmentRetry(v=>v+1)}>Повторить загрузку техники</button></div>}
     {equipmentReady&&cid&&devs.length>0&&<><label htmlFor="new-equipment-existing">Техника клиента</label><select id="new-equipment-existing" value={eid} onChange={event=>setEid(event.target.value)}><option value="">Новая техника</option>{devs.map(x=><option key={x.id} value={x.id}>{[x.category,x.brand,x.model].filter(Boolean).join(' ')}</option>)}</select></>}
     {equipmentReady&&!eid&&<><label htmlFor="new-equipment-category">Категория</label><select id="new-equipment-category" value={dev.category} onChange={event=>change(setDev,'category',event.target.value)}>{categories.map(x=><option key={x}>{x}</option>)}</select><label htmlFor="new-equipment-brand">Бренд</label><input id="new-equipment-brand" value={dev.brand} onChange={event=>change(setDev,'brand',event.target.value)}/><label htmlFor="new-equipment-model">Модель</label><input id="new-equipment-model" value={dev.model} onChange={event=>change(setDev,'model',event.target.value)}/><label htmlFor="new-equipment-serial">Серийный №</label><input id="new-equipment-serial" value={dev.serial_number} onChange={event=>change(setDev,'serial_number',event.target.value)}/></>}
     {errors.equipment&&fieldError('equipment')}
    </section>
    <section className="form intakeSection intakeFull" aria-labelledby="intake-request-title"><h3 id="intake-request-title">Обращение</h3>
     <label htmlFor="new-order-complaint">Неисправность *</label><textarea id="new-order-complaint" value={form.complaint} {...invalid('complaint')} onChange={event=>change(setForm,'complaint',event.target.value)}/>{errors.complaint&&fieldError('complaint')}
     <div className="grid2"><div><label htmlFor="new-order-source">Источник</label><select id="new-order-source" value={form.source} onChange={event=>change(setForm,'source',event.target.value)}>{sources.map(x=><option key={x} value={x}>{sourceNames[x]||x}</option>)}</select></div><div><label htmlFor="new-order-priority">Приоритет</label><select id="new-order-priority" value={form.priority} onChange={event=>change(setForm,'priority',event.target.value)}><option value="NORMAL">Обычный</option><option value="HIGH">Высокий</option><option value="CRITICAL">Срочный</option></select></div><div><label htmlFor="new-order-engineer">Инженер</label><select id="new-order-engineer" value={form.engineer_id} onChange={event=>change(setForm,'engineer_id',event.target.value)}><option value="">Не назначен</option>{eng.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></div><div><label htmlFor="new-order-scheduled">Дата/время</label><input id="new-order-scheduled" type="datetime-local" value={form.scheduled_at} {...invalid('scheduled_at')} onChange={event=>change(setForm,'scheduled_at',event.target.value)}/>{errors.scheduled_at&&fieldError('scheduled_at')}</div></div>
     <details><summary>Комментарий менеджера</summary><label htmlFor="new-order-comment">Комментарий менеджера</label><textarea id="new-order-comment" value={form.manager_comment} onChange={event=>change(setForm,'manager_comment',event.target.value)}/></details>
    </section>
    <section className="form intakeSection intakeFull" aria-label="Дополнительные поля приёмки">
     {extraDefinitions.length>0&&<h3>Дополнительные поля</h3>}{extraState==='loading'&&<small role="status">Загрузка дополнительных полей приёмки…</small>}{extraState==='error'&&<div id="intake-schema-error" tabIndex={-1} className="fieldError" role="alert">{extraError}<button type="button" onClick={()=>setSchemaRetry(v=>v+1)}>Повторить загрузку полей</button></div>}
     {extraDefinitions.map(def=><React.Fragment key={def.code}><label htmlFor={'custom-field-'+def.code}>{def.label}{def.required?' *':''}</label>{def.field_type==='TEXTAREA'?<textarea id={'custom-field-'+def.code} value={extraValues[def.code]??''} maxLength={2000} {...invalid('field_'+def.code)} onChange={event=>change(setExtraValues,def.code,event.target.value)}/>:def.field_type==='SELECT'?<select id={'custom-field-'+def.code} value={extraValues[def.code]??''} {...invalid('field_'+def.code)} onChange={event=>change(setExtraValues,def.code,event.target.value)}><option value="">Выберите значение</option>{(def.options||[]).map(o=><option key={o.id} value={o.id}>{o.value}</option>)}</select>:<input id={'custom-field-'+def.code} type={def.field_type==='NUMBER'?'number':def.field_type==='DATE'?'date':'text'} step={def.field_type==='NUMBER'?'any':undefined} maxLength={def.field_type==='IMEI'?15:250} inputMode={def.field_type==='IMEI'?'numeric':undefined} value={extraValues[def.code]??''} {...invalid('field_'+def.code)} onChange={event=>change(setExtraValues,def.code,event.target.value)}/>} {errors['field_'+def.code]&&fieldError('field_'+def.code)}</React.Fragment>)}{errors.custom_fields&&fieldError('custom_fields')}
    </section>
   </div>
  </fieldset><footer className="intakeFooter"><small>* Обязательные поля</small><button type="button" onClick={close} disabled={saving}>Отмена</button><button className="primary" type="submit" disabled={saving||extraState!=='ready'||!equipmentReady}>{saving?'Создаём…':'Создать заказ'}</button></footer></form>
 </div></div>;
}
