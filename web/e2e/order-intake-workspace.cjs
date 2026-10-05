// Synthetic fixtures intercept every API. No real client records are written.
const assert=require('node:assert/strict'),{chromium}=require('playwright');
const BASE=process.env.BASE_URL||'http://127.0.0.1:5173';
(async()=>{
 const browser=await chromium.launch({headless:true}),context=await browser.newContext({serviceWorkers:'block',viewport:{width:1366,height:900}}),page=await context.newPage();
 const errors=[],writes=[],requests=[];let failSchema=true,failEquipment=true,rejectOrder=true,holdOrder=false,releaseOrder;
 const field={code:'access_note',label:'Условия выезда',required:true,field_type:'TEXT'};
 page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>{localStorage.token='synthetic-intake';localStorage.user=JSON.stringify({id:801,name:'Synthetic Manager',role:'MANAGER'})});
 await page.route(/\/(?:api\/v1|[^/]+-api\/)/,async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname;
  if(req.method()==='POST'){
   writes.push(path);const body=req.postDataJSON();
   if(path==='/api/v1/requests/intake'){
    requests.push(body);if(rejectOrder)return route.fulfill({status:422,json:{error:{message:'Тестовая ошибка заказа',safe_to_edit:true}}});
    if(holdOrder)await new Promise(resolve=>{releaseOrder=resolve});return route.fulfill({status:201,json:{data:{id:903,number:'KST-2026-900003'}}});
   }
   throw Error('Unexpected synthetic write: '+path);
  }
  if(!['GET','HEAD'].includes(req.method()))throw Error('Unexpected method: '+req.method());
  if(path==='/api/v1/order-form/schema')return route.fulfill({status:failSchema?503:200,json:failSchema?{error:{message:'Тестовая ошибка полей'}}:{data:{fields:url.searchParams.get('order_type')==='FIELD'?[field]:[]}}});
  if(path==='/api/v1/directory/customers')return route.fulfill({json:{data:[{id:71,name:'Тестовый существующий клиент',phone:'0000000000',address:'Тестовый адрес'}]}});
  if(path==='/api/v1/directory/equipment')return route.fulfill({status:failEquipment?503:200,json:failEquipment?{error:{message:'Тестовая ошибка техники'}}:{data:[{id:72,category:'Холодильник',brand:'LG',model:'EXISTING'}]}});
  if(path==='/api/v1/directory/order-views')return route.fulfill({json:{data:[],meta:{columns:['number','customer','status'],brands:[],engineers:[],fields:[],contracts:[]}}});
  if(path==='/api/v1/directory/orders')return route.fulfill({json:{data:[],meta:{total:0,pages:1,counts:{}}}});
  return route.fulfill({json:{data:path.includes('/dashboard')?{}:[]}});
 });
 const drawer=page.locator('.intakeDrawer'),save=drawer.getByRole('button',{name:'Создать заказ',exact:true});
 try{
  await page.goto(BASE+'/orders',{waitUntil:'networkidle'});await page.getByRole('button',{name:'Новый заказ',exact:true}).click();
  await drawer.getByRole('alert').filter({hasText:'Тестовая ошибка полей'}).waitFor();assert.equal(await save.isDisabled(),true);
  failSchema=false;await drawer.getByRole('button',{name:'Повторить загрузку полей',exact:true}).click();
  await save.click();await drawer.getByText('Укажите имя клиента',{exact:true}).waitFor();await page.waitForFunction(()=>document.activeElement.id==='new-customer-name');assert.deepEqual(writes,[]);
  for(const id of ['new-customer-name','new-equipment-model','new-order-complaint'])assert.equal(await drawer.locator('#'+id).isVisible(),true);
  assert.equal(await drawer.getByRole('button',{name:'Далее',exact:true}).count(),0);
  await drawer.locator('#new-customer-name').fill('Тестовый новый клиент');await drawer.locator('#new-customer-phone').fill('0000000000');await drawer.locator('#new-equipment-brand').fill('BOSCH');await drawer.locator('#new-order-complaint').fill('Тестовая неисправность');
  await drawer.locator('#new-order-type').selectOption('FIELD');await drawer.getByLabel('Условия выезда *',{exact:true}).waitFor();await save.click();await drawer.getByText('Заполните поле «Условия выезда»',{exact:true}).waitFor();assert.deepEqual(writes,[]);
  await drawer.locator('#custom-field-access_note').fill('Тестовый подъезд');await save.click();await drawer.getByRole('alert').filter({hasText:'Тестовая ошибка заказа'}).waitFor();
  assert.equal(await drawer.locator('#new-customer-name').inputValue(),'Тестовый новый клиент');assert.deepEqual(writes,['/api/v1/requests/intake']);
  rejectOrder=false;holdOrder=true;await save.evaluate(b=>{b.click();b.click()});
  await page.waitForFunction(()=>document.querySelector('.intakeDrawer')?.getAttribute('aria-busy')==='true');await page.keyboard.press('Escape');assert.equal(await drawer.isVisible(),true);
  for(let attempt=0;!releaseOrder&&attempt<250;attempt++)await page.waitForTimeout(20);assert.ok(releaseOrder);releaseOrder();await drawer.waitFor({state:'detached'});
  assert.equal(writes.filter(p=>p==='/api/v1/customers').length,0);assert.equal(writes.filter(p=>p==='/api/v1/equipment').length,0);assert.equal(requests.length,2);assert.deepEqual(requests[1].order.custom_fields,{access_note:'Тестовый подъезд'});assert.equal(requests[1].order.visit_type,'FIELD');assert.equal(requests[1].customer.name,'Тестовый новый клиент');assert.equal(requests[1].equipment.brand,'BOSCH');
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Новый заказ',exact:true}).click();
  await drawer.locator('#new-order-customer-select').selectOption('71');await drawer.getByRole('alert').filter({hasText:'Тестовая ошибка техники'}).waitFor();assert.equal(await save.isDisabled(),true);
  failEquipment=false;await drawer.getByRole('button',{name:'Повторить загрузку техники'}).click();await drawer.locator('#new-equipment-existing').selectOption('72');
  await drawer.locator('#new-order-customer-select').selectOption('');await drawer.locator('#new-equipment-model').waitFor();
  await drawer.locator('#new-order-customer-select').selectOption('71');await drawer.locator('#new-equipment-existing').waitFor();assert.equal(await drawer.locator('#new-equipment-existing').inputValue(),'');await drawer.locator('#new-equipment-existing').selectOption('72');
  await drawer.locator('#new-order-type').selectOption('PAID_WORKSHOP');await drawer.locator('#new-order-complaint').fill('Стационарная проверка');
  assert.equal(await drawer.locator('#custom-field-access_note').count(),0);assert.equal(await drawer.locator('#new-order-visit').inputValue(),'WORKSHOP');
  assert.equal(await drawer.locator('fieldset').evaluate(e=>e.scrollWidth<=e.clientWidth+1),true,'Phone form must fit the viewport');
  holdOrder=false;await save.click();await drawer.waitFor({state:'detached'});assert.equal(requests.length,3);assert.equal(requests[2].equipment_id,72);assert.equal(requests[2].customer_id,71);assert.deepEqual(requests[2].order.custom_fields,{});assert.equal(writes.filter(p=>p==='/api/v1/customers').length,0);
  assert.deepEqual(errors,[]);console.log('ORDER_INTAKE_WORKSPACE: ok');
 }finally{if(releaseOrder)releaseOrder();await context.close();await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
