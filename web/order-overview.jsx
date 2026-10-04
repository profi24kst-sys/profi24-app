import React from 'react';
import './order-overview.css';

const money=value=>new Intl.NumberFormat('ru-KZ',{minimumFractionDigits:0,maximumFractionDigits:2}).format(Number(value||0))+' ₸';
const date=value=>value?new Date(value).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
const types={REPAIR:'Ремонт',FIELD:'Выездной',PAID_WORKSHOP:'Платный стационар',PARTS:'Заказ запчастей',SALE:'Продажа'};
const partStates={REQUESTED:'Запланирована',ORDERED:'Заказана',IN_TRANSIT:'В пути',RECEIVED:'Получена',ISSUED:'Выдана',INSTALLED:'Установлена'};
const methods={CASH:'Наличные',CARD:'Карта',BANK:'Банк',BANK_TRANSFER:'Банк',KASPI:'Kaspi',ADVANCE:'Подотчёт',OTHER:'Другой способ',ACCOUNT:'Денежный счёт'};
const sections=[['o360-overview','Обзор'],['o360-works','Работы'],['o360-parts','Запчасти'],['o360-payments','Платежи'],['o360-files','Фото и файлы']];
export function OrderSectionNav({onHistory,historyButton,historyOpen}){
 function jump(id){const target=document.getElementById(id);target?.scrollIntoView({block:'start',behavior:'auto'});target?.focus({preventScroll:true})}
 return <nav className="o360SectionNav" aria-label="Разделы заказа">
  {sections.map(([id,label])=><button type="button" key={id} onClick={()=>jump(id)}>{label}</button>)}
  <button type="button" ref={historyButton} aria-controls="o360-history" aria-expanded={historyOpen} onClick={onHistory}>История</button>
 </nav>;
}
function Info({label,value}){return <div><dt>{label}</dt><dd>{value||'—'}</dd></div>}
export function OrderOverview({order}){
 const items=[...(order.works||[]).map(w=>({key:'work:'+w.id,type:'Работа',name:w.name,qty:w.qty,price:w.unit_price,state:w.performed_by_name||'Исполнитель не указан'})),...(order.parts||[]).filter(p=>p.status!=='CANCELLED').map(p=>({key:'part:'+p.id,type:'Запчасть',name:p.name,qty:p.qty,price:p.sale_price,state:partStates[p.status]||p.status||'—'}))];
 const paid=Number(order.paid||0),total=Number(order.total||0),balance=Math.max(0,total-paid),credit=Math.max(0,paid-total);
 return <>
  <section id="o360-overview" className="o360Overview" tabIndex={-1} aria-label="Обзор заказа">
   <div className="o360InfoColumns">
    <div><h3>Клиент и техника</h3><dl>
     <Info label="Телефон" value={order.phone}/><Info label="Адрес" value={order.address}/>
     <Info label="Техника" value={[order.category,order.brand,order.model].filter(Boolean).join(' ')}/><Info label="Серийный номер" value={order.serial_number}/>
     <Info label="Причина обращения" value={order.complaint}/>
    </dl></div>
    <div><h3>Ответственные и сроки</h3><dl>
     <Info label="Тип заказа" value={types[order.order_type]||(order.visit_type==='FIELD'?'Выездной':'Сервисный центр')}/>
     <Info label="Менеджер" value={order.manager_name}/><Info label="Инженер" value={order.engineer_name||'Не назначен'}/>
     <Info label="Дата выезда" value={date(order.scheduled_at)}/><Info label="Создан" value={date(order.created_at)}/>
    </dl></div>
   </div>
   <div className="o360MoneySummary" aria-label="Расчёт с клиентом">
    <div><span>Стоимость заказа</span><b>{total>0?money(total):'Не сформирована'}</b></div>
    <div><span>Оплачено с учётом возвратов</span><b>{money(paid)}</b></div>
    <div className={balance>0?'debt':''}><span>{credit>0?'Переплата':total>0?'Осталось оплатить':'Оплата после расчёта'}</span><b>{credit>0?money(credit):money(balance)}</b></div>
   </div>
   <h3>Товары и услуги</h3>
   {items.length?<div className="o360OverviewTable"><table aria-label="Работы и запчасти в смете"><thead><tr><th>Тип</th><th>Наименование</th><th>Количество</th><th>Цена</th><th>Сумма</th><th>Исполнитель / состояние</th></tr></thead><tbody>{items.map(item=><tr key={item.key}><td>{item.type}</td><td>{item.name}</td><td>{Number(item.qty||0).toLocaleString('ru-RU')}</td><td>{money(item.price)}</td><td>{money(Number(item.qty||0)*Number(item.price||0))}</td><td>{item.state}</td></tr>)}</tbody></table></div>:<p className="o360OverviewEmpty">Работы и запчасти пока не добавлены. Перейдите в нужный раздел выше.</p>}
   <p className="o360OverviewHint">Скидка: {money(order.discount_amount)}. Возвращённые и отменённые запчасти исключены из сметы. Стоимость заказа взята из расчёта CRM.</p>
  </section>
  <section id="o360-payments" className="o360Overview" tabIndex={-1} aria-label="Платежи заказа">
   <h3>Платежи и возвраты</h3>
   {order.payments?.length?<div className="o360OverviewTable"><table aria-label="История платежей заказа"><thead><tr><th>Операция</th><th>Дата</th><th>Счёт / способ</th><th>Документ</th><th>Сотрудник</th><th>Сумма</th></tr></thead><tbody>{order.payments.map(payment=><tr key={payment.id} className={payment.kind==='REFUND'?'refund':''}><td>{payment.kind==='REFUND'?'Возврат':'Оплата'} №{payment.id}{payment.source_payment_id&&<small>к оплате №{payment.source_payment_id}</small>}</td><td>{date(payment.created_at)}</td><td>{payment.account_name||methods[payment.method]||payment.method||'—'}</td><td>{payment.document_reference||payment.reference||'—'}</td><td>{payment.created_by_name||'—'}</td><td>{payment.kind==='REFUND'?'−':'+'}{money(payment.amount)}</td></tr>)}</tbody></table></div>:<p className="o360OverviewEmpty">Платежей по заказу пока нет.</p>}
  </section>
 </>;
}
