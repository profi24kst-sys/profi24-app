import React,{useEffect,useState} from 'react';
import {financeApi,financeMoney as money} from './finance-client.js';
import './order-parts.css';

const statuses={REQUESTED:'Запланирована',ORDERED:'Заказана',IN_TRANSIT:'В пути',RECEIVED:'Получена',ISSUED:'Выдана инженеру',INSTALLED:'Установлена',CANCELLED:'Отменена'};

export function OrderPartRows({parts,requestId,version}) {
  const [purchases,setPurchases]=useState([]),[error,setError]=useState(''),[loading,setLoading]=useState(false),[retry,setRetry]=useState(0);
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
    {parts.map(part=>{
      const purchase=byPart.get(String(part.id)),paid=!!part.payment_account_id;
      return <div className="o360Row o360PartRow" key={part.id} data-part-id={part.id}>
        <div className="o360PartMain"><strong>{part.name}</strong><span className="o360PartStatus">{statuses[part.status]||'Статус не определён'}</span><small>{part.qty} шт. · Цена клиенту: {money(Number(part.qty)*Number(part.sale_price))}</small>
          {purchase?<dl className="o360PartPayment"><div><dt>Оплачено</dt><dd>{money(purchase.amount)} · операция №{purchase.id}</dd></div><div><dt>Источник оплаты</dt><dd>{purchase.account_name}</dd></div><div><dt>Купил</dt><dd>{purchase.created_by_name||'Сотрудник'} · {new Date(purchase.created_at).toLocaleString('ru-RU')}</dd></div><div><dt>Чек / документ</dt><dd>{purchase.document_reference||'Не указан'}</dd></div></dl>:
            <small className="finHint">{paid?(loading?'Загрузка оплаты…':error?'Не удалось получить сведения об оплате.':'Покупка оплачена. Подробности доступны ответственному за счёт и OWNER.'):'Денежная покупка к этой записи не привязана.'}</small>}
        </div>
      </div>;
    })}
  </div>;
}
