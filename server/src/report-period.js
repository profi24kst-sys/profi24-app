export const REPORT_TIME_ZONE='Asia/Qostanay';
const DAY=86400000,ymd=date=>date.toISOString().slice(0,10);
const invalid=message=>Object.assign(new Error(message),{code:'VALIDATION',statusCode:422});
function dateOnly(value,name){
  const text=String(value||'').trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(text))throw invalid('Некорректная дата '+name);
  const date=new Date(text+'T00:00:00.000Z');
  if(Number.isNaN(date.getTime())||date.toISOString().slice(0,10)!==text)throw invalid('Некорректная дата '+name);
  return date;
}
const localClock=new Intl.DateTimeFormat('en-CA',{timeZone:REPORT_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
function midnight(date){
  // Resolve the IANA offset at this date, including Kazakhstan's 2024 change.
  const target=date.getTime();let instant=target;
  for(let i=0;i<3;i++){
    const p=Object.fromEntries(localClock.formatToParts(new Date(instant)).map(x=>[x.type,x.value]));
    const local=Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour),Number(p.minute),Number(p.second));
    const next=instant+target-local;if(next===instant)break;instant=next;
  }
  return new Date(instant);
}
function calendarMonth(date,shift){const d=new Date(date);d.setUTCMonth(d.getUTCMonth()+shift);return d}
export function reportPeriod(query={}){
  if(!query.from&&!query.to)return null;
  if(!query.from||!query.to)throw invalid('Укажите начало и конец периода');
  const from=dateOnly(query.from,'начала периода'),toInclusive=dateOnly(query.to,'конца периода');
  if(toInclusive<from)throw invalid('Конец периода не может быть раньше начала');
  const end=new Date(toInclusive.getTime()+DAY),days=Math.round((end-from)/DAY);
  if(days>366)throw invalid('Период не может превышать 366 дней');
  let previousFrom=new Date(from.getTime()-days*DAY),comparison='equal_days';
  if(from.getUTCDate()===1&&end.getTime()===calendarMonth(from,1).getTime()){
    previousFrom=calendarMonth(from,-1);comparison='calendar_month';
  }else if(from.getUTCDate()===1&&from.getUTCMonth()%3===0&&end.getTime()===calendarMonth(from,3).getTime()){
    previousFrom=calendarMonth(from,-3);comparison='calendar_quarter';
  }
  return {from:ymd(from),to:ymd(toInclusive),start:midnight(from),end:midnight(end),previousStart:midnight(previousFrom),previousEnd:midnight(from),previousFrom:ymd(previousFrom),previousTo:ymd(new Date(from.getTime()-DAY)),days,comparison,timeZone:REPORT_TIME_ZONE};
}
export function reportPeriodMetadata(period){
  return period?{from:period.from,to:period.to,previous_from:period.previousFrom,previous_to:period.previousTo,days:period.days,comparison:period.comparison,time_zone:period.timeZone}:null;
}
