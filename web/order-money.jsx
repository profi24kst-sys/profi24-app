import React,{useEffect,useState} from 'react';
import {financeApi,financeMoney as money,financeUser,coreMoneyApi} from './finance-client.js';
import {AccountSelect,FormActions,useFinanceForm,FinanceDialog} from './finance-forms.jsx';
import './finance.css';

function useSources(requestId) {
  const [accounts,setAccounts]=useState([]),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const load=async()=>{try{setError('');setLoading(true);setAccounts(await financeApi('/accounts'));}catch(e){setError(e.message);}finally{setLoading(false);}};
  useEffect(()=>{const controller=new AbortController();setLoading(true);setError('');setAccounts([]);financeApi('/accounts',{signal:controller.signal}).then(setAccounts).catch(e=>{if(e.name!=='AbortError')setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[requestId]);
  return {accounts,loading,error,load};
}
function SourceState({source}) {
  if(source.error)return <p className="finError" role="alert">{source.error} <button type="button" onClick={source.load}>Повторить</button></p>;
  if(source.loading)return <p className="finHint">Загрузка источников оплаты…</p>;
  if(!source.accounts.some(a=>a.is_active))return <p className="finError">Нет доступного источника денег. OWNER должен создать счёт и назначить ответственного сотрудника.</p>;
  return null;
}
export function OrderExpenseForm({requestId,onSaved}) {
  const source=useSources(requestId),f=useFinanceForm({account_id:'',category:'TAXI',amount:'',comment:'',document_reference:''}),b=f.form;
  const names={TAXI:'Такси / выезд',DELIVERY:'Доставка',CONSUMABLES:'Расходные материалы',PARKING:'Парковка',FUEL:'Топливо',OTHER:'Прочее'};
  return <form className="finOrderForm" onSubmit={f.submit(async(body,key)=>{await financeApi('/requests/'+requestId+'/expenses',{method:'POST',body,key});f.reset();await source.load();await onSaved();})}>
    <SourceState source={source}/><fieldset disabled={f.busy||source.loading||!!source.error}><AccountSelect accounts={source.accounts} value={b.account_id} onChange={v=>f.change('account_id',v)}/><label>Категория<select value={b.category} onChange={e=>f.change('category',e.target.value)}>{Object.entries(names).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label><label>Сумма, ₸<input required type="number" min="0.01" step="0.01" value={b.amount} onChange={e=>f.change('amount',e.target.value)}/></label><label>Чек / документ<input value={b.document_reference} onChange={e=>f.change('document_reference',e.target.value)}/></label><label className="finFull">Назначение расхода<input required minLength={3} value={b.comment} onChange={e=>f.change('comment',e.target.value)} placeholder="Например, такси до клиента"/></label></fieldset><FormActions busy={f.busy||source.loading} error={f.error} label="Провести расход"/>
  </form>;
}
export function OrderPurchaseForm({requestId,onSaved,withActions=false}) {
  const [open,setOpen]=useState(false),source=useSources(requestId),f=useFinanceForm({account_id:'',name:'',qty:'1',purchase_price:'',sale_price:'',supplier:'',document_reference:''}),b=f.form;
  return <><button type="button" aria-expanded={open} onClick={()=>setOpen(v=>!v)} disabled={f.busy}>Купить и оплатить</button>{withActions&&<><button type="button" onClick={()=>window.dispatchEvent(new CustomEvent('profi24:parts-stock'))}>Со склада</button><button type="button" onClick={()=>window.dispatchEvent(new CustomEvent('profi24:parts-order'))}>Заказать запчасть</button></>}{open&&<form className="finOrderForm" onSubmit={f.submit(async(body,key)=>{await financeApi('/requests/'+requestId+'/part-purchases',{method:'POST',body:{...body,sale_price:body.sale_price||0},key});f.reset();await source.load();await onSaved();setOpen(false);})}>
    <h3>Купленная запчасть</h3><SourceState source={source}/><fieldset disabled={f.busy||source.loading||!!source.error}><label className="finFull">Название<input required value={b.name} onChange={e=>f.change('name',e.target.value)}/></label><label>Количество<input required type="number" min="0.01" step="0.01" value={b.qty} onChange={e=>f.change('qty',e.target.value)}/></label><label>Закупочная цена за единицу, ₸<input required type="number" min="0.01" step="0.01" value={b.purchase_price} onChange={e=>f.change('purchase_price',e.target.value)}/></label><label>Цена клиенту за единицу, ₸<input type="number" min="0" step="0.01" value={b.sale_price} onChange={e=>f.change('sale_price',e.target.value)}/></label><AccountSelect accounts={source.accounts} value={b.account_id} onChange={v=>f.change('account_id',v)}/><label>Поставщик<input value={b.supplier} onChange={e=>f.change('supplier',e.target.value)}/></label><label>Чек / документ покупки<input required value={b.document_reference} onChange={e=>f.change('document_reference',e.target.value)}/></label></fieldset><p className="finHint">Спишется: {money(Number(b.qty)*Number(b.purchase_price))}. Покупатель — {financeUser()?.name||'текущий сотрудник'}. Запчасть и списание сохранятся вместе.</p><FormActions busy={f.busy||source.loading} error={f.error} close={()=>setOpen(false)} label="Записать покупку и оплату"/>
  </form>}</>;
}
export function PaymentAccountField({requestId,value,onChange}) {
  const source=useSources(requestId);
  return <div className="finOrderForm"><SourceState source={source}/><AccountSelect accounts={source.accounts} value={value} onChange={onChange} label="Зачислить на счёт"/></div>;
}
export function OrderPaymentForm({requestId,debt,onSaved}) {
  const source=useSources(requestId),f=useFinanceForm({account_id:'',amount:'',reference:''}),b=f.form;
  return <form className="finOrderForm payform" onSubmit={f.submit(async(body,key)=>{await coreMoneyApi('/requests/'+requestId+'/payment',{...body,method:'ACCOUNT'},key);f.reset();await source.load();await onSaved();})}><SourceState source={source}/><fieldset disabled={f.busy||source.loading||!!source.error}><label>Сумма оплаты, ₸<input required type="number" min="0.01" step="0.01" max={debt} value={b.amount} onChange={e=>f.change('amount',e.target.value)}/></label><AccountSelect accounts={source.accounts} value={b.account_id} onChange={v=>f.change('account_id',v)} label="Зачислить на счёт"/><label className="finFull">Номер / комментарий оплаты<input value={b.reference} onChange={e=>f.change('reference',e.target.value)}/></label></fieldset><FormActions busy={f.busy||source.loading} error={f.error} label="Принять оплату"/></form>;
}
export function OrderRefundButton({requestId,payments,onSaved}) {
  const [open,setOpen]=useState(false);
  if(!['OWNER','MANAGER'].includes(financeUser()?.role))return null;
  const originals=(payments||[]).filter(p=>p.kind==='PAYMENT').map(p=>({...p,available:Number(p.amount)-(payments||[]).filter(x=>x.kind==='REFUND'&&x.reference==='refund:'+p.id).reduce((s,x)=>s+Number(x.amount),0)})).filter(p=>p.available>0);
  if(!originals.length)return null;
  return <><button type="button" onClick={()=>setOpen(true)}>Возврат оплаты</button>{open&&<RefundForm key={requestId} originals={originals} close={()=>setOpen(false)} onSaved={onSaved}/>}</>;
}
function RefundForm({originals,close,onSaved}) {
  const f=useFinanceForm({payment_id:'',amount:'',reason:''}),b=f.form,selected=originals.find(p=>String(p.id)===b.payment_id);
  return <FinanceDialog title="Возврат оплаты клиенту" close={()=>!f.busy&&close()}><form className="finForm" onSubmit={f.submit(async(body,key)=>{await coreMoneyApi('/payments/'+body.payment_id+'/refund',{amount:body.amount,reason:body.reason},key);await onSaved();close();})}><fieldset disabled={f.busy}><label>Исходная оплата<select required value={b.payment_id} onChange={e=>f.change('payment_id',e.target.value)}><option value="">Выберите оплату</option>{originals.map(p=><option key={p.id} value={p.id}>№{p.id} · можно вернуть {money(p.available)}</option>)}</select></label><label>Сумма, ₸<input required type="number" min="0.01" step="0.01" max={selected?.available} value={b.amount} onChange={e=>f.change('amount',e.target.value)}/></label><label>Причина<input required minLength={3} value={b.reason} onChange={e=>f.change('reason',e.target.value)}/></label><p className="finHint">Возврат будет списан с исходного счёта оплаты. Первоначальная запись сохранится.</p></fieldset><FormActions busy={f.busy} error={f.error} close={close} label="Провести возврат"/></form></FinanceDialog>;
}
