import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Camera,Wallet,ShieldCheck,PackageCheck} from 'lucide-react';
import {coreMoneyApi,financeApi,financeKey,financeMoney,financeUser} from './finance-client.js';
import './completion.css';

const A='/completion-api/v1';
const token=()=>localStorage.token||'';
async function completionApi(path,options={}){
  const response=await fetch(A+path,{...options,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token()}`,...(options.headers||{})}});
  const json=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(json.error?.message||`Ошибка ${response.status}`);
  return json.data;
}
async function resolveOrderId(number){
  const response=await fetch('/api/v1/requests',{headers:{Authorization:`Bearer ${token()}`}});
  const json=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(json.error?.message||'Не удалось открыть заказ');
  const row=(json.data||[]).find(value=>String(value.number)===String(number));
  if(!row)throw new Error('Заказ не найден');
  return row.id;
}
function currentOrderNumber(){
  return document.querySelector('.hcHeroLeft strong')?.textContent?.replace(/^Заказ\s+/,'').trim()
    || document.querySelector('.ordertitle h2')?.textContent?.replace(/^Заказ\s+/,'').trim()||'';
}

function App(){
  const user=financeUser(),[open,setOpen]=useState(false),[id,setId]=useState(null),[data,setData]=useState(null);
  const [accounts,setAccounts]=useState([]),[repair,setRepair]=useState(''),[test,setTest]=useState(''),[amount,setAmount]=useState('');
  const [accountId,setAccountId]=useState(''),[message,setMessage]=useState('');
  const paymentKey=useRef(financeKey());
  async function load(requestId=id){
    if(!requestId)return;
    const value=await completionApi('/requests/'+requestId);
    setData(value);setRepair(value.completion?.repair_result||'');setTest(value.completion?.test_result||'');
    setAmount(String(Math.max(0,Number(value.request.total)-Number(value.request.paid))));setMessage('');
  }
  async function openCurrent(){
    try{
      setMessage('');const number=currentOrderNumber();if(!number)throw new Error('Сначала откройте заказ');
      const requestId=await resolveOrderId(number),sources=await financeApi('/accounts');
      setId(requestId);setAccounts((sources||[]).filter(value=>value.is_active));setAccountId('');setOpen(true);await load(requestId);
    }catch(error){setMessage(error.message);setOpen(true);}
  }
  async function act(path,body={}){
    try{
      let result;
      if(path==='payment'){
        if(user?.role==='ENGINEER')throw new Error('Инженер не может проводить оплату клиента');
        if(!body.account_id)throw new Error('Выберите денежный счёт');
        result=await coreMoneyApi('/requests/'+id+'/payment',{amount:body.amount,account_id:Number(body.account_id),method:'ACCOUNT',reference:body.reference||null},paymentKey.current);
        paymentKey.current=financeKey();
      }else result=await completionApi('/requests/'+id+'/'+path,{method:'POST',body:JSON.stringify(body)});
      setMessage('Готово');await load();window.dispatchEvent(new CustomEvent('profi24:request-updated',{detail:{id}}));return result;
    }catch(error){setMessage(error.message);}
  }
  useEffect(()=>{const handler=()=>openCurrent();window.addEventListener('profi24:open-completion',handler);return()=>window.removeEventListener('profi24:open-completion',handler);},[]);
  if(!open)return null;
  const request=data?.request,balance=request?Math.max(0,Number(request.total)-Number(request.paid)):0;
  const after=data?.files?.filter(value=>['AFTER','PHOTO_AFTER'].includes(value.kind)).length||0;
  const clientSignature=data?.signatures?.some(value=>value.signer_type==='CLIENT');
  return <div className="co"><header><div><h1>Завершение ремонта</h1><p>{request?'Заказ '+request.number+' · списание → проверка → оплата → гарантия':'Открытие заказа...'}</p></div><button onClick={()=>setOpen(false)}>×</button></header>
    {message&&<div className="coMsg">{message}</div>}
    {data&&<main><section className="coCard"><h2>Заказ {request.number}</h2><div className="coState"><span>Статус <b>{request.status}</b></span><span>Сумма <b>{financeMoney(request.total)}</b></span><span>Оплачено <b>{financeMoney(request.paid)}</b></span><span>Остаток <b>{financeMoney(balance)}</b></span></div>
      <h3><PackageCheck/> 1. Ремонт выполнен</h3><textarea placeholder="Что выполнено" value={repair} onChange={e=>setRepair(e.target.value)}/><button onClick={()=>act('repair-done',{repair_result:repair})}>Зафиксировать ремонт и списать резерв</button><p className="hint">Зарезервированные запчасти списываются со склада и входят в фактическую себестоимость заказа.</p>
      <h3><Camera/> 2. Контрольная проверка</h3><textarea placeholder="Результат проверки" value={test} onChange={e=>setTest(e.target.value)}/><div className={after?'ok':'warn'}>Фото после ремонта: {after}</div><button onClick={()=>act('test',{test_result:test})}>Проверка пройдена</button></section>
      <section className="coCard"><h3><Wallet/> 3. Оплата</h3>{user?.role==='ENGINEER'?<p className="hint">Оплату клиента проводит менеджер или OWNER.</p>:<><div className="payRow"><input type="number" min="0.01" step="0.01" value={amount} onChange={e=>{setAmount(e.target.value);paymentKey.current=financeKey();}}/><select required value={accountId} onChange={e=>{setAccountId(e.target.value);paymentKey.current=financeKey();}}><option value="">Выберите денежный счёт</option>{accounts.map(value=><option key={value.id} value={value.id}>{value.name} · {financeMoney(value.balance)}</option>)}</select></div>{!accounts.length&&<p className="warn">Нет доступного активного счёта. OWNER должен назначить счёт ответственному сотруднику.</p>}<button disabled={!balance||!accountId} onClick={()=>act('payment',{amount:Number(amount),account_id:accountId})}>Принять оплату</button></>}
        <h3><ShieldCheck/> 4. Закрытие и гарантия</h3><div className={clientSignature?'ok':'warn'}>Подпись клиента: {clientSignature?'есть':'нет'}</div><div className={after?'ok':'warn'}>Фото после ремонта: {after?'есть':'нет'}</div><div className={balance<=0?'ok':'warn'}>Оплата: {balance<=0?'полная':'осталось '+financeMoney(balance)}</div>{user?.role!=='ENGINEER'&&<button className="closeOrder" onClick={()=>act('close')}>Закрыть заказ и выпустить документы</button>}{request.warranty_until&&<div className="warranty"><ShieldCheck/><span>Гарантия до <b>{new Date(request.warranty_until).toLocaleDateString('ru-RU')}</b></span></div>}</section></main>}
  </div>;
}
const host=document.createElement('div');document.body.appendChild(host);createRoot(host).render(<App/>);
