import React,{useCallback,useEffect,useMemo,useState} from 'react';
import {AlertCircle,CheckCircle2,Clock3,ClipboardList,Plus,RefreshCw,Search,X} from 'lucide-react';
import './task-center.css';

const ROOT='/order-tasks-api/v1';
const CAN_ASSIGN=new Set(['OWNER','SUPERVISOR','MANAGER']);
const PRIORITY={LOW:'Низкий',NORMAL:'Обычный',HIGH:'Высокий',URGENT:'Срочный'};
const STATUS={OPEN:'Новая',IN_PROGRESS:'В работе',DONE:'Выполнена',CANCELLED:'Отменена'};
const emptyForm=()=>({title:'',description:'',assigned_to:'',priority:'NORMAL',due_at:''});

async function taskApi(path,options={}){
  const token=localStorage.getItem('token');
  const response=await fetch(ROOT+path,{
    ...options,
    headers:{
      ...(token?{Authorization:'Bearer '+token}:{}),
      ...(options.body!=null?{'Content-Type':'application/json'}:{}),
      ...(options.headers||{})
    }
  });
  let payload={};
  try{payload=await response.json()}catch{}
  if(!response.ok)throw new Error(payload.error?.message||'Ошибка '+response.status);
  return payload;
}

function showDate(value){
  return value?new Date(value).toLocaleString('ru-KZ',{
    day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'
  }):'Без срока';
}

function Modal({title,subtitle,onClose,children}){
  useEffect(()=>{
    const closeOnEscape=event=>{if(event.key==='Escape')onClose()};
    document.addEventListener('keydown',closeOnEscape);
    return()=>document.removeEventListener('keydown',closeOnEscape);
  },[onClose]);
  return <div className="tcShade" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}>
    <section className="tcModal" role="dialog" aria-modal="true" aria-labelledby="tc-modal-title">
      <div className="tcModalHead"><div><h2 id="tc-modal-title">{title}</h2>{subtitle&&<p>{subtitle}</p>}</div>
        <button className="tcIconBtn" type="button" aria-label="Закрыть" onClick={onClose}><X size={19}/></button></div>
      {children}
    </section>
  </div>;
}

export function TaskCenter({user,reload}){
  const canAssign=CAN_ASSIGN.has(user?.role);
  const [items,setItems]=useState([]);
  const [assignees,setAssignees]=useState([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [filter,setFilter]=useState('active');
  const [priority,setPriority]=useState('');
  const [mine,setMine]=useState(false);
  const [assignee,setAssignee]=useState('');
  const [search,setSearch]=useState('');
  const [debouncedSearch,setDebouncedSearch]=useState('');
  const [meta,setMeta]=useState(null);
  const [createOpen,setCreateOpen]=useState(false);
  const [form,setForm]=useState(emptyForm);
  const [formError,setFormError]=useState('');
  const [saving,setSaving]=useState(false);
  const [completing,setCompleting]=useState(null);
  const [result,setResult]=useState('');
  const [workingId,setWorkingId]=useState(null);

  useEffect(()=>{
    const id=setTimeout(()=>setDebouncedSearch(search.trim()),250);
    return()=>clearTimeout(id);
  },[search]);

  const refresh=useCallback(async()=>{
    setLoading(true);setError('');
    const params=new URLSearchParams({status:filter,limit:'500'});
    if(priority)params.set('priority',priority);
    if(mine)params.set('mine','true');
    if(assignee)params.set('assigned_to',assignee);
    if(debouncedSearch)params.set('search',debouncedSearch);
    try{
      const payload=await taskApi('/tasks?'+params);
      setItems(payload.data||[]);
      setMeta(payload.meta||null);
    }catch(e){setError(e.message)}
    finally{setLoading(false)}
  },[filter,priority,mine,assignee,debouncedSearch]);

  useEffect(()=>{void refresh()},[refresh]);
  useEffect(()=>{
    if(!canAssign)return;
    let alive=true;
    taskApi('/tasks/assignees').then(payload=>{
      if(alive)setAssignees(payload.data||[]);
    }).catch(e=>{if(alive)setError(e.message)});
    return()=>{alive=false};
  },[canAssign]);

  const counts=useMemo(()=>({
    shown:items.length,
    overdue:items.filter(task=>task.overdue).length,
    urgent:items.filter(task=>task.priority==='URGENT'&&task.status!=='DONE'&&task.status!=='CANCELLED').length
  }),[items]);

  function openNew(){
    const initial=assignees.find(a=>Number(a.id)===Number(user.id))||assignees[0];
    setForm({...emptyForm(),assigned_to:initial?String(initial.id):''});
    setFormError('');
    setCreateOpen(true);
  }

  async function createTask(event){
    event.preventDefault();
    if(saving)return;
    setSaving(true);setFormError('');
    try{
      const due=form.due_at?new Date(form.due_at):null;
      if(due&&!Number.isFinite(due.getTime()))throw new Error('Проверьте срок выполнения');
      await taskApi('/tasks',{
        method:'POST',
        body:JSON.stringify({
          title:form.title.trim(),description:form.description.trim()||null,
          assigned_to:Number(form.assigned_to),priority:form.priority,
          due_at:due?due.toISOString():null
        })
      });
      setCreateOpen(false);
      await refresh();
      reload?.();
    }catch(e){setFormError(e.message)}
    finally{setSaving(false)}
  }

  async function changeStatus(task,status,completionResult=''){
    if(workingId!=null)return;
    setWorkingId(task.id);setFormError('');
    try{
      await taskApi('/tasks/'+task.id,{
        method:'PATCH',
        body:JSON.stringify({status,...(status==='DONE'?{result:completionResult.trim()}:{})})
      });
      setCompleting(null);setResult('');
      await refresh();
      reload?.();
    }catch(e){setFormError(e.message);setError(e.message)}
    finally{setWorkingId(null)}
  }

  function canComplete(task){
    return ['OWNER','SUPERVISOR'].includes(user.role)||
      Number(task.assigned_to)===Number(user.id)||
      (user.role==='MANAGER'&&Number(task.created_by)===Number(user.id));
  }

  return <div className="tcPage">
    <div className="tcHeading"><div><p>ЗАДАЧИ И ПОРУЧЕНИЯ</p><h2>Контроль работы команды</h2>
      <span>Задачи по заказам и отдельные поручения сотрудников в одном месте</span></div>
      <div className="tcHeadingButtons"><button type="button" className="tcSecondary" onClick={()=>void refresh()} disabled={loading}><RefreshCw size={17}/> Обновить</button>
        {canAssign&&<button type="button" className="tcPrimary" onClick={openNew}><Plus size={18}/> Новая задача</button>}</div>
    </div>

    <div className="tcSummary" aria-label="Статистика текущей выборки">
      <div><ClipboardList size={19}/><span>В выборке</span><strong>{counts.shown}</strong></div>
      <div className={counts.overdue?'tcDanger':''}><Clock3 size={19}/><span>Просрочены</span><strong>{counts.overdue}</strong></div>
      <div><AlertCircle size={19}/><span>Срочные</span><strong>{counts.urgent}</strong></div>
    </div>

    <div className="tcControls">
      <div className="tcTabs" role="group" aria-label="Статус задач">
        {[['active','Активные'],['overdue','Просроченные'],['done','Выполненные'],['all','Все']].map(([key,name])=>
          <button type="button" key={key} className={filter===key?'selected':''} onClick={()=>setFilter(key)} aria-pressed={filter===key}>{name}</button>)}
      </div>
      <label className="tcSearch"><Search size={16}/><input aria-label="Поиск задач" value={search}
        onChange={e=>setSearch(e.target.value)} placeholder="Найти задачу, сотрудника, заказ…"/></label>
      <label className="tcSelect"><span>Приоритет</span><select value={priority} onChange={e=>setPriority(e.target.value)}>
        <option value="">Все</option>{Object.entries(PRIORITY).map(([key,name])=><option value={key} key={key}>{name}</option>)}</select></label>
      {canAssign&&<label className="tcSelect"><span>Ответственный</span><select value={assignee} onChange={e=>setAssignee(e.target.value)}>
        <option value="">Все доступные</option>{assignees.map(a=><option value={a.id} key={a.id}>{a.name}</option>)}</select></label>}
      <label className="tcCheck"><input type="checkbox" checked={mine} onChange={e=>setMine(e.target.checked)}/> Только мои</label>
    </div>

    {error&&<div className="tcAlert" role="alert">{error}</div>}
    {loading?<div className="tcBlank">Загружаем задачи…</div>:items.length===0?
      <div className="tcBlank"><CheckCircle2 size={28}/><b>Задач по выбранным фильтрам нет</b>
        <span>{canAssign?'Создайте отдельное поручение или откройте задачу внутри заказа.':'Новые поручения появятся здесь после назначения.'}</span></div>:
      <div className="tcList">{items.map(task=><article className={'tcRow'+(task.overdue?' isOverdue':'')} key={task.id}>
        <div className="tcRowTop"><div className="tcTaskTitle"><strong>{task.title}</strong>
          <div className="tcTags"><span className={'tcStatus status-'+task.status}>{STATUS[task.status]||task.status}</span>
            <span className={'tcPriority pri-'+task.priority}>{PRIORITY[task.priority]||task.priority}</span>
            {task.overdue&&<span className="tcLate">ПРОСРОЧЕНО</span>}</div></div>
          <div className="tcRowActions">
            {task.status==='OPEN'&&canComplete(task)&&<button type="button" className="tcSecondary" disabled={workingId!=null}
              onClick={()=>void changeStatus(task,'IN_PROGRESS')}>Начать</button>}
            {['OPEN','IN_PROGRESS'].includes(task.status)&&canComplete(task)&&<button type="button" className="tcPrimary"
              disabled={workingId!=null} onClick={()=>{setFormError('');setResult('');setCompleting(task)}}>Завершить</button>}
          </div></div>
        {task.description&&<p className="tcDescription">{task.description}</p>}
        {task.result&&<p className="tcResult"><CheckCircle2 size={15}/> Результат: {task.result}</p>}
        <div className="tcTaskMeta"><span>Ответственный: <b>{task.assigned_name||'—'}</b></span>
          <span>Срок: <b>{showDate(task.due_at)}</b></span>
          {task.created_by_name&&<span>Поставил: {task.created_by_name}</span>}
          {task.request_id&&<a href={'/orders/'+task.request_id} title="Открыть заказ">
            Заказ {task.request_number||'#'+task.request_id}</a>}
        </div>
      </article>)}</div>}
    {meta?.has_more_possible&&<p className="tcLimit">Показаны первые {meta.limit} задач. Уточните фильтры или поиск.</p>}

    {createOpen&&<Modal title="Новое поручение" subtitle="Задача без привязки к заказу"
      onClose={()=>{if(!saving)setCreateOpen(false)}}>
      <form className="tcForm" onSubmit={createTask}>
        <label>Что нужно сделать <span>*</span><input autoFocus required maxLength={200} value={form.title}
          onChange={e=>setForm(f=>({...f,title:e.target.value}))} placeholder="Например, провести инвентаризацию"/></label>
        <label>Описание / ожидаемый результат<textarea rows={3} maxLength={4000} value={form.description}
          onChange={e=>setForm(f=>({...f,description:e.target.value}))} placeholder="Подробности задачи"/></label>
        <div className="tcFormGrid"><label>Ответственный <span>*</span>
          <select required value={form.assigned_to} onChange={e=>setForm(f=>({...f,assigned_to:e.target.value}))}>
            <option value="">Выберите сотрудника</option>
            {assignees.map(a=><option key={a.id} value={a.id}>{a.name} · {a.role}</option>)}
          </select></label>
          <label>Приоритет<select value={form.priority} onChange={e=>setForm(f=>({...f,priority:e.target.value}))}>
            {Object.entries(PRIORITY).map(([key,name])=><option key={key} value={key}>{name}</option>)}
          </select></label></div>
        <label>Срок выполнения<input type="datetime-local" value={form.due_at}
          onChange={e=>setForm(f=>({...f,due_at:e.target.value}))}/></label>
        {formError&&<div className="tcAlert" role="alert">{formError}</div>}
        <div className="tcModalFooter"><button type="button" className="tcSecondary" disabled={saving} onClick={()=>setCreateOpen(false)}>Отмена</button>
          <button type="submit" className="tcPrimary" disabled={saving||!form.title.trim()||!form.assigned_to}>{saving?'Создание…':'Поставить задачу'}</button></div>
      </form></Modal>}

    {completing&&<Modal title="Завершить задачу" subtitle={completing.title} onClose={()=>{if(workingId==null)setCompleting(null)}}>
      <form className="tcForm" onSubmit={e=>{e.preventDefault();void changeStatus(completing,'DONE',result)}}>
        <label>Результат выполнения <span>*</span><textarea autoFocus required rows={4} value={result}
          onChange={e=>setResult(e.target.value)} placeholder="Опишите, что именно сделано"/></label>
        {formError&&<div className="tcAlert" role="alert">{formError}</div>}
        <div className="tcModalFooter"><button type="button" className="tcSecondary" disabled={workingId!=null} onClick={()=>setCompleting(null)}>Отмена</button>
          <button className="tcPrimary" type="submit" disabled={workingId!=null||!result.trim()}>{workingId!=null?'Сохранение…':'Отметить выполненной'}</button></div>
      </form></Modal>}
  </div>;
}
