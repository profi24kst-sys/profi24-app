import React,{useEffect,useRef,useState} from 'react';
import {X} from 'lucide-react';
import {financeApi,financeKey,financeDate,financeMoney,accountTypes} from './finance-client.js';

export function AccountSelect({accounts,value,onChange,label='Источник оплаты',exclude}) {
  return <label>{label}<select required value={value||''} onChange={e=>onChange(e.target.value)}><option value="">Выберите счёт</option>{accounts.filter(a=>a.is_active&&String(a.id)!==String(exclude)).map(a=><option key={a.id} value={a.id}>{a.name} · {financeMoney(a.balance)}</option>)}</select></label>;
}
export function FinanceDialog({title,close,children}) {
  const ref=useRef(null);
  useEffect(()=>{ref.current?.showModal();return()=>ref.current?.close();},[]);
  return <dialog ref={ref} className="finDialog" onCancel={e=>{e.preventDefault();close();}} aria-label={title}><header><h2>{title}</h2><button type="button" onClick={close} aria-label="Закрыть"><X size={20}/></button></header>{children}</dialog>;
}
export function useFinanceForm(initial) {
  const [form,setForm]=useState(initial),[error,setError]=useState(''),[busy,setBusy]=useState(false),key=useRef(financeKey()),lock=useRef(false);
  const change=(name,value)=>{if(lock.current)return;setForm(f=>({...f,[name]:value}));setError('');key.current=financeKey();};
  const submit=fn=>async event=>{event?.preventDefault();if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await fn(form,key.current);}catch(e){setError(e.message);}finally{lock.current=false;setBusy(false);}};
  const reset=()=>{setForm(initial);key.current=financeKey();};
  return {form,change,error,busy,submit,reset};
}
export function FormActions({busy,error,close,label='Провести',disabled=false,danger=false}) {
  return <>{error&&<p className="finError" role="alert">{error}</p>}<footer>{close&&<button type="button" disabled={busy} onClick={close}>Отмена</button>}<button className={danger?'finDanger':'finPrimary'} type="submit" disabled={busy||disabled}>{busy?'Сохраняю…':label}</button></footer></>;
}
export function AccountForm({account,users,close,done}) {
  const f=useFinanceForm({name:account?.name||'',type:account?.type||'BANK',responsible_id:account?.responsible_id||'',comment:account?.comment||'',is_active:account?.is_active??true,initial_amount:'0',initial_reason:'',document_reference:''}),{form:b}=f;
  const save=async(body,key)=>{const data={...body,responsible_id:body.responsible_id?Number(body.responsible_id):null};if(account){delete data.initial_amount;delete data.initial_reason;delete data.document_reference;}await financeApi('/accounts'+(account?'/'+account.id:''),{method:account?'PATCH':'POST',body:data,key});done();};
  return <FinanceDialog title={account?'Редактирование счёта':'Новый денежный счёт'} close={()=>!f.busy&&close()}><form className="finForm" onSubmit={f.submit(save)}><fieldset disabled={f.busy}>
    <label>Название<input required maxLength={120} value={b.name} onChange={e=>f.change('name',e.target.value)}/></label>
    <label>Тип<select value={b.type} onChange={e=>f.change('type',e.target.value)}>{Object.entries(accountTypes).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
    <label>Ответственный сотрудник<select required={['CARD','ADVANCE'].includes(b.type)} value={b.responsible_id} onChange={e=>f.change('responsible_id',e.target.value)}><option value="">Только OWNER</option>{users.map(u=><option key={u.id} value={u.id} disabled={!u.active}>{u.name}{!u.active?' (неактивен)':''}</option>)}</select></label>
    <label>Комментарий<textarea value={b.comment} onChange={e=>f.change('comment',e.target.value)} maxLength={1000}/></label>
    {account?<><label className="finCheck"><input type="checkbox" checked={b.is_active} onChange={e=>f.change('is_active',e.target.checked)}/>Счёт активен</label><p className="finHint">Остаток {financeMoney(account.balance)} не редактируется. Для изменения используйте операцию или корректировку с основанием.</p></>:<><label>Начальный остаток, ₸<input type="number" step="0.01" value={b.initial_amount} onChange={e=>f.change('initial_amount',e.target.value)}/></label>{Number(b.initial_amount)!==0&&<><label>Основание начального остатка<input required minLength={3} value={b.initial_reason} onChange={e=>f.change('initial_reason',e.target.value)}/></label><label>Номер акта / документа<input value={b.document_reference} onChange={e=>f.change('document_reference',e.target.value)}/></label><p className="finHint">Начальная сумма будет отдельной записью в журнале движений.</p></>}</>}
  </fieldset><FormActions busy={f.busy} error={f.error} close={close} label={account?'Сохранить настройки':'Создать счёт'}/></form></FinanceDialog>;
}
export function MoneyForm({mode,accounts,account,entry,close,done}) {
  const f=useFinanceForm({account_id:account?.id||'',type:'EXPENSE',category:'OTHER',amount:'',from_account_id:account?.id||'',to_account_id:'',delta:'',reason:'',comment:'',document_reference:'',occurred_at:financeDate()}),{form:b}=f;
  const title={operation:'Приход или расход',transfer:'Перевод между счетами',adjustment:'Корректировка остатка',reverse:'Сторно операции'}[mode];
  const save=async(body,key)=>{
    const config=mode==='transfer'?['/transfers',{from_account_id:body.from_account_id,to_account_id:body.to_account_id,amount:body.amount,comment:body.comment,occurred_at:body.occurred_at}]:mode==='adjustment'?['/accounts/'+account.id+'/adjustments',{delta:body.delta,reason:body.reason,document_reference:body.document_reference,occurred_at:body.occurred_at}]:mode==='reverse'?['/transactions/'+entry.id+'/reverse',{reason:body.reason,document_reference:body.document_reference}]:['/transactions',{account_id:body.account_id,type:body.type,category:body.category,amount:body.amount,comment:body.comment,document_reference:body.document_reference,occurred_at:body.occurred_at}];
    await financeApi(config[0],{method:'POST',body:config[1],key});done();
  };
  return <FinanceDialog title={title} close={()=>!f.busy&&close()}><form className="finForm" onSubmit={f.submit(save)}><fieldset disabled={f.busy}>
    {mode==='operation'&&<><AccountSelect accounts={accounts} value={b.account_id} onChange={v=>f.change('account_id',v)}/><label>Операция<select value={b.type} onChange={e=>f.change('type',e.target.value)}><option value="EXPENSE">Расход</option><option value="INCOME">Прочий приход</option></select></label><label>Категория<input required value={b.category} onChange={e=>f.change('category',e.target.value)}/></label></>}
    {mode==='transfer'&&<><AccountSelect accounts={accounts} label="Откуда" value={b.from_account_id} onChange={v=>f.change('from_account_id',v)}/><AccountSelect accounts={accounts} label="Куда" exclude={b.from_account_id} value={b.to_account_id} onChange={v=>f.change('to_account_id',v)}/><p className="finHint">Два связанных движения. Прибыль компании не меняется.</p></>}
    {['operation','transfer'].includes(mode)&&<><label>Сумма, ₸<input required type="number" min="0.01" step="0.01" value={b.amount} onChange={e=>f.change('amount',e.target.value)}/></label><label>Назначение<input required minLength={3} value={b.comment} onChange={e=>f.change('comment',e.target.value)}/></label></>}
    {mode==='adjustment'&&<><p>{account.name}: {financeMoney(account.balance)}</p><label>Изменение остатка, ₸<input required type="number" step="0.01" placeholder="Например, -2500 или 10000" value={b.delta} onChange={e=>f.change('delta',e.target.value)}/></label><p className="finHint">После корректировки: {financeMoney(Number(account.balance)+Number(b.delta||0))}. Корректировка не является доходом или расходом P&L.</p></>}
    {mode==='reverse'&&<p className="finHint">{entry.transfer_group_id?'Будут созданы две обратные записи перевода.':'Будет создана обратная запись.'} Исходная операция №{entry.id} на {financeMoney(entry.amount)} останется в истории.</p>}
    {['adjustment','reverse'].includes(mode)&&<label>Причина<input required minLength={3} value={b.reason} onChange={e=>f.change('reason',e.target.value)}/></label>}
    {mode!=='reverse'&&<label>Дата<input required type="date" max={financeDate()} value={b.occurred_at} onChange={e=>f.change('occurred_at',e.target.value)}/></label>}
    {mode!=='transfer'&&<label>Документ-основание<input required={mode==='adjustment'} value={b.document_reference} onChange={e=>f.change('document_reference',e.target.value)} placeholder="Номер акта, чека или платёжного документа"/></label>}
  </fieldset><FormActions busy={f.busy} error={f.error} close={close}/></form></FinanceDialog>;
}
