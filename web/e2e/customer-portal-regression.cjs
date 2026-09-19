const{chromium}=require('playwright');
const fs=require('fs'),path=require('path');
const BASE=process.env.BASE_URL||'http://127.0.0.1:5173',EMAIL=process.env.E2E_EMAIL,PASSWORD=process.env.E2E_PASSWORD,artifacts=path.join(__dirname,'artifacts');fs.mkdirSync(artifacts,{recursive:true});
function fail(message){throw new Error(message)}
async function gotoBase(page){
 for(let attempt=1;attempt<=3;attempt++){
  try{return await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:15000})}
  catch(error){
   if(!String(error.message||error).includes('ERR_ABORTED')||attempt===3)throw error;
   await page.waitForTimeout(300*attempt);
  }
 }
}
async function login(page){await gotoBase(page);await page.locator('input[autocomplete="username"]').fill(EMAIL);await page.locator('input[autocomplete="current-password"]').fill(PASSWORD);await page.getByRole('button',{name:'Войти',exact:true}).click();await page.waitForFunction(email=>{try{return JSON.parse(localStorage.user||'null')?.email===email}catch{return false}},EMAIL,{timeout:10000});await page.locator('aside').waitFor({state:'visible',timeout:10000})}
async function api(page,url,opt={}){for(let attempt=0;attempt<2;attempt++)try{return await page.evaluate(async({url,method='GET',body})=>{const r=await fetch(url,{method,headers:{Authorization:`Bearer ${localStorage.token||''}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)}),text=await r.text();let j={};try{j=JSON.parse(text)}catch{}return{status:r.status,data:j.data,error:j.error,text}}, {url,...opt})}catch(e){if(attempt||!/Execution context was destroyed/i.test(String(e)))throw e;await page.waitForLoadState('domcontentloaded')}throw Error('api retry exhausted')}
(async()=>{const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1400,height:900}});try{
 await login(page);const suffix=Date.now().toString(36).toUpperCase();
 let r=await api(page,'/api/v1/customers',{method:'POST',body:{name:`E2E Portal ${suffix}`,phone:`+7704${String(Date.now()).slice(-7)}`,address:'Костанай'}});if(r.status!==201)fail(`customer ${r.status} ${r.text}`);const customer=r.data;
 r=await api(page,'/api/v1/equipment',{method:'POST',body:{customer_id:customer.id,category:'Стиральная машина',brand:'E2E',model:'Portal',serial_number:`PORTAL-${suffix}`}});if(r.status!==201)fail(`equipment ${r.status} ${r.text}`);const equipment=r.data;
 r=await api(page,'/api/v1/requests',{method:'POST',body:{customer_id:customer.id,equipment_id:equipment.id,complaint:'Проверка кабинета клиента',source:'OTHER'}});if(r.status!==201)fail(`order ${r.status} ${r.text}`);const order=r.data;
 r=await api(page,`/api/v1/requests/${order.id}/notes`,{method:'POST',body:{text:'INTERNAL-PORTAL-SECRET'}});if(r.status!==201)fail(`note ${r.status} ${r.text}`);
 await gotoBase(page);await page.getByRole('button',{name:/Заказы/}).first().click();const row=page.getByText(order.number,{exact:true}).first();await row.waitFor({state:'visible',timeout:10000});await row.click();await page.locator('.o360').waitFor({state:'visible',timeout:10000});
 const portalButton=page.getByRole('button',{name:'Кабинет клиента',exact:true});await portalButton.waitFor({state:'visible',timeout:10000});if(Number(await portalButton.getAttribute('data-request-id'))!==Number(order.id))fail('portal action is bound to wrong order');let portalUrl='';page.once('dialog',async dialog=>{portalUrl=dialog.defaultValue();await dialog.accept()});await portalButton.click();await page.waitForFunction(()=>!document.querySelector('[data-customer-portal-action]')?.disabled,{timeout:10000});if(!portalUrl||!portalUrl.includes('/client/'))fail('customer portal URL was not returned');
 await page.goto(portalUrl,{waitUntil:'domcontentloaded'});await page.getByRole('heading',{name:new RegExp(`E2E Portal ${suffix}`)}).waitFor({state:'visible',timeout:10000});await page.getByText(order.number,{exact:true}).waitFor({state:'visible',timeout:10000});await page.getByText('Проверка кабинета клиента',{exact:true}).waitFor({state:'visible'});if(await page.getByText('INTERNAL-PORTAL-SECRET',{exact:true}).isVisible().catch(()=>false))fail('internal order note leaked into customer portal');
 console.log(`customer_portal_regression=ok order=${order.number}`);
}catch(error){try{await page.screenshot({path:path.join(artifacts,'customer-portal-failure.png'),fullPage:true})}catch{}fs.writeFileSync(path.join(artifacts,'customer-portal-error.txt'),String(error.stack||error));console.error(error);process.exitCode=1}finally{await browser.close()}})();
