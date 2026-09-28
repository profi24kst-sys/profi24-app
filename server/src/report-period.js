function dateOnly(value,name){
  const text=String(value||'').trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(text))throw Object.assign(new Error('Некорректная дата '+name),{code:'VALIDATION',statusCode:422});
  const date=new Date(text+'T00:00:00.000Z');
  if(Number.isNaN(date.getTime())||date.toISOString().slice(0,10)!==text)throw Object.assign(new Error('Некорректная дата '+name),{code:'VALIDATION',statusCode:422});
  return date;
}
const ymd=date=>date.toISOString().slice(0,10);
export function reportPeriod(query={}){
  if(!query.from&&!query.to)return null;
  if(!query.from||!query.to)throw Object.assign(new Error('Укажите начало и конец периода'),{code:'VALIDATION',statusCode:422});
  const from=dateOnly(query.from,'начала периода'),toInclusive=dateOnly(query.to,'конца периода');
  if(toInclusive<from)throw Object.assign(new Error('Конец периода не может быть раньше начала'),{code:'VALIDATION',statusCode:422});
  const to=new Date(toInclusive.getTime()+86400000);
  const days=Math.round((to-from)/86400000);
  if(days>366)throw Object.assign(new Error('Период не может превышать 366 дней'),{code:'VALIDATION',statusCode:422});
  const previousTo=new Date(from),previousFrom=new Date(from.getTime()-days*86400000);
  return {from:ymd(from),to:ymd(toInclusive),start:from,end:to,previousStart:previousFrom,previousEnd:previousTo,previousFrom:ymd(previousFrom),previousTo:ymd(new Date(previousTo.getTime()-86400000)),days};
}
