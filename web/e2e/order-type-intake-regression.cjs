const {chromium}=require('playwright');
const fs=require('fs'),path=require('path');
const BASE=process.env.BASE_URL||'http://127.0.0.1:5173';
const artifacts=path.join(__dirname,'artifacts');fs.mkdirSync(artifacts,{recursive:true});
function ok(v,msg){if(!v)throw Error(msg)}
(async()=>{
 const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:950}});
 try{
  await page.goto(BASE,{waitUntil:'domcontentloaded'});
  await page.locator('input[autocomplete="username"]').fill(process.env.E2E_EMAIL);
  await page.locator('input[autocomplete="current-password"]').fill(process.env.E2E_PASSWORD);
  await page.getByRole('button',{name:'Войти',exact:true}).click();
  await page.locator('aside').waitFor({state:'visible',timeout:15000});
  await page.locator('section.table[aria-busy="false"]').waitFor({state:'visible',timeout:20000});
  await page.waitForTimeout(900);
  const token=await page.evaluate(()=>localStorage.token);
  const api=async(method,url,body)=>{
   const result=await page.request.fetch(BASE+url,{method,headers:{authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{data:body}:{})});
   const json=await result.json();ok(result.ok(),method+' '+url+': '+result.status()+' '+JSON.stringify(json.error||{}));return json.data;
  };
  const suffix=Date.now().toString(36),code='field_route_'+suffix;
  await page.locator('aside').getByRole('button',{name:'Поля приёмки'}).click();
  const ownerPanel=page.locator('.ofsLayer');await ownerPanel.waitFor({state:'visible'});
  const fieldSettings=ownerPanel.locator('.ofsGrid section').nth(1);
  await fieldSettings.getByLabel('Код').fill(code);
  await fieldSettings.getByLabel('Название').fill('Условия выезда');
  await fieldSettings.getByLabel('Обычный').uncheck();
  await fieldSettings.getByLabel('Выездной').check();
  await fieldSettings.getByLabel('Обязательное').check();
  await fieldSettings.getByRole('button',{name:'Добавить поле'}).click();
  await ownerPanel.getByText(code,{exact:true}).waitFor({state:'visible',timeout:10000});
  await ownerPanel.getByRole('button',{name:'Закрыть'}).evaluate(b=>b.click());
  await ownerPanel.waitFor({state:'detached',timeout:12000});
  async function startOrder(label){
   await page.getByRole('button',{name:/Новый заказ/}).click();
   const drawer=page.locator('.drawer');await drawer.waitFor({state:'visible'});
   await drawer.locator('#new-customer-name').fill('E2E '+label+' '+suffix);
   await drawer.locator('#new-customer-phone').fill('+7705'+String(Date.now()+Math.floor(Math.random()*10000)).slice(-7));
   await drawer.locator('#new-equipment-brand').fill('LG');
   await drawer.locator('#new-equipment-model').fill('TYPE-'+label+'-'+suffix);
   await drawer.locator('#new-order-complaint').fill('Проверка '+label+' '+suffix);
   return drawer;
  }
  let drawer=await startOrder('FIELD');
  await drawer.locator('#new-order-type').selectOption('FIELD');
  const field=drawer.locator('#custom-field-'+code);
  await field.waitFor({state:'visible',timeout:15000});
  await drawer.getByRole('button',{name:'Создать заказ',exact:true}).click();
  await drawer.getByText('Заполните поле «Условия выезда»').waitFor({state:'visible',timeout:7000});
  await field.fill('Вход со двора');
  await drawer.getByRole('button',{name:'Создать заказ',exact:true}).click();
  await drawer.waitFor({state:'detached',timeout:20000});
  let orders=await api('GET','/api/v1/requests');
  const fieldOrder=orders.find(o=>o.complaint==='Проверка FIELD '+suffix);
  ok(fieldOrder&&fieldOrder.order_type==='FIELD'&&fieldOrder.visit_type==='FIELD','field repair order type/visit mismatch');
  ok(fieldOrder.custom_fields?.[code]==='Вход со двора','field-only field missing');
  drawer=await startOrder('WORKSHOP');
  await drawer.locator('#new-order-type').selectOption('PAID_WORKSHOP');
  await drawer.locator('#new-order-type').waitFor({state:'visible'});
  await page.waitForFunction(()=>{const button=[...document.querySelectorAll('.drawer button')].find(b=>b.textContent.trim()==='Создать заказ');return Boolean(button&&!button.disabled)},null,{timeout:15000});
  ok(await drawer.locator('#custom-field-'+code).count()===0,'FIELD-only custom field leaked into workshop');
  await drawer.getByRole('button',{name:'Создать заказ',exact:true}).click();
  await drawer.waitFor({state:'detached',timeout:20000});
  orders=await api('GET','/api/v1/requests');
  const workshop=orders.find(o=>o.complaint==='Проверка WORKSHOP '+suffix);
  ok(workshop&&workshop.order_type==='PAID_WORKSHOP'&&workshop.visit_type==='WORKSHOP','paid workshop order type/visit mismatch');
  console.log('order_type_intake_regression=ok FIELD='+fieldOrder.number+' PAID_WORKSHOP='+workshop.number);
 }catch(e){
  try{await page.screenshot({path:path.join(artifacts,'order-type-intake-failure.png'),fullPage:true})}catch{}
  fs.writeFileSync(path.join(artifacts,'order-type-intake-error.txt'),String(e.stack||e));
  console.error(e);process.exitCode=1
 }finally{await browser.close()}
})();