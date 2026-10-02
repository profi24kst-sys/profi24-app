import React from 'react';
const date=value=>new Date(value).toLocaleString('ru-RU');
export function SlaSummary({order}){
 if(!order?.sla_reaction_minutes)return null;
 const finished=['PAYMENT_REQUIRED','CLOSED','CANCELLED'].includes(order.status);
 return <section aria-label="SLA заказа"><h3>SLA заказа</h3>
  <p>Реакция: {order.sla_reacted_at?'Принят '+date(order.sla_reacted_at):'до '+date(order.sla_reaction_deadline)}</p>
  <p>Выполнение: {finished?'Контроль остановлен':order.sla_execution_deadline?'до '+date(order.sla_execution_deadline):'Отсчёт начнётся после принятия'}</p>
  {order.sla_paused_at&&!finished&&<p>На паузе с {date(order.sla_paused_at)}</p>}
 </section>;
}
