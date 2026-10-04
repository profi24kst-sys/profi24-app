// Synthetic API fixtures only. No customer or financial data is changed.
const assert=require('node:assert/strict'),{chromium}=require('playwright');
const BASE=process.env.BASE_URL||'http://127.0.0.1:5173';
(async()=>{
 const browser=await chromium.launch({headless:true}),context=await browser.newContext({serviceWorkers:'block',viewport:{width:1366,height:900}}),page=await context.newPage();
 const errors=[],unexpectedWrites=[],comments=[];let rejectComment=true,delayFirst=false,releaseFirst;
 const first={id:900001,number:'KST-2026-900001',status:'ACCEPTED',customer_name:'Синтетический клиент',phone:'0000000000',address:'Тестовый адрес',category:'Стиральная машина',brand:'BOSCH',model:'Fixture',serial_number:'SERIAL-UX',complaint:'<img src=x onerror=alert(1)>',diagnosis:'Тестовая диагностика',manager_name:'Тестовый менеджер',engineer_name:'Тестовый инженер',order_type:'FIELD',created_at:'2026-10-04T10:00:00Z',total:10000.75,paid:5950.25,discount_amount:100,works:[{id:1,name:'Тестовая работа',qty:1.5,unit_price:2000.5,performed_by_name:'Тестовый инженер'}],parts:[{id:1,name:'Тестовая деталь',qty:1,sale_price:3000,status:'REQUESTED'},{id:2,name:'Отменённая деталь',qty:1,sale_price:9000,status:'CANCELLED'}],payments:Array.from({length:6},(_,i)=>({id:11+i,kind:'PAYMENT',amount:1000,method:'CASH',account_name:'Тестовая касса',document_reference:'UX-'+i,created_by_name:'Тестовый кассир',created_at:'2026-10-04T10:00:00Z'})).concat({id:17,kind:'REFUND',amount:49.75,source_payment_id:11,method:'CASH',created_at:'2026-10-04T11:00:00Z'}),history:[{id:1,action:'REQUEST_CREATED',created_at:'2026-10-04T10:00:00Z'}]};
 const second={...first,id:900002,number:'KST-2026-900002',customer_name:'Второй тестовый клиент',total:0,paid:0,works:[],parts:[],payments:[],history:[]};
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{localStorage.user=JSON.stringify({id:801,name:'UX Tester',role:'OWNER'});localStorage.token='synthetic-card'});
 await page.route(/\/(?:api\/v1|[^/]+-api\/)/,async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  if(!['GET','HEAD'].includes(request.method())){
   if(path==='/order-tasks-api/v1/request/900001/comment'&&request.method()==='POST'){
    comments.push(request.postDataJSON());if(rejectComment)return route.fulfill({status:422,json:{error:{message:'Тестовая ошибка отправки'}}});
    first.history.push({id:2,action:'ORDER_COMMENT',details:request.postDataJSON(),created_at:'2026-10-04T12:00:00Z'});return route.fulfill({json:{data:{ok:true}}});
   }
   unexpectedWrites.push(path);return route.fulfill({status:403,json:{error:{message:'No writes allowed'}}});
  }
  if(/^\/api\/v1\/requests\/90000[12]$/.test(path)){
   const data=path.endsWith('1')?structuredClone(first):second;
   if(delayFirst&&path.endsWith('1')){delayFirst=false;await new Promise(resolve=>{releaseFirst=resolve})}
   return route.fulfill({json:{data}});
  }
  if(path==='/api/v1/requests')return route.fulfill({json:{data:[first,second]}});
  if(path.includes('/workflow-api/'))return route.fulfill({json:{data:{status:'ACCEPTED',next:null}}});
  if(path.includes('/pricing-api/'))return route.fulfill({json:{data:null}});
  if(path==='/api/v1/directory/orders')return route.fulfill({json:{data:[],meta:{total:0,pages:1,counts:{}}}});
  if(path==='/api/v1/directory/order-views')return route.fulfill({json:{data:[],meta:{columns:['number','customer','status'],brands:[],engineers:[],contracts:[],fields:[]}}});
  return route.fulfill({json:{data:path.includes('/dashboard')?{}:[]}});
 });
 const open=id=>page.evaluate(id=>window.dispatchEvent(new CustomEvent('profi24:open-order360',{detail:{id}})),id);
 const card=page.locator('.o360'),nav=card.getByRole('navigation',{name:'Разделы заказа'}),history=card.locator('#o360-history');
 try{
  await page.goto(BASE+'/orders',{waitUntil:'networkidle'});await open(900001);
  await card.locator('#o360-overview').waitFor();
  const estimate=card.getByRole('table',{name:'Работы и запчасти в смете'}),payments=card.getByRole('table',{name:'История платежей заказа'});
  assert.equal(await estimate.locator('tbody tr').count(),2);assert.equal(await estimate.getByText('Отменённая деталь',{exact:true}).count(),0);
  assert.match(await estimate.innerText(),/3[\s\u00a0\u202f]?000,75/);assert.equal(await payments.locator('tbody tr').count(),7);
  assert.match(await payments.innerText(),/−49,75/);assert.match(await payments.innerText(),/к оплате №11/);assert.match(await payments.innerText(),/UX-5/);
  assert.match(await card.locator('.o360MoneySummary').innerText(),/4[\s\u00a0\u202f]?050,5/);
  assert.equal(await card.locator('#o360-overview img').count(),0);assert.match(await card.locator('#o360-overview').innerText(),/SERIAL-UX/);
  for(const [label,id] of [['Работы','o360-works'],['Запчасти','o360-parts'],['Платежи','o360-payments'],['Фото и файлы','o360-files'],['Обзор','o360-overview']]){
   await nav.getByRole('button',{name:label,exact:true}).click();assert.equal(await page.evaluate(()=>document.activeElement.id),id);
  }
  await page.setViewportSize({width:390,height:844});assert.equal(await history.isVisible(),false);
  await nav.getByRole('button',{name:'История',exact:true}).click();await history.waitFor({state:'visible'});
  assert.equal(await page.evaluate(()=>document.activeElement.id),'o360-history');
  await history.getByRole('textbox',{name:'Комментарий к заказу'}).fill('Тестовый комментарий');
  await page.keyboard.press('Escape');assert.equal(await history.isVisible(),false);assert.equal(await card.isVisible(),true);
  assert.equal(await nav.getByRole('button',{name:'История',exact:true}).evaluate(e=>e===document.activeElement),true);
  await nav.getByRole('button',{name:'История',exact:true}).click();assert.equal(await history.getByRole('textbox').inputValue(),'Тестовый комментарий');
  await history.getByRole('button',{name:'Отправить',exact:true}).click();await history.getByRole('alert').filter({hasText:'Тестовая ошибка отправки'}).waitFor();
  assert.equal(await history.getByRole('textbox').inputValue(),'Тестовый комментарий');rejectComment=false;
  await history.getByRole('button',{name:'Отправить',exact:true}).click();await history.locator('.o360TlFeed').getByText('Тестовый комментарий',{exact:true}).waitFor();
  assert.equal(await history.getByRole('textbox').inputValue(),'');assert.equal(comments.length,2);
  await history.getByRole('button',{name:'Закрыть историю заказа'}).click();assert.equal(await history.isVisible(),false);
  const phoneLayout=await card.locator('main').evaluate(e=>({width:e.clientWidth,scroll:e.scrollWidth,overflow:[...e.querySelectorAll('*')].filter(x=>!x.closest('.o360OverviewTable,.o360SectionNav')&&x.getBoundingClientRect().right>e.getBoundingClientRect().right).map(x=>({tag:x.tagName,class:x.className,right:x.getBoundingClientRect().right,text:x.textContent.slice(0,120)})).slice(0,20)}));
  assert.ok(phoneLayout.scroll<=phoneLayout.width+1,'Card must fit a phone; tables scroll inside: '+JSON.stringify(phoneLayout));
  await open(900001);await card.locator('#o360-overview').waitFor(); // Reopening the active order must reload it, not leave an empty card.
  await nav.getByRole('button',{name:'История',exact:true}).click();await history.getByRole('textbox').fill('Черновик первого заказа');
  await open(900002);await card.locator('.o360Hero h2').getByText('Второй тестовый клиент',{exact:true}).waitFor();
  assert.equal(await history.isVisible(),false);await nav.getByRole('button',{name:'История',exact:true}).click();assert.equal(await history.getByRole('textbox').inputValue(),'');
  await history.getByRole('button',{name:'Закрыть историю заказа'}).click();
  delayFirst=true;await open(900001);await page.waitForFunction(()=>document.querySelector('.o360')?.dataset.currentRequestId==='900001');
  // Let the intercepted old request start, then open a different order before resolving it.
  for(let attempt=0;!releaseFirst&&attempt<250;attempt++)await page.waitForTimeout(20);
  assert.ok(releaseFirst,"The delayed request must start");
  await open(900002);await card.locator('.o360Hero h2').getByText('Второй тестовый клиент',{exact:true}).waitFor();releaseFirst();
  await page.waitForTimeout(150);assert.equal(await card.locator('.o360Hero h2').innerText(),'Второй тестовый клиент');
  await card.getByRole('button',{name:'Закрыть Заказ 360',exact:true}).click();await card.waitFor({state:'detached'});
  assert.deepEqual(unexpectedWrites,[]);assert.deepEqual(errors,[]);console.log('ORDER_CARD_OVERVIEW: ok');
 }finally{if(releaseFirst)releaseFirst();await context.close();await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
