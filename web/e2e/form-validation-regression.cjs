const{chromium}=require('playwright');
const fs=require('fs'),path=require('path');
const BASE=process.env.BASE_URL||'http://127.0.0.1:5173',EMAIL=process.env.E2E_EMAIL||'browser-owner@test.invalid',PASSWORD=process.env.E2E_PASSWORD||'BrowserOwner2026Kst9',artifacts=path.join(__dirname,'artifacts');fs.mkdirSync(artifacts,{recursive:true});
function fail(message){throw new Error(message)}
(async()=>{
 const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1400,height:900}});let requestPosts=0;
 page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/v1/requests')requestPosts++});
 try{
  await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:30000});
  await page.getByRole('button',{name:'Войти',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Введите email'}).waitFor({state:'visible',timeout:5000});
  await page.getByPlaceholder('Email').fill('wrong-email');
  await page.getByPlaceholder('Пароль').fill('test');
  await page.getByRole('button',{name:'Войти',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Проверьте формат email'}).waitFor({state:'visible',timeout:5000});
  await page.getByPlaceholder('Email').fill(EMAIL);await page.getByPlaceholder('Пароль').fill(PASSWORD);
  await page.getByRole('button',{name:'Войти',exact:true}).click();
  await page.locator('aside').waitFor({state:'visible',timeout:10000});
  await page.getByRole('button',{name:/Новый заказ/}).click();
  const drawer=page.locator('.drawer');await drawer.waitFor({state:'visible',timeout:6000});
  await drawer.getByRole('button',{name:'Далее',exact:true}).click();
  await drawer.getByText('Укажите имя клиента',{exact:true}).waitFor({state:'visible'});
  await drawer.getByText('Введите корректный номер телефона',{exact:true}).waitFor({state:'visible'});
  const suffix=Date.now().toString(36).toUpperCase();
  await drawer.locator('#new-customer-name').fill('E2E Валидация '+suffix);
  await drawer.locator('#new-customer-phone').fill('123');
  await drawer.getByRole('button',{name:'Далее',exact:true}).click();
  await drawer.getByText('Введите корректный номер телефона',{exact:true}).waitFor({state:'visible'});
  await drawer.locator('#new-customer-phone').fill('+7708'+String(Date.now()).slice(-7));
  await drawer.getByRole('button',{name:'Далее',exact:true}).dispatchEvent('click');
  await drawer.getByLabel('Бренд').fill('E2E');await drawer.getByLabel('Модель').fill('VALIDATION-'+suffix);
  await drawer.getByRole('button',{name:'Далее',exact:true}).dispatchEvent('click');
  await drawer.getByRole('button',{name:'Создать заказ',exact:true}).click();
  await drawer.getByText('Опишите неисправность минимум тремя символами',{exact:true}).waitFor({state:'visible'});
  await drawer.locator('#new-order-complaint').fill('Проверка защиты формы от двойной отправки');
  await drawer.getByRole('button',{name:'Создать заказ',exact:true}).evaluate(button=>{button.click();button.click()});
  await drawer.waitFor({state:'detached',timeout:15000});
  if(requestPosts!==1)fail('expected exactly one request POST, got '+requestPosts);
  console.log('form_validation_regression=ok request_posts=1');
 }catch(error){try{await page.screenshot({path:path.join(artifacts,'form-validation-failure.png'),fullPage:true})}catch{}fs.writeFileSync(path.join(artifacts,'form-validation-error.txt'),String(error.stack||error));console.error(error);process.exitCode=1}
 finally{await browser.close()}
})();
