const state={token:'',user:null,orders:[],customers:[],equipment:[]};
const el=id=>document.getElementById(id);
function visible(id,on){el(id).classList.toggle('hidden',!on)}
function msg(id,text,type){const n=el(id);n.textContent=text||'';n.classList.toggle('hidden',!text);if(type)n.className='alert '+type+(text?'':' hidden')}
function row(cells){const tr=document.createElement('tr');for(const value of cells){const td=document.createElement('td');td.textContent=String(value??'—');tr.append(td)}return tr}
function fill(id,records,mapping){const target=el(id);target.replaceChildren();if(!records.length){const tr=row(['Пока нет записей']);tr.firstChild.colSpan=5;target.append(tr);return}for(const record of records)target.append(row(mapping(record)))}
function money(n){return new Intl.NumberFormat('ru-KZ').format(Number(n)||0)+' ₸'}
async function request(path,options={}){
  const headers={'Content-Type':'application/json',...(state.token?{Authorization:'Bearer '+state.token}:{})};
  const res=await fetch(path,{...options,headers:{...headers,...options.headers},credentials:'same-origin'});
  let body={};try{body=await res.json()}catch{}
  if(!res.ok){const error=new Error(body.error?.message||'Ошибка соединения: '+res.status);error.code=body.error?.code;throw error}
  return body.data;
}
function showApp(){visible('login-panel',!state.user);visible('app-panel',!!state.user);el('user-line').textContent=state.user?state.user.name+' · '+state.user.role:''}
async function refresh(){
  msg('app-error','');
  try{
    const [orders,customers,equipment]=await Promise.all([
      request('/api/v1/requests'),request('/api/v1/customers'),request('/api/v1/equipment')
    ]);
    state.orders=Array.isArray(orders)?orders:[];state.customers=Array.isArray(customers)?customers:[];state.equipment=Array.isArray(equipment)?equipment:[];
    fill('orders-body',state.orders,o=>[o.number,o.customer_name||o.customer_id,o.complaint,o.status,money(o.total)]);
    fill('customers-body',state.customers,c=>[c.name,c.phone,c.address,c.request_count]);
    fill('equipment-body',state.equipment,d=>[d.category,d.brand,d.model,d.customer_name||d.customer_id]);
  }catch(error){msg('app-error',error.message)}
}
function selectTab(name){
  for(const button of document.querySelectorAll('[data-tab]'))button.classList.toggle('on',button.dataset.tab===name);
  for(const tab of ['orders','customers','equipment','create'])visible(tab+'-panel',tab===name);
}
for(const button of document.querySelectorAll('[data-tab]'))button.addEventListener('click',()=>selectTab(button.dataset.tab));
el('refresh-orders').addEventListener('click',refresh);
el('logout').addEventListener('click',async()=>{
  try{await request('/auth-api/v1/auth/logout',{method:'POST'})}catch{}
  state.token='';state.user=null;sessionStorage.removeItem('previewToken');sessionStorage.removeItem('previewUser');
  showApp();el('password').value='';
});
el('login-form').addEventListener('submit',async(event)=>{
  event.preventDefault();msg('login-error','');
  el('login-btn').disabled=true;
  try{
    const login=await request('/api/v1/auth/login',{
      method:'POST',body:JSON.stringify({email:el('email').value.trim(),password:el('password').value})
    });
    if(!login?.access_token||!login?.user)throw Error('Некорректный ответ авторизации');
    state.token=login.access_token;state.user=login.user;
    sessionStorage.setItem('previewToken',state.token);sessionStorage.setItem('previewUser',JSON.stringify(state.user));
    showApp();selectTab('orders');await refresh();
  }catch(error){msg('login-error',error.message)}
  finally{el('login-btn').disabled=false}
});
el('create-form').addEventListener('submit',async(event)=>{
  event.preventDefault();el('create-btn').disabled=true;
  msg('app-error','');msg('create-success','');
  let customer=null,equipment=null;
  try{
    customer=await request('/api/v1/customers',{method:'POST',body:JSON.stringify({
      name:el('customer-name').value.trim(),phone:el('customer-phone').value.trim(),
      address:el('customer-address').value.trim()
    })});
    equipment=await request('/api/v1/equipment',{method:'POST',body:JSON.stringify({
      customer_id:customer.id,category:el('device-category').value,
      brand:el('device-brand').value.trim(),model:el('device-model').value.trim()
    })});
    const order=await request('/api/v1/requests',{method:'POST',body:JSON.stringify({
      customer_id:customer.id,equipment_id:equipment.id,
      complaint:el('complaint').value.trim(),source:'OTHER',visit_type:'FIELD'
    })});
    el('create-form').reset();
    msg('create-success','Заявка '+order.number+' создана. Данные сохранены в отдельной тестовой базе.','good');
    await refresh();selectTab('orders');
  }catch(error){
    const partial=customer?' Клиент уже создан'+(equipment?', техника тоже создана.':'.')+' Проверьте списки перед повтором.':'';
    msg('app-error',error.message+partial);
  }finally{el('create-btn').disabled=false}
});
async function checkServer(){
  try{
    const response=await fetch('/preview-health',{cache:'no-store'});
    const status=await response.json();
    el('server-status').textContent=status.ready?'API и база готовы':'Ожидание настройки API';
    el('server-status').style.background=status.ready?'#e4f5e8':'#fff2db';
    if(!status.ready&&!state.user)msg('login-error','Сервер пока не готов: '+(status.backend||'ожидается запуск базы данных'));
  }catch{el('server-status').textContent='Проверка недоступна'}
}
(async()=>{
  state.token=sessionStorage.getItem('previewToken')||'';
  try{state.user=JSON.parse(sessionStorage.getItem('previewUser')||'null')}catch{}
  showApp();await checkServer();if(state.user)await refresh();
})();
