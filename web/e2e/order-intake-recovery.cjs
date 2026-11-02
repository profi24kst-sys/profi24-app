// Runs only on the isolated acceptance stack with newly created synthetic records.
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{chromium}=require('playwright');
const BASE=process.env.BASE_URL||'http://127.0.0.1:5173',EMAIL=process.env.E2E_EMAIL||'browser-owner@test.invalid',PASSWORD=process.env.E2E_PASSWORD;
(async()=>{
 const browser=await chromium.launch({headless:true}),context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
 const errors=[],submissions=[];let loseResponse=true,created;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/v1/requests/intake',async route=>{
  const request=route.request();submissions.push({key:request.headers()['x-idempotency-key'],body:request.postDataJSON()});
  const response=await route.fetch();
  if(loseResponse){loseResponse=false;assert.equal(response.status(),201,await response.text());created=(await response.json()).data;return route.abort('failed')}
  assert.equal(response.status(),200,await response.text());return route.fulfill({response});
 });
 const drawer=page.locator('.intakeDrawer'),open=async()=>{await page.locator('section.table[aria-busy="false"]').waitFor();await page.getByRole('button',{name:'Новый заказ',exact:true}).click();await drawer.waitFor()};
 try{
  assert.ok(PASSWORD,'E2E_PASSWORD is required');await page.goto(BASE+'/orders');await page.getByPlaceholder('Email').fill(EMAIL);await page.getByPlaceholder('Пароль').fill(PASSWORD);await page.getByRole('button',{name:'Войти',exact:true}).click();await page.locator('aside').waitFor();await open();
  const suffix=Date.now().toString(36),name='E2E Draft '+suffix,phone='+7709'+String(Date.now()).slice(-7),complaint='E2E recovery '+suffix;
  await drawer.locator('#new-customer-name').fill(name);await drawer.locator('#new-customer-phone').fill(phone);await drawer.locator('#new-equipment-model').fill('RECOVERY-'+suffix);await drawer.locator('#new-order-complaint').fill(complaint);
  await drawer.getByRole('button',{name:'Закрыть создание заказа'}).click();await drawer.waitFor({state:'detached'});await open();
  assert.equal(await drawer.locator('#new-customer-name').inputValue(),name);await drawer.getByRole('status').filter({hasText:'Восстановлен черновик'}).waitFor();assert.equal(submissions.length,0);
  await page.reload();await open();assert.equal(await drawer.locator('#new-equipment-model').inputValue(),'RECOVERY-'+suffix);assert.equal(await drawer.locator('#new-order-complaint').inputValue(),complaint);
  const other=await context.newPage();await other.goto(BASE+'/orders');await other.locator('section.table[aria-busy="false"]').waitFor();await other.getByRole('button',{name:'Новый заказ',exact:true}).click();await other.locator('#new-order-complaint').waitFor();
  await drawer.getByRole('button',{name:'Создать заказ',exact:true}).click();await drawer.getByRole('alert').waitFor();await drawer.getByRole('button',{name:'Повторить сохранение',exact:true}).waitFor();assert.ok(created?.id);assert.equal(submissions.length,1);assert.equal(await drawer.locator('#new-customer-name').isDisabled(),true);
  let otherWrites=0;other.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/v1/requests/intake')otherWrites++});
  await other.locator('#new-order-complaint').fill('Stale form must not overwrite the pending key');await other.locator('.intakeDrawer').getByRole('button',{name:'Создать заказ',exact:true}).click();await other.getByRole('alert').filter({hasText:'Не удалось сохранить ключ операции'}).waitFor();assert.equal(otherWrites,0);await other.close();
  await drawer.getByRole('button',{name:'Закрыть создание заказа'}).click();await drawer.waitFor({state:'detached'});
  await page.locator('.profile').getByRole('button',{name:'Выйти',exact:true}).click();await page.getByPlaceholder('Email').waitFor();assert.equal(await page.evaluate(()=>Boolean(localStorage.token)),false);
  await page.reload();await page.getByPlaceholder('Email').fill(EMAIL);await page.getByPlaceholder('Пароль').fill(PASSWORD);await page.getByRole('button',{name:'Войти',exact:true}).click();await page.locator('aside').waitFor();await open();assert.equal(await drawer.locator('#new-order-complaint').inputValue(),complaint);
  await drawer.getByRole('button',{name:'Повторить сохранение',exact:true}).evaluate(b=>{b.click();b.click()});await drawer.waitFor({state:'detached'});assert.equal(submissions.length,2);assert.deepEqual(submissions[0],submissions[1]);
  const token=await page.evaluate(()=>localStorage.token),headers={Authorization:'Bearer '+token};
  const get=async url=>{const r=await page.request.get(BASE+'/api/v1'+url,{headers});assert.equal(r.status(),200,await r.text());return (await r.json()).data};
  const request=await get('/requests/'+created.id);assert.equal(request.complaint,complaint);assert.equal(request.history.filter(h=>h.action==='REQUEST_CREATED').length,1);
  const customers=await get('/directory/customers?search='+encodeURIComponent(phone));assert.equal(customers.filter(c=>c.phone===phone).length,1);
  const equipment=await get('/directory/equipment?customer_id='+created.customer_id);assert.equal(equipment.filter(e=>e.model==='RECOVERY-'+suffix).length,1);
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('profi24:intake-draft:')).length),0);
  await page.unroute('**/api/v1/requests/intake');
  const data={customer_id:created.customer_id,equipment_id:created.equipment_id,order:{complaint:'Concurrent '+suffix}},key=randomUUID();
  const results=await Promise.all([1,2].map(()=>page.request.post(BASE+'/api/v1/requests/intake',{headers:{...headers,'X-Idempotency-Key':key},data})));
  assert.deepEqual(results.map(r=>r.status()).sort(),[200,201]);const bodies=await Promise.all(results.map(r=>r.json()));assert.equal(bodies[0].data.id,bodies[1].data.id);
  assert.equal((await get('/requests/'+bodies[0].data.id)).history.filter(h=>h.action==='REQUEST_CREATED').length,1);
  // Storage failure must stop submission before the first network write.
  await open();await drawer.locator('#new-customer-name').fill('E2E storage fixture');await drawer.locator('#new-customer-phone').fill('+7706'+String(Date.now()).slice(-7));await drawer.locator('#new-order-complaint').fill('E2E storage failure');
  let blockedWrites=0;page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/v1/requests/intake')blockedWrites++});
  await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('profi24:intake-draft:'))throw Error('synthetic quota');return original.call(this,k,v)}});
  await drawer.getByRole('button',{name:'Создать заказ',exact:true}).click();await drawer.getByRole('alert').filter({hasText:'Не удалось сохранить ключ операции'}).waitFor();assert.equal(blockedWrites,0);
  assert.deepEqual(errors,[]);console.log('ORDER_INTAKE_RECOVERY: ok draft_reopen=ok lost_response=ok concurrent_retry=ok stale_form_guard=ok storage_guard=ok');
 }finally{await context.close();await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
