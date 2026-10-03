import React,{useEffect,useState} from 'react';
import {financeApi} from './finance-client.js';

export function CategorySelect({requestId,type='EXPENSE',accountType,value,onChange,onValidityChange}){
  const [categories,setCategories]=useState([]),[error,setError]=useState(''),[retry,setRetry]=useState(0),[loading,setLoading]=useState(true);
  useEffect(()=>{
    const controller=new AbortController();setCategories([]);setError('');setLoading(true);
    financeApi(requestId?'/requests/'+requestId+'/categories':'/categories',{signal:controller.signal})
      .then(rows=>{if(!controller.signal.aborted)setCategories(rows);})
      .catch(e=>{if(!controller.signal.aborted)setError(e.message);})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[requestId,retry]);
  const available=categories.filter(c=>c.is_active&&!c.is_system&&c.type===type&&(!accountType||c.payment_methods.includes(accountType)));
  const valid=!loading&&!error&&available.some(c=>c.code===value);
  useEffect(()=>{onValidityChange?.(Boolean(valid));},[valid,onValidityChange]);
  return <><label>Статья ДДС<select required disabled={loading||!!error} value={available.some(c=>c.code===value)?value:''} onChange={e=>onChange(e.target.value)}><option value="">{loading?'Загрузка статей…':'Выберите статью'}</option>{available.map(c=><option key={c.code} value={c.code}>{c.name}</option>)}</select></label>{error&&<p role="alert" className="finError">{error} <button type="button" onClick={()=>setRetry(x=>x+1)}>Повторить</button></p>}{!loading&&!error&&!available.length&&<p className="finHint">Нет доступных статей для этой операции и способа оплаты.</p>}</>;
}
