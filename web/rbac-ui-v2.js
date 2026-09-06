const ROLE_LABELS={OWNER:'Собственник',SUPERVISOR:'Управляющий',ACCOUNTANT:'Бухгалтер',MANAGER:'Менеджер',ENGINEER:'Инженер',TRAINEE:'Стажёр'};
const getUser=()=>{try{return JSON.parse(localStorage.user||'null')}catch{return null}};
const getRole=()=>getUser()?.role||'';
const nodeText=node=>(node?.textContent||'').trim();
const setVisible=(node,visible)=>{if(node)node.hidden=!visible};

function updateNavigation(){
  const role=getRole();
  document.querySelectorAll('aside nav button').forEach(button=>{
    const name=nodeText(button.querySelector('span'));
    if(name==='Финансы')setVisible(button,['OWNER','SUPERVISOR','ACCOUNTANT','MANAGER'].includes(role));
    if(name==='Сотрудники')setVisible(button,role==='OWNER');
    if(name==='Отчеты'&&role==='TRAINEE')setVisible(button,false);
  });
  document.querySelectorAll('.profile small').forEach(node=>{const code=nodeText(node);if(ROLE_LABELS[code])node.textContent=ROLE_LABELS[code]});
}

function updateOrderActions(){
  const role=getRole();
  document.querySelectorAll('button').forEach(button=>{
    const value=nodeText(button);
    if(value.includes('Новый заказ'))setVisible(button,['OWNER','SUPERVISOR','MANAGER'].includes(role));
    if(value.includes('Сохранить назначение'))setVisible(button,['OWNER','SUPERVISOR','MANAGER'].includes(role));
    if(value.includes('Применить скидку'))setVisible(button,['OWNER','SUPERVISOR','MANAGER'].includes(role));
    if(value.includes('Сохранить диагностику'))setVisible(button,['OWNER','SUPERVISOR','MANAGER','ENGINEER'].includes(role));
    if(value.includes('Открыть завершение ремонта'))setVisible(button,['OWNER','SUPERVISOR','MANAGER','ENGINEER'].includes(role));
  });
  document.querySelectorAll('.ordertabs button').forEach(button=>{
    const value=nodeText(button);
    if(role==='TRAINEE'&&['Работы','Запчасти','Оплаты'].some(x=>value.includes(x)))setVisible(button,false);
    if(role==='ACCOUNTANT'&&['Работы','Запчасти'].some(x=>value.includes(x)))setVisible(button,false);
  });
  document.querySelectorAll('.card').forEach(card=>{
    const title=nodeText(card.querySelector('.cardhead b'));
    if(['ENGINEER','TRAINEE'].includes(role)&&title==='Финансы')setVisible(card,false);
    if(role==='TRAINEE'&&['Добавить работу','Работы в заказе','Добавить запчасть','Запчасти','Принять оплату'].includes(title))setVisible(card,false);
    if(role==='ACCOUNTANT'&&['Диагностика','Завершение ремонта','Добавить работу','Работы в заказе','Добавить запчасть','Запчасти','Управление'].includes(title))setVisible(card,false);
  });
}

function updateStaffRoleSelect(){
  if(getRole()!=='OWNER')return;
  document.querySelectorAll('select').forEach(select=>{
    const codes=[...select.options].map(o=>o.value||o.textContent);
    if(!(codes.includes('ENGINEER')&&codes.includes('MANAGER')&&codes.includes('OWNER')))return;
    for(const option of select.options){
      const code=option.value||option.textContent;
      if(ROLE_LABELS[code]){option.value=code;option.textContent=ROLE_LABELS[code]}
    }
    for(const code of ['SUPERVISOR','ACCOUNTANT','TRAINEE']){
      if([...select.options].some(o=>o.value===code))continue;
      const option=document.createElement('option');option.value=code;option.textContent=ROLE_LABELS[code];
      const before=[...select.options].find(o=>o.value==='MANAGER');select.insertBefore(option,before||null);
    }
  });
  document.querySelectorAll('.staffrow span').forEach(node=>{const code=nodeText(node);if(ROLE_LABELS[code])node.textContent=ROLE_LABELS[code]});
}

let scheduled=false;
function apply(){scheduled=false;updateNavigation();updateOrderActions();updateStaffRoleSelect()}
function schedule(){if(scheduled)return;scheduled=true;queueMicrotask(apply)}
new MutationObserver(schedule).observe(document.documentElement,{childList:true,subtree:true});
window.addEventListener('storage',schedule);
window.addEventListener('profi24:session-role-changed',schedule);
schedule();
