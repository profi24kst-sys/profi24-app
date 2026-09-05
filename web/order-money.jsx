import React,{useEffect,useState} from 'react';
import {financeApi,financeMoney as money,financeUser,coreMoneyApi,coreOrderApi} from './finance-client.js';
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
  if(financeUser()?.role!=='OWNER')return null;
  const originals=(payments||[]).filter(p=>p.kind==='PAYMENT').map(p=>{const linked=(payments||[]).filter(x=>x.kind==='REFUND'&&(Number(x.source_payment_id)===Number(p.id)||x.reference==='refund:'+p.id)).reduce((s,x)=>s+Number(x.amount),0);return {...p,available:Number(p.amount)-Number(p.refunded_amount??linked)}}).filter(p=>p.available>0.001);
  if(!originals.length)return null;
  return <><button type="button" onClick={()=>setOpen(true)}>Возврат оплаты</button>{open&&<RefundForm key={requestId} originals={originals} close={()=>setOpen(false)} onSaved={onSaved}/>}</>;
}
function RefundForm({originals,close,onSaved}) {
  const f=useFinanceForm({payment_id:'',amount:'',reason:'',document_reference:''}),b=f.form,selected=originals.find(p=>String(p.id)===b.payment_id);
  return <FinanceDialog title="Возврат оплаты клиенту" close={()=>!f.busy&&close()}><form className="finForm" onSubmit={f.submit(async(body,key)=>{await coreMoneyApi('/payments/'+body.payment_id+'/refund',{amount:body.amount,reason:body.reason,document_reference:body.document_reference},key);await onSaved();close();})}><fieldset disabled={f.busy}><label>Исходная оплата<select required value={b.payment_id} onChange={e=>f.change('payment_id',e.target.value)}><option value="">Выберите оплату</option>{originals.map(p=><option key={p.id} value={p.id}>№{p.id} · {p.account_name||p.method} · доступно {money(p.available)}</option>)}</select></label>{selected&&<div className="finPaymentDetail"><span>Исходная сумма <b>{money(selected.amount)}</b></span><span>Источник <b>{selected.account_name||selected.method}</b></span><span>Оплата от <b>{new Date(selected.created_at).toLocaleString('ru-RU')}</b></span>{selected.reference&&<span>Документ оплаты <b>{selected.reference}</b></span>}</div>}<label>Сумма, ₸<input required type="number" min="0.01" step="0.01" max={selected?.available} value={b.amount} onChange={e=>f.change('amount',e.target.value)}/></label><label>Причина<input required minLength={3} maxLength={500} value={b.reason} onChange={e=>f.change('reason',e.target.value)}/></label><label>Документ возврата<input required maxLength={200} value={b.document_reference} onChange={e=>f.change('document_reference',e.target.value)} placeholder="Чек возврата / платёжное поручение"/></label><p className="finHint">Деньги спишутся с исходного счёта. Первоначальная оплата останется в истории и будет связана с возвратом.</p></fieldset><FormActions busy={f.busy} error={f.error} close={close} label="Провести возврат"/></form></FinanceDialog>;
}

export function OrderCancelButton({requestId,status,onSaved}) {
  const [open,setOpen]=useState(false);
  if(financeUser()?.role!=='OWNER'||status==='CANCELLED')return null;
  return <><button type="button" className="finCancelLaunch" onClick={()=>setOpen(true)}>Отменить заказ</button>{open&&<CancellationForm key={requestId} requestId={requestId} close={()=>setOpen(false)} onSaved={onSaved}/>}</>;
}
function CancellationForm({requestId,close,onSaved}) {
  const [readiness,setReadiness]=useState(null),[loadError,setLoadError]=useState('');
  const f=useFinanceForm({category:'CUSTOMER_REFUSAL',reason:'',document_reference:'',acknowledge_expenses:false}),b=f.form;
  useEffect(()=>{let alive=true;coreOrderApi('/requests/'+requestId+'/cancellation-readiness').then(x=>{if(alive)setReadiness(x)}).catch(e=>{if(alive)setLoadError(e.message)});return()=>{alive=false}},[requestId]);
  const categories={CUSTOMER_REFUSAL:'Клиент отказался',DUPLICATE:'Дублирующий заказ',NO_CONTACT:'Нет связи с клиентом',UNREPAIRABLE:'Ремонт невозможен',PRICE_REJECTED:'Не согласована стоимость',OTHER:'Другая причина'};
  const blocked=readiness&&(Math.abs(Number(readiness.net_paid))>0.01||readiness.unreturned_purchases?.length>0||readiness.status==='CLOSED');
  return <FinanceDialog title="Документированная отмена заказа" close={()=>!f.busy&&close()}><form className="finForm" onSubmit={f.submit(async(body,key)=>{await coreOrderApi('/requests/'+requestId+'/cancel',{method:'POST',body,key});await onSaved();close();})}><fieldset disabled={f.busy||!readiness}>
    {loadError&&<p className="finError">{loadError}</p>}{!readiness&&!loadError&&<p className="finHint">Проверяю платежи, покупки и расходы…</p>}
    {readiness&&<><div className="finCancelSummary"><span>Оплата клиента<b>{money(readiness.net_paid)}</b></span><span>Оплаченные покупки<b>{readiness.unreturned_purchases?.length||0}</b></span><span>Расходы компании<b>{money(readiness.expense_amount)}</b></span><span>Открытые задачи<b>{readiness.open_tasks||0}</b></span></div><div className="finBlockers">{readiness.status==='CLOSED'&&<div><b>Заказ закрыт</b><small>Сначала оформите возврат оплаты. Заказ автоматически вернётся в статус «К оплате».</small></div>}{Math.abs(Number(readiness.net_paid))>0.01&&<div><b>Нужно вернуть клиенту {money(readiness.net_paid)}</b><small>Отмена станет доступна после полного возврата оплаты.</small></div>}{readiness.unreturned_purchases?.length>0&&<div><b>Нужно вернуть оплаченные покупки</b><small>{readiness.unreturned_purchases.map(x=>x.name).join(', ')}</small></div>}</div></>}
    <label>Категория отмены<select value={b.category} onChange={e=>f.change('category',e.target.value)}>{Object.entries(categories).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>Подробная причина<textarea required minLength={3} maxLength={500} value={b.reason} onChange={e=>f.change('reason',e.target.value)} placeholder="Что произошло и кто подтвердил отмену"/></label><label>Документ-основание<input required maxLength={200} value={b.document_reference} onChange={e=>f.change('document_reference',e.target.value)} placeholder="Заявление клиента / служебная записка №…"/></label>
    {Number(readiness?.expense_amount)>0&&<><p className="finWarning">Расходы {money(readiness.expense_amount)} уже проведены и останутся в финансовой истории компании.</p><label className="finCheck"><input type="checkbox" checked={b.acknowledge_expenses} onChange={e=>f.change('acknowledge_expenses',e.target.checked)}/>Подтверждаю сохранение понесённых расходов</label></>}
    <p className="finHint">После отмены незавершённые задачи и резервы будут закрыты. Заказ и денежные операции не удаляются.</p>
  </fieldset><FormActions busy={f.busy} error={f.error} close={close} label="Документировать отмену" danger disabled={!readiness||!!blocked||(Number(readiness?.expense_amount)>0&&!b.acknowledge_expenses)}/></form></FinanceDialog>;
}
