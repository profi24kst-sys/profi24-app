import React,{useEffect,useState} from 'react';
import {financeApi,financeMoney as money,financeUser} from './finance-client.js';
import {FinanceDialog,FormActions,useFinanceForm} from './finance-forms.jsx';
import './order-parts.css';

const statuses={REQUESTED:'Запланирована',ORDERED:'Заказана',IN_TRANSIT:'В пути',RECEIVED:'Получена',ISSUED:'Выдана инженеру',INSTALLED:'Установлена',CANCELLED:'Возвращена / отменена'};

function ReturnPurchase({requestId,part,purchase,close,done}){
  const form=useFinanceForm({reason:'',document_reference:''}),body=form.form;
  const save=async(value,key)=>{
    await financeApi('/requests/'+requestId+'/part-purchases/'+part.id+'/return',{method:'POST',body:value,key});
    await done();close();
  };
  return <FinanceDialog title="Возврат покупки запчасти" close={()=>!form.busy&&close()}><form className="finForm" onSubmit={form.submit(save)}><fieldset disabled={form.busy}>
    <p><b>{part.name}</b><br/>На счёт «{purchase.account_name}» вернётся {money(purchase.amount)}.</p>
    <p className="finHint">Исходная покупка и чек останутся в истории. CRM создаст связанную обратную операцию и исключит деталь из стоимости заказа.</p>
    <label>Причина возврата<input required minLength={3} maxLength={500} value={body.reason} onChange={e=>form.change('reason',e.target.value)} placeholder="Например, поставщик принял неподошедшую деталь"/></label>
    <label>Документ возврата<input required maxLength={200} value={body.document_reference} onChange={e=>form.change('document_reference',e.target.value)} placeholder="Номер накладной, чека возврата или акта"/></label>
  </fieldset><FormActions busy={form.busy} error={form.error} close={close} label="Оформить возврат"/></form></FinanceDialog>;
}

function PartRow({part,purchase,requestId,onReturned,loading,error}){
  const [returnOpen,setReturnOpen]=useState(false),paid=!!part.payment_account_id,owner=financeUser()?.role==='OWNER';
  const canReturn=owner&&purchase&&!purchase.return_transaction_id&&!['ISSUED','INSTALLED'].includes(part.status);
  return <div className="o360Row o360PartRow" data-part-id={part.id}>
    <div className="o360PartMain"><strong>{part.name}</strong><span className="o360PartStatus">{statuses[part.status]||'Статус не определён'}</span><small>{part.qty} шт. · Цена клиенту: {money(Number(part.qty)*Number(part.sale_price))}</small>
      {purchase?<dl className="o360PartPayment"><div><dt>Оплачено</dt><dd>{money(purchase.amount)} · операция №{purchase.id}</dd></div><div><dt>Источник оплаты</dt><dd>{purchase.account_name}</dd></div><div><dt>Купил</dt><dd>{purchase.created_by_name||'Сотрудник'} · {new Date(purchase.created_at).toLocaleString('ru-RU')}</dd></div><div><dt>Чек / документ</dt><dd>{purchase.document_reference||'Не указан'}</dd></div>
        {purchase.return_transaction_id&&<><div><dt>Возврат</dt><dd>{money(purchase.amount)} · операция №{purchase.return_transaction_id}</dd></div><div><dt>Причина возврата</dt><dd>{purchase.return_reason}</dd></div><div><dt>Документ возврата</dt><dd>{purchase.return_document_reference}</dd></div><div><dt>Оформил возврат</dt><dd>{purchase.returned_by_name||'OWNER'} · {new Date(purchase.returned_at).toLocaleString('ru-RU')}</dd></div></>}
      </dl>:<small className="finHint">{paid?(loading?'Загрузка оплаты…':error?'Не удалось получить сведения об оплате.':'Покупка оплачена. Подробности доступны ответственному за счёт и OWNER.'):'Денежная покупка к этой записи не привязана.'}</small>}
      {canReturn&&<button type="button" className="o360PartReturn" onClick={()=>setReturnOpen(true)}>Оформить возврат покупки</button>}
      {owner&&purchase&&!purchase.return_transaction_id&&['ISSUED','INSTALLED'].includes(part.status)&&<small className="finHint">Деталь выдана или установлена. Сначала снимите её с ремонта.</small>}
    </div>
    {returnOpen&&<ReturnPurchase requestId={requestId} part={part} purchase={purchase} close={()=>setReturnOpen(false)} done={onReturned}/>}
  </div>;
}

export function OrderPartRows({parts,requestId,version,onSaved}){
  const [purchases,setPurchases]=useState([]),[error,setError]=useState(''),[loading,setLoading]=useState(false),[retry,setRetry]=useState(0);
  const reload=async()=>{setRetry(value=>value+1);await onSaved?.();};
  useEffect(()=>{
    const controller=new AbortController();setPurchases([]);setError('');setLoading(true);
    financeApi('/requests/'+requestId+'/part-purchases',{signal:controller.signal})
      .then(rows=>{if(!controller.signal.aborted)setPurchases(rows);})
      .catch(e=>{if(!controller.signal.aborted)setError(e.message);})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[requestId,version,retry]);
  const byPart=new Map(purchases.map(p=>[String(p.part_id),p]));
  return <div className="o360PartList">
    {error&&<p className="finError" role="alert">Сведения об оплате не загрузились: {error} <button type="button" onClick={()=>setRetry(v=>v+1)}>Повторить</button></p>}
    {!parts.length&&<p className="finHint">Запчастей пока нет. Выберите действие выше.</p>}
    {parts.map(part=><PartRow key={part.id} part={part} purchase={byPart.get(String(part.id))} requestId={requestId} onReturned={reload} loading={loading} error={error}/>)}
  </div>;
}
