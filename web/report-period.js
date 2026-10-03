const calendar=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Qostanay',year:'numeric',month:'2-digit',day:'2-digit'});
const ymd=d=>d.toISOString().slice(0,10);
export function presetRange(kind,now=new Date()){
 const p=Object.fromEntries(calendar.formatToParts(now).map(x=>[x.type,x.value]));
 const end=new Date(Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day)));let start;
 if(kind==='week'){start=new Date(end);start.setUTCDate(end.getUTCDate()-(end.getUTCDay()+6)%7)}
 else if(kind==='quarter')start=new Date(Date.UTC(end.getUTCFullYear(),Math.floor(end.getUTCMonth()/3)*3,1));
 else start=new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth(),1));
 return {kind,from:ymd(start),to:ymd(end)};
}
