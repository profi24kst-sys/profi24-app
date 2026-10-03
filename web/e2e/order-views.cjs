// Every API call is intercepted: this scenario only changes synthetic preferences.
const assert=require('node:assert/strict'),{chromium}=require('playwright');
const BASE=process.env.BASE_URL||'http://127.0.0.1:5173';
(async()=>{
 const browser=await chromium.launch({headless:true}),context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
 const prefs=new Map(),errors=[];let failSave=true,lastQuery='',id=1;
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{if(!localStorage.user)localStorage.user=JSON.stringify({id:801,name:'Views Tester',role:'OWNER'});if(!localStorage.token)localStorage.token='synthetic-801'});
 await page.route(/\/(?:api\/v1|[^/]+-api\/)/,async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,who=request.headers().authorization||'',method=request.method();
  if(!prefs.has(who))prefs.set(who,{views:[],columns:['number','customer','complaint','engineer','status','total']});
  const personal=prefs.get(who),reply=(body,status=200)=>route.fulfill({status,json:body});
  if(path==='/api/v1/directory/order-views'){
   if(method==='GET')return reply({data:personal.views,meta:{columns:personal.columns,fields:[{code:'serial_note',label:'Комплектация',field_type:'TEXT'}],brands:['BOSCH'],engineers:[{id:91,name:'Synthetic engineer'}],contracts:[{id:51,number:'Synthetic contract'}]}});
   if(method==='POST'){
    if(failSave)return reply({data:null,error:{message:'Synthetic save failed'}},422);
    const body=request.postDataJSON(),saved={id:id++,...body};personal.views.push(saved);return reply({data:saved},201);
   }
  }
  if(path.startsWith('/api/v1/directory/order-views/')&&method==='DELETE'){personal.views=personal.views.filter(v=>v.id!==Number(path.split('/').pop()));return reply({data:{}})}
  if(path==='/api/v1/directory/order-columns'&&method==='PUT'){personal.columns=request.postDataJSON().columns;return reply({data:{columns:personal.columns}})}
  if(method!=='GET'&&method!=='HEAD')return reply({data:null,error:{message:'Unexpected write'}},403);
  if(path==='/api/v1/directory/orders'){
   lastQuery=url.search;
   return reply({data:[{id:1,number:'VIEW-SYNTHETIC',status:'WAITING_PART',customer_name:'Synthetic client',complaint:'Fixture',brand:'BOSCH',total:100,custom_fields:{serial_note:'<img src=x onerror=alert(1)>'}}],meta:{total:1,page:1,pages:1,counts:{active:1,part:1}}});
  }
  if(path.includes('/workflow-api/'))return reply({data:{status:'WAITING_PART',next:null}});
  return reply({data:path.includes('/dashboard')?{}:[]});
 });
 try{
  await page.goto(BASE+'/orders',{waitUntil:'networkidle'});
  const panel=page.getByRole('region',{name:'Представления заказов'});
  await panel.getByLabel('Фильтр по бренду').selectOption('BOSCH');
  await panel.getByLabel('Фильтр по исполнителю').selectOption('91');
  await panel.getByLabel('Мои заказы',{exact:true}).check();
  await page.getByRole('tab',{name:/Ждут деталь/}).click();
  await panel.getByLabel('Название представления').fill('BOSCH — мои');
  await panel.getByRole('button',{name:'Сохранить представление',exact:true}).click();
  await panel.getByRole('alert').filter({hasText:'Synthetic save failed'}).waitFor();
  assert.equal(await panel.getByLabel('Название представления').inputValue(),'BOSCH — мои');
  failSave=false;await panel.getByRole('button',{name:'Сохранить представление',exact:true}).click();
  await panel.getByRole('button',{name:'BOSCH — мои',exact:true}).waitFor();
  await panel.getByText('Колонки списка',{exact:true}).click();
  await panel.getByLabel('Неисправность',{exact:true}).uncheck();
  await panel.getByLabel('Комплектация',{exact:true}).check();
  await panel.getByRole('button',{name:'Сохранить колонки',exact:true}).click();await panel.getByRole('status').filter({hasText:'Колонки сохранены'}).waitFor();
  assert.equal(await page.locator('.dir-orders-config .thead').getByText('Неисправность',{exact:true}).count(),0);
  await page.locator('.dir-orders-config .thead').getByText('Комплектация',{exact:true}).waitFor();
  assert.equal(await page.locator('.dir-orders-config img').count(),0);
  await page.reload({waitUntil:'networkidle'});
  const applied=page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname==='/api/v1/directory/orders'&&u.searchParams.get('brand')==='BOSCH'&&u.searchParams.get('status')==='PART'});
  await panel.getByRole('button',{name:'BOSCH — мои',exact:true}).click();assert.equal((await applied).status(),200);
  assert.equal(await panel.getByLabel('Фильтр по исполнителю').inputValue(),'91');
  assert.ok(lastQuery.includes('only_mine=true'));
  assert.equal(await page.locator('.dir-orders-config .thead').getByText('Неисправность',{exact:true}).count(),0);
  await page.evaluate(()=>{localStorage.user=JSON.stringify({id:802,name:'Other employee',role:'MANAGER'});localStorage.token='synthetic-802'});await page.reload({waitUntil:'networkidle'});
  assert.equal(await panel.getByRole('button',{name:'BOSCH — мои',exact:true}).count(),0);
  await page.locator('.dir-orders-config .thead').getByText('Неисправность',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);console.log('ORDER_VIEWS: ok');
 }finally{await context.close();await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
