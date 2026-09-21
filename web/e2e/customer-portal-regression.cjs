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
let TOKEN='';
async function captureToken(page){for(let attempt=0;attempt<5;attempt++){try{await page.waitForLoadState('domcontentloaded');const token=await page.evaluate(()=>localStorage.getItem('token')||'');if(token)return token}catch(error){if(!/Execution context was destroyed|Target page, context or browser has been closed/i.test(String(error)))throw error}await page.waitForTimeout(250*(attempt+1))}throw Error('authenticated token unavailable after navigation settled')}
async function api(page,url,{method='GET',body}={}){const headers={Authorization:`Bearer ${TOKEN}`},options={method,headers};if(body!==undefined){headers['Content-Type']='application/json';options.data=body}const r=await page.request.fetch(new URL(url,BASE).toString(),options),text=await r.text();let j={};try{j=JSON.parse(text)}catch{}return{status:r.status(),data:j.data,error:j.error,text}}
async function login(page){await gotoBase(page);await page.locator('input[autocomplete="username"]').fill(EMAIL);await page.locator('input[autocomplete="current-password"]').fill(PASSWORD);await page.getByRole('button',{name:'Войти',exact:true}).click();await page.waitForFunction(email=>{try{return JSON.parse(localStorage.user||'null')?.email===email}catch{return false}},EMAIL,{timeout:10000});await page.locator('aside').waitFor({state:'visible',timeout:10000});TOKEN=await captureToken(page)}
(async()=>{const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1400,height:900}});try{
 await login(page);const suffix=Date.now().toString(36).toUpperCase();
 let r=await api(page,'/api/v1/customers',{method:'POST',body:{name:`E2E Portal ${suffix}`,phone:`+7704${String(Date.now()).slice(-7)}`,address:'Костанай'}});if(r.status!==201)fail(`customer ${r.status} ${r.text}`);const customer=r.data;
 r=await api(page,'/api/v1/equipment',{method:'POST',body:{customer_id:customer.id,category:'Стиральная машина',brand:'E2E',model:'Portal',serial_number:`PORTAL-${suffix}`}});if(r.status!==201)fail(`equipment ${r.status} ${r.text}`);const equipment=r.data;
 r=await api(page,'/api/v1/requests',{method:'POST',body:{customer_id:customer.id,equipment_id:equipment.id,complaint:'Проверка кабинета клиента',source:'OTHER'}});if(r.status!==201)fail(`order ${r.status} ${r.text}`);const order=r.data;
 r=await api(page,`/api/v1/requests/${order.id}/notes`,{method:'POST',body:{text:'INTERNAL-PORTAL-SECRET'}});if(r.status!==201)fail(`note ${r.status} ${r.text}`);
 await gotoBase(page);await page.getByRole('button',{name:/Заказы/}).first().click();const row=page.getByText(order.number,{exact:true}).first();await row.waitFor({state:'visible',timeout:10000});await row.click();await page.locator('.o360').waitFor({state:'visible',timeout:10000});
 const portalButton=page.locator('[data-customer-portal-action]');await portalButton.waitFor({state:'visible',timeout:10000});await page.waitForFunction(id=>document.querySelector('[data-customer-portal-action]')?.dataset.requestId===String(id),order.id);if(Number(await portalButton.getAttribute('data-request-id'))!==Number(order.id))fail('portal action is bound to wrong order');
 let portalUrl='';page.once('dialog',async dialog=>{if(dialog.type()!=='prompt')fail('portal creation did not return prompt');portalUrl=dialog.defaultValue();await dialog.accept()});await portalButton.click();
 await page.getByRole('button',{name:'Кабинет активен',exact:true}).waitFor({state:'visible',timeout:10000});const revoke=page.getByRole('button',{name:'Отозвать',exact:true});await revoke.waitFor({state:'visible',timeout:10000});if(!portalUrl||!portalUrl.includes('/client/'))fail('customer portal URL was not returned');
 r=await api(page,`/approvals-api/api/v1/customer-portal/requests/${order.id}/link`);if(r.status!==200||!r.data?.active)fail(`portal state is not active ${r.status} ${r.text}`);const firstLinkId=Number(r.data.id);
 let replacementConfirmed=false;page.once('dialog',async dialog=>{if(dialog.type()!=='confirm')fail('replacement warning missing');replacementConfirmed=true;await dialog.dismiss()});await page.getByRole('button',{name:'Кабинет активен',exact:true}).click();if(!replacementConfirmed)fail('replacement warning was not shown');
 r=await api(page,`/approvals-api/api/v1/customer-portal/requests/${order.id}/link`);if(Number(r.data?.id)!==firstLinkId||!r.data?.active)fail('dismissed replacement changed active portal');
 await page.goto(portalUrl,{waitUntil:'domcontentloaded'});await page.getByRole('heading',{name:new RegExp(`E2E Portal ${suffix}`)}).waitFor({state:'visible',timeout:10000});await page.getByText(order.number,{exact:true}).waitFor({state:'visible',timeout:10000});await page.getByText('Проверка кабинета клиента',{exact:true}).waitFor({state:'visible'});if(await page.getByText('INTERNAL-PORTAL-SECRET',{exact:true}).isVisible().catch(()=>false))fail('internal order note leaked into customer portal');
 await gotoBase(page);await page.getByRole('button',{name:/Заказы/}).first().click();await page.getByText(order.number,{exact:true}).first().click();await page.locator('.o360').waitFor({state:'visible',timeout:10000});await page.getByRole('button',{name:'Кабинет активен',exact:true}).waitFor({state:'visible',timeout:10000});
 let revokeConfirmed=false;page.once('dialog',async dialog=>{if(dialog.type()!=='confirm')fail('revoke confirmation missing');revokeConfirmed=true;await dialog.accept()});await page.getByRole('button',{name:'Отозвать',exact:true}).click();if(!revokeConfirmed)fail('revoke confirmation was not shown');
 await page.getByRole('button',{name:'Кабинет клиента',exact:true}).waitFor({state:'visible',timeout:10000});if(await page.locator('[data-customer-portal-revoke]').isVisible().catch(()=>false))fail('revoke control stayed visible after revocation');
 r=await api(page,`/approvals-api/api/v1/customer-portal/requests/${order.id}/link`);if(r.status!==200||r.data?.active)fail('portal remained active after revocation');
 const publicToken=portalUrl.split('/').filter(Boolean).at(-1);
 r=await page.request.get(`${BASE}/approvals-api/public/customer-portal/${encodeURIComponent(publicToken)}`);if(r.status()!==410)fail(`revoked portal API stayed accessible ${r.status()}`);
 await page.goto(portalUrl,{waitUntil:'domcontentloaded'});await page.getByRole('heading',{name:'Кабинет недоступен',exact:true}).waitFor({state:'visible',timeout:10000});await page.getByText('Ссылка на кабинет отозвана',{exact:true}).waitFor({state:'visible',timeout:10000});
 console.log(`customer_portal_regression=ok order=${order.number} lifecycle=ok`);
}catch(error){try{await page.screenshot({path:path.join(artifacts,'customer-portal-failure.png'),fullPage:true})}catch{}fs.writeFileSync(path.join(artifacts,'customer-portal-error.txt'),String(error.stack||error));console.error(error);process.exitCode=1}finally{await browser.close()}})();
