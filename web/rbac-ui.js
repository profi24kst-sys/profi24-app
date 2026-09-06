const ROLE_LABELS={
  OWNER:'Собственник',
  SUPERVISOR:'Управляющий',
  ACCOUNTANT:'Бухгалтер',
  MANAGER:'Менеджер',
  ENGINEER:'Инженер',
  TRAINEE:'Стажёр'
};
const current=()=>{try{return JSON.parse(localStorage.user||'null')}catch{return null}};
const role=()=>current()?.role||'';
const allowed=(...roles)=>roles.includes(role());
const text=node=>(node?.textContent||'').trim();
const hide=node=>{if(node&&!node.dataset.rbacHidden){node.dataset.rbacHidden='1';node.style.display='none'}};
const show=node=>{if(node?.dataset.rbacHidden){delete node.dataset.rbacHidden;node.style.display=''}};

function navPolicy(){
  const r=role();
  document.querySelectorAll('aside nav button').forEach(button=>{
    const name=text(button.querySelector('span'));
    let visible=true;
    if(name==='Финансы')visible=['OWNER','SUPERVISOR','ACCOUNTANT','MANAGER'].includes(r);
    if(name==='Сотрудники')visible=r==='OWNER';
    if(name==='Отчеты'&&r==='TRAINEE')visible=false;
    visible?show(button):hide(button);
  });
  document.querySelectorAll('.profile small').forEach(node=>{
    if(ROLE_LABELS[text(node)])node.textContent=ROLE_LABELS[text(node)];
  });
}

function actionPolicy(){
  const r=role();
  document.querySelectorAll('button').forEach(button=>{
    const t=text(button);
    if(t.includes('Новый заказ')&&!['OWNER','SUPERVISOR','MANAGER'].includes(r))hide(button);
    if(t.includes('Сохранить назначение')&&!['OWNER','SUPERVISOR','MANAGER'].includes(r))hide(button);
    if(t.includes('Применить скидку')&&!['OWNER','SUPERVISOR','MANAGER'].includes(r))hide(button);
    if(t.includes('Добавить работу')&&r==='TRAINEE')hide(button);
    if(t==='Добавить'&&r==='TRAINEE')hide(button);
    if(t.includes('Сохранить диагностику')&&!['OWNER','SUPERVISOR','MANAGER','ENGINEER'].includes(r))hide(button);
    if(t.includes('Открыть завершение ремонта')&&!['OWNER','SUPERVISOR','MANAGER','ENGINEER'].includes(r))hide(button);
    if((t.includes('Принять оплату')||t.includes('Вернуть оплату'))&&!['OWNER','SUPERVISOR','ACCOUNTANT','MANAGER'].includes(r))hide(button);
  });
  if(r==='TRAINEE'){
    document.querySelectorAll('.ordertabs button').forEach(button=>{
      const t=text(button);
      if(['Работы','Запчасти','Оплаты'].some(name=>t.includes(name)))hide(button);
    });
  }
  if(r==='ACCOUNTANT'){
    document.querySelectorAll('.ordertabs button').forEach(button=>{
      const t=text(button);
      if(['Работы','Запчасти'].some(name=>t.includes(name)))hide(button);
    });
  }
}

function staffPolicy(){
  if(role()!=='OWNER')return;
  document.querySelectorAll('select').forEach(select=>{
    const values=[...select.options].map(o=>o.value||o.textContent);
    if(!(values.includes('ENGINEER')&&values.includes('MANAGER')&&values.includes('OWNER')))return;
    for(const code of ['SUPERVISOR','ACCOUNTANT','TRAINEE']){
      if(values.includes(code))continue;
      const option=document.createElement('option');option.value=code;option.textContent=ROLE_LABELS[code];
      select.insertBefore(option,[...select.options].find(o=>(o.value||o.textContent)==='MANAGER')||null);
    }
    for(const option of select.options){
      const code=option.value||option.textContent;
      if(ROLE_LABELS[code])option.textContent=ROLE_LABELS[code];
    }
  });
  document.querySelectorAll('.staffrow span').forEach(node=>{if(ROLE_LABELS[text(node)])node.textContent=ROLE_LABELS[text(node)]});
}

let queued=false;
function apply(){queued=false;navPolicy();actionPolicy();staffPolicy();}
function schedule(){if(queued)return;queued=true;queueMicrotask(apply)}
new MutationObserver(schedule).observe(document.documentElement,{childList:true,subtree:true});
window.addEventListener('storage',schedule);
window.addEventListener('profi24:session-role-changed',schedule);
schedule();
