
const {chromium}=require('playwright');
const fs=require('fs'),path=require('path');
const BASE=process.env.BASE_URL||'http://127.0.0.1:5173',EMAIL=process.env.E2E_EMAIL,PASSWORD=process.env.E2E_PASSWORD;
const artifacts=path.join(__dirname,'artifacts');fs.mkdirSync(artifacts,{recursive:true});
function ok(value,message){if(!value)throw Error(message)}
(async()=>{
 const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:950}});
 try{
  await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:30000});
  await page.locator('input[autocomplete="username"]').fill(EMAIL);
  await page.locator('input[autocomplete="current-password"]').fill(PASSWORD);
  await page.getByRole('button',{name:'Войти',exact:true}).click();
  await page.locator('aside').waitFor({state:'visible',timeout:15000});
  await page.locator('section.table[aria-busy="false"]').waitFor({state:'visible',timeout:20000});
  await page.waitForTimeout(900); // allow the post-login role-sync reload to settle
  const token=await page.evaluate(()=>localStorage.token);
  const api=async(method,url,body)=>{
   const response=await page.request.fetch(BASE+url,{method,headers:{authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{data:body}:{})});
   const payload=await response.json();
   ok(response.ok(),method+' '+url+': '+response.status()+' '+JSON.stringify(payload.error||{}));
   return payload.data;
  };
  const suffix=Date.now().toString(36).toLowerCase(),code='pilot_packaging_'+suffix;
  const dict=await api('POST','/api/v1/order-form/dictionaries',{code:'pilot_packaging_'+suffix,label:'Упаковка '+suffix});
  const item=await api('POST','/api/v1/order-form/dictionaries/'+dict.id+'/items',{value:'Заводская коробка'});
  await api('POST','/api/v1/order-form/fields',{code,label:'Упаковка при приёмке',field_type:'SELECT',dictionary_id:dict.id,required:true});
  await page.locator('aside').getByRole('button',{name:'Поля приёмки'}).first().click({timeout:15000});
  await page.getByRole('heading',{name:'Поля приёмки'}).waitFor({state:'visible',timeout:10000});
  await page.locator('.ofsLayer').getByText(code,{exact:true}).waitFor({state:'visible'});
  await page.locator('.ofsLayer').getByRole('button',{name:'Закрыть'}).evaluate(button=>button.click());
  await page.locator('.ofsLayer').waitFor({state:'detached',timeout:10000});
  await page.getByRole('button',{name:/Новый заказ/}).click();
  const drawer=page.locator('.drawer');await drawer.waitFor({state:'visible'});
  await drawer.locator('#new-customer-name').fill('E2E Поля '+suffix);
  await drawer.locator('#new-customer-phone').fill('+7708'+String(Date.now()).slice(-7));
  await drawer.locator('#new-equipment-brand').fill('LG');
  await drawer.locator('#new-equipment-model').fill('E2E-Fields-'+suffix);
  await drawer.locator('#new-order-complaint').fill('Проверка динамического поля '+suffix);
  const select=drawer.locator('#custom-field-'+code);
  await select.waitFor({state:'visible',timeout:12000});
  await drawer.getByRole('button',{name:'Создать заказ',exact:true}).click();
  await drawer.getByText('Заполните поле «Упаковка при приёмке»').waitFor({state:'visible',timeout:6000});
  await select.selectOption(String(item.id));
  await drawer.getByRole('button',{name:'Создать заказ',exact:true}).click();
  await drawer.waitFor({state:'detached',timeout:15000});
  const orders=await api('GET','/api/v1/requests');
  const created=orders.find(r=>String(r.complaint).includes(suffix));
  ok(created,'new order is missing');
  ok(created.custom_fields?.[code]===item.id,'dictionary choice was not persisted');
  console.log('order_form_builder_regression=ok order='+created.number);
 }catch(error){try{await page.screenshot({path:path.join(artifacts,'order-form-builder-failure.png'),fullPage:true})}catch{}fs.writeFileSync(path.join(artifacts,'order-form-builder-error.txt'),String(error.stack||error));console.error(error);process.exitCode=1}
 finally{await browser.close()}
})();
