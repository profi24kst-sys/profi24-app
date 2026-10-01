import {reportPeriod,reportPeriodMetadata} from '../report-period.js';
import {monthRange,reject} from './service.js';

const DAY=86400000;
export function financePeriod(query={}) {
  if(query.month!==undefined&&(query.from!==undefined||query.to!==undefined))reject('Выберите месяц или диапазон дат');
  let period;
  if(query.from!==undefined||query.to!==undefined){
    if(!query.from||!query.to)reject('Укажите начало и конец периода');
    period=reportPeriod(query);
  }else{
    const [start,end]=monthRange(query.month);
    period=reportPeriod({from:start,to:new Date(Date.parse(end+'T00:00:00Z')-DAY).toISOString().slice(0,10)});
  }
  // Cash postings are DATE; closed orders are TIMESTAMPTZ. Never truncate a local midnight's UTC instant to obtain a posting date.
  return {...period,dateStart:period.from,dateEnd:new Date(Date.parse(period.to+'T00:00:00Z')+DAY).toISOString().slice(0,10),metadata:reportPeriodMetadata(period)};
}
