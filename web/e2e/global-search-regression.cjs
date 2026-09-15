const{chromium}=require('playwright');
const fs=require('fs'),path=require('path');
const BASE=process.env.BASE_URL||'http://127.0.0.1:5173',EMAIL=process.env.E2E_EMAIL||'browser-owner@test.invalid',PASSWORD=process.env.E2E_PASSWORD||'BrowserOwner2026Kst9',artifacts=path.join(__dirname,'artifacts');fs.mkdirSync(artifacts,{recursive:true});
function fail(message){throw new Error(message)}
async function api(page,url,opt={}){return page.evaluate(async({url,method='GET',body})=>{const r=await fetch(url,{method,headers:{Authorization:`Bearer ${localStorage.token||''}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)}),text=await r.text();let j={};try{j=JSON.parse(text)}catch{}return{status:r.status,data:j.data,text}}, {url,...opt})}
(async()=>{
 const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1500,height:950}});
 try{
  await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:30000});await page.getByPlaceholder('Email').fill(EMAIL);await page.getByPlaceholder('Пароль').fill(PASSWORD);await page.getByRole('button',{name:'Войти',exact:true}).click();await page.locator('aside').waitFor({state:'visible',timeout:10000});
  const suffix=Date.now().toString(36).toUpperCase(),phone='+7707'+String(Date.now()).slice(-7),serial='SEARCH-'+suffix;
  let r=await api(page,'/api/v1/customers',{method:'POST',body:{name:'E2E Поиск '+suffix,phone}});if(r.status!==201)fail('customer '+r.status+' '+r.text);const customer=r.data;
  r=await api(page,'/api/v1/equipment',{method:'POST',body:{customer_id:customer.id,category:'Холодильник',brand:'SearchBrand',model:suffix,serial_number:serial}});if(r.status!==201)fail('equipment '+r.status+' '+r.text);const equipment=r.data;
  r=await api(page,'/api/v1/requests',{method:'POST',body:{customer_id:customer.id,equipment_id:equipment.id,complaint:'Проверка глобального поиска',source:'OTHER'}});if(r.status!==201)fail('request '+r.status+' '+r.text);const order=r.data;
  await Promise.all([page.waitForResponse(resp=>resp.url().includes('/api/v1/customers')&&resp.ok()),page.getByRole('button',{name:'Обновить данные'}).click()]);
  const search=page.getByRole('combobox',{name:'Глобальный поиск'});
  await search.fill(serial);let option=page.getByRole('option').filter({hasText:'Техника'}).filter({hasText:serial});await option.waitFor({state:'visible',timeout:6000});await option.click();
  await page.getByRole('heading',{name:'Техника'}).waitFor({state:'visible'});const equipmentRow=page.locator(`[data-search-record="equipment-${equipment.id}"]`);await equipmentRow.waitFor({state:'visible'});if(!(await equipmentRow.evaluate(x=>x.classList.contains('searchHit'))))fail('equipment result was not highlighted');
  await search.fill(phone);option=page.getByRole('option').filter({hasText:'Клиент'}).filter({hasText:phone});await option.waitFor({state:'visible'});await option.click();
  await page.getByRole('heading',{name:'Клиенты'}).waitFor({state:'visible'});await page.locator(`[data-search-record="customers-${customer.id}"]`).waitFor({state:'visible'});
  await search.fill(order.number);option=page.getByRole('option').filter({hasText:'Заказ'}).filter({hasText:order.number});await option.waitFor({state:'visible'});await option.click();
  await page.waitForFunction(id=>location.pathname===`/orders/${id}`,String(order.id));await page.getByText(order.number,{exact:true}).first().waitFor({state:'visible',timeout:8000});
  console.log('global_search_regression=ok order='+order.number);
 }catch(error){try{await page.screenshot({path:path.join(artifacts,'global-search-failure.png'),fullPage:true})}catch{}fs.writeFileSync(path.join(artifacts,'global-search-error.txt'),String(error.stack||error));console.error(error);process.exitCode=1}
 finally{await browser.close()}
})();
