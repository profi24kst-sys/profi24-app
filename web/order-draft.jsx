import React,{useEffect,useRef,useState} from 'react';
import {draftUser,draftSession,normalizeDraft,equalDraft,readDraft,writeDraft,clearDraft} from './order-draft-store.js';
import './order-draft.css';
export function useOrderDraft(section,empty={}){
 const state=useRef({scope:null,session:null,baseline:normalizeDraft(section,empty),value:normalizeDraft(section,empty),dirty:false});
 const [value,setValueState]=useState(()=>normalizeDraft(section,empty)),[candidate,setCandidate]=useState(null),[status,setStatus]=useState(''),[conflict,setConflict]=useState(false);
 function current(){const s=state.current;return s.scope&&s.scope.userId===draftUser()&&s.session===draftSession()}
 function initialize(orderId,serverValue,userId=draftUser(),session=draftSession()){
  if(userId!==draftUser()||session!==draftSession())return;
  const scope={userId,orderId,section},baseline=normalizeDraft(section,serverValue),old=state.current;
  // A background refresh must not replace text typed in this same form.
  if(old.scope?.userId===userId&&String(old.scope?.orderId)===String(orderId)&&old.session===session&&old.dirty){setConflict(!equalDraft(section,old.baseline,baseline));return}
  state.current={scope,session,baseline,value:baseline,dirty:false};setValueState(baseline);setCandidate(null);setStatus('');setConflict(false);
  try{const saved=readDraft(localStorage,scope);if(saved){if(equalDraft(section,saved.values,baseline))clearDraft(localStorage,scope);else{setCandidate(saved);setConflict(!equalDraft(section,saved.baseline,baseline));}}}catch{setStatus('unavailable')}
 }
 function setValue(next){
  const s=state.current,updated=normalizeDraft(section,typeof next==='function'?next(s.value):next);s.value=updated;setValueState(updated);setCandidate(null);
  if(!current())return;
  s.dirty=!equalDraft(section,s.baseline,updated);
  try{const saved=writeDraft(localStorage,s.scope,s.baseline,updated);setStatus(saved?'saved':'')}catch{setStatus('unavailable')}
 }
 function restore(){if(!candidate||!current())return;setValue(candidate.values)}
 function discard(){if(!current())return;try{clearDraft(localStorage,state.current.scope);state.current.dirty=false;state.current.value=state.current.baseline;setValueState(state.current.baseline);setCandidate(null);setConflict(false);setStatus('')}catch{setStatus('unavailable')}}
 function ticket(){return {scope:{...state.current.scope},session:state.current.session}}
 function matches(t){return !t||(t.session===state.current.session&&t.scope.userId===state.current.scope?.userId&&String(t.scope.orderId)===String(state.current.scope?.orderId))}
 function saved(submitted,serverValue=submitted,context){
  if(!current()||!matches(context))return;
  const s=state.current;
  try{clearDraft(localStorage,s.scope,submitted);s.baseline=normalizeDraft(section,serverValue);
   if(equalDraft(section,s.value,submitted)){s.value=s.baseline;setValueState(s.baseline)}
   s.dirty=!equalDraft(section,s.value,s.baseline);
   if(s.dirty){writeDraft(localStorage,s.scope,s.baseline,s.value);setStatus('saved')}else{setCandidate(null);setStatus('');setConflict(false)}
  }catch{setStatus('unavailable')}
 }
 function savedFields(confirmed,context){
  if(!current()||!matches(context))return;
  const s=state.current,nextBaseline={...s.baseline,...confirmed};
  s.baseline=normalizeDraft(section,nextBaseline);s.dirty=!equalDraft(section,s.value,s.baseline);
  try{writeDraft(localStorage,s.scope,s.baseline,s.value);setStatus(s.dirty?'saved':'');setCandidate(null);setConflict(false)}catch{setStatus('unavailable')}
 }
 useEffect(()=>{
  const check=()=>{if(state.current.scope&&!current()){state.current.scope=null;state.current.dirty=false;setValueState(normalizeDraft(section,empty));setCandidate(null);setStatus('');setConflict(false)}};
  const timer=setInterval(check,250);window.addEventListener('storage',check);window.addEventListener('profi24:session-expired',check);
  return()=>{clearInterval(timer);window.removeEventListener('storage',check);window.removeEventListener('profi24:session-expired',check)};
 },[]);
 return {value,setValue,initialize,candidate,status,conflict,restore,discard,saved,savedFields,ticket};
}
export function DraftNotice({draft}){
 if(!draft.candidate&&!draft.status)return null;
 return <div className="orderDraftNotice" role="status"><span>{draft.status==='unavailable'?'Черновик не удалось сохранить. Не закрывайте форму до сохранения на сервере.':draft.candidate?'Найден несохранённый черновик. Продолжить с места?':'Черновик сохранён на этом устройстве.'}{draft.conflict&&' Данные заказа изменились; проверьте текст перед сохранением.'}</span>{draft.candidate&&<button type="button" onClick={draft.restore}>Восстановить черновик</button>}{(draft.candidate||draft.status==='saved')&&<button type="button" onClick={draft.discard}>Удалить черновик</button>}</div>;
}
