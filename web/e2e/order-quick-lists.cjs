// All APIs are mocked: no customer records or preferences are written.
const assert=require('node:assert/strict'),{chromium}=require('playwright');
const BASE=process.env.BASE_URL||'http://127.0.0.1:5173';
(async()=>{
 const browser=await chromium.launch({headless:true}),context=await browser.newContext({serviceWorkers:'block',viewport:{width:1366,height:900}}),page=await context.newPage();
 const errors=[],writes=[],queries=[];let failMeta=true;
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{localStorage.user=JSON.stringify({id:801,name:'UX Tester',role:'OWNER'});localStorage.token='synthetic-ux'});
 await page.route(/\/(?:api\/v1|[^/]+-api\/)/,async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname;
  if(!['GET','HEAD'].includes(request.method())){writes.push(path);return route.fulfill({status:403,json:{error:{message:'No writes allowed'}}})}
  if(path==='/api/v1/directory/order-views')return route.fulfill({status:failMeta?503:200,json:failMeta?{error:{message:'Synthetic lists unavailable'}}:{data:[{id:1,name:'Мой стационар',filters:{status:'PART',brand:'BOSCH',engineer_id:91,order_type:'PAID_WORKSHOP',only_mine:true,search:'fixture'}}],meta:{columns:['number','customer','complaint','engineer','status','total'],fields:[],brands:['BOSCH','LG'],engineers:[{id:91,name:'Тестовый инженер'}],contracts:[]}}});
  if(path==='/api/v1/directory/orders'){
   queries.push(url.searchParams);
   return route.fulfill({json:{data:[{id:1,number:'UX-001',status:'WAITING_PART',customer_name:'Тестовый клиент',phone:'',brand:'BOSCH',complaint:'Тестовая неисправность',engineer_name:'Тестовый инженер',total:100}],meta:{total:1,page:1,pages:1,counts:{active:1,part:1}}}});
  }
  if(path==='/api/v1/directory/orders/export')return route.fulfill({body:'synthetic export',headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}});
  if(path.includes('/workflow-api/'))return route.fulfill({json:{data:{status:'WAITING_PART',next:null}}});
  return route.fulfill({json:{data:path.includes('/dashboard')?{}:[]}});
 });
 async function changed(action,expected){
  const response=page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname==='/api/v1/directory/orders'&&Object.entries(expected).every(([k,v])=>(u.searchParams.get(k)||'')===v)});
  await action();assert.equal((await response).status(),200);
 }
 try{
  await page.goto(BASE+'/orders',{waitUntil:'networkidle'});
  const panel=page.getByRole('region',{name:'Представления заказов'});
  await panel.getByRole('alert').filter({hasText:'Synthetic lists unavailable'}).waitFor();
  failMeta=false;await panel.getByRole('button',{name:'Повторить загрузку списков',exact:true}).click();
  const brands=panel.getByRole('group',{name:'Бренды',exact:true}),engineers=panel.getByRole('group',{name:'Исполнители',exact:true});
  await brands.getByRole('button',{name:'BOSCH',exact:true}).waitFor();
  assert.equal(await panel.getByLabel('Фильтр по контракту').isVisible(),false);
  assert.equal(await panel.getByLabel('Название представления').isVisible(),false);
  await changed(()=>brands.getByRole('button',{name:'BOSCH',exact:true}).click(),{brand:'BOSCH',status:'ACTIVE',page:'1'});
  await changed(()=>engineers.getByRole('button',{name:'Тестовый инженер',exact:true}).click(),{brand:'BOSCH',engineer_id:'91'});
  await changed(()=>page.getByRole('tab',{name:/Ждут деталь/}).click(),{brand:'BOSCH',engineer_id:'91',status:'PART'});
  assert.equal(await brands.getByRole('button',{name:'BOSCH',exact:true}).getAttribute('aria-pressed'),'true');
  await changed(()=>page.getByRole('textbox',{name:'Поиск по списку'}).fill('fixture'),{search:'fixture',brand:'BOSCH',engineer_id:'91',status:'PART'});
  await changed(()=>panel.getByRole('button',{name:'Мои заказы',exact:true}).click(),{only_mine:'true',search:'fixture',brand:'BOSCH',engineer_id:'91'});
  await changed(()=>panel.getByRole('button',{name:'Убрать фильтр Бренд: BOSCH',exact:true}).click(),{brand:'',search:'fixture',engineer_id:'91',status:'PART',only_mine:'true'});
  await changed(()=>panel.getByRole('button',{name:'Сбросить фильтры',exact:true}).click(),{status:'ACTIVE',search:'',brand:'',engineer_id:'',only_mine:''});
  await changed(()=>panel.getByRole('button',{name:'Мой стационар',exact:true}).click(),{status:'PART',brand:'BOSCH',engineer_id:'91',order_type:'PAID_WORKSHOP',only_mine:'true',search:'fixture',page:'1'});
  await panel.getByRole('button',{name:'Убрать фильтр Тип: Стационар',exact:true}).waitFor();
  const exported=page.waitForRequest(r=>new URL(r.url()).pathname==='/api/v1/directory/orders/export');
  await page.getByRole('button',{name:'Excel (.xlsx)',exact:true}).click();
  const exportQuery=new URL((await exported).url()).searchParams;
  for(const [key,value] of Object.entries({status:'PART',brand:'BOSCH',engineer_id:'91',order_type:'PAID_WORKSHOP',only_mine:'true',search:'fixture'}))assert.equal(exportQuery.get(key),value,'Export must match the displayed filters: '+key);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await brands.getByRole('button',{name:'BOSCH',exact:true}).isVisible(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'Page should fit a phone; the table scrolls inside its container');
  await brands.getByRole('button',{name:'Все бренды',exact:true}).focus();
  await changed(()=>brands.getByRole('button',{name:'Все бренды',exact:true}).press('Enter'),{brand:'',engineer_id:'91',status:'PART'});
  assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);assert.ok(queries.length>5);
  console.log('ORDER_QUICK_LISTS: ok');
 }finally{await context.close();await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
