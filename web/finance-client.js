export const financeMoney = value => new Intl.NumberFormat('ru-KZ',{minimumFractionDigits:0,maximumFractionDigits:2}).format(Number(value||0))+' ₸';
export const financeDate = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Almaty',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export const financeKey = () => globalThis.crypto?.randomUUID?.() || 'op-'+Date.now()+'-'+Math.random().toString(36).slice(2);
export const financeUser = () => {try{return JSON.parse(localStorage.getItem('user')||'null');}catch{return null;}};
export async function financeApi(path,{method='GET',body,key,signal}={}) {
  const response=await fetch('/finance-api/v1'+path,{method,signal,headers:{Authorization:'Bearer '+localStorage.token,...(body?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const json=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(json.error?.message||'Финансовый модуль недоступен. Повторите запрос.');
  return json.data;
}
export const accountTypes={BANK:'Расчётный счёт',CARD:'Корпоративная карта',CASH:'Наличная касса',ADVANCE:'Подотчёт',OTHER:'Прочее'};
export const operationNames={OPENING:'Стартовый остаток',MANUAL:'Операция',ORDER_EXPENSE:'Расход по заказу',PART_PURCHASE:'Покупка запчасти',PART_RETURN:'Возврат покупки',PAYMENT:'Оплата клиента',REFUND:'Возврат клиенту',TRANSFER:'Перевод',ADJUSTMENT:'Корректировка',REVERSAL:'Сторно'};
export async function coreMoneyApi(path,body,key) {
  const r=await fetch('/api/v1'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+localStorage.token,'Idempotency-Key':key},body:JSON.stringify(body)});
  const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error?.message||'Не удалось провести оплату');return data.data;
}
