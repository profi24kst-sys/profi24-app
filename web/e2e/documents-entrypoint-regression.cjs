const{chromium}=require('playwright');
const fs=require('fs'),path=require('path');
const BASE=process.env.BASE_URL||'http://127.0.0.1:5173',EMAIL=process.env.E2E_EMAIL,PASSWORD=process.env.E2E_PASSWORD;
const artifacts=path.join(__dirname,'artifacts');fs.mkdirSync(artifacts,{recursive:true});
function fail(message){throw new Error(message)}
async function gotoBase(page){
 for(let attempt=1;attempt<=3;attempt++){
  try{return await page.goto(BASE.replace(/\/$/,'')+'/orders',{waitUntil:'domcontentloaded',timeout:15000})}
  catch(error){
   if(!String(error.message||error).includes('ERR_ABORTED')||attempt===3)throw error;
   await page.waitForTimeout(300*attempt);
  }
 }
}
let TOKEN='';
async function login(page){
 await gotoBase(page);
 await page.locator('input[autocomplete="username"]').fill(EMAIL);
 await page.locator('input[autocomplete="current-password"]').fill(PASSWORD);
 await page.getByRole('button',{name:'Войти',exact:true}).click();
 await page.waitForFunction(email=>{try{return JSON.parse(localStorage.getItem('user')||'null')?.email===email}catch{return false}},EMAIL,{timeout:10000});
 await page.locator('aside').waitFor({state:'visible',timeout:10000});
 for(let attempt=0;attempt<5;attempt++){
  try{
   await page.waitForLoadState('domcontentloaded');
   TOKEN=await page.evaluate(()=>localStorage.getItem('token')||'');
   if(TOKEN)return;
  }catch(error){
   if(!/Execution context was destroyed|Target page, context or browser has been closed/i.test(String(error)))throw error;
  }
  await page.waitForTimeout(250*(attempt+1));
 }
 throw Error('authenticated token unavailable after navigation settled');
}
async function api(page,url,{method='GET',body}={}){
 const response=await page.request.fetch(new URL(url,BASE).toString(),{method,headers:{Authorization:`Bearer ${TOKEN}`,...(body===undefined?{}:{'Content-Type':'application/json'})},data:body});
 const text=await response.text();let json={};try{json=JSON.parse(text)}catch{}
 return{status:response.status(),data:json.data,error:json.error};
}
(async()=>{const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1400,height:900}});try{
 await login(page);
 const suffix=Date.now().toString(36);let r=await api(page,'/api/v1/customers',{method:'POST',body:{name:`E2E Docs ${suffix}`,phone:`+7703${String(Date.now()).slice(-7)}`,address:'Костанай'}});if(r.status!==201)fail(`customer ${r.status}`);const customer=r.data;
 r=await api(page,'/api/v1/equipment',{method:'POST',body:{customer_id:customer.id,category:'Холодильник',brand:'E2E',model:'Documents',serial_number:`DOC-${suffix}`}});if(r.status!==201)fail(`equipment ${r.status}`);const equipment=r.data;
 r=await api(page,'/api/v1/requests',{method:'POST',body:{customer_id:customer.id,equipment_id:equipment.id,complaint:'Проверка документов заказа',source:'OTHER'}});if(r.status!==201)fail(`order ${r.status}`);const order=r.data;
 await gotoBase(page);await page.getByRole('button',{name:/Заказы/}).first().click();const row=page.getByText(order.number,{exact:true}).first();await row.waitFor({state:'visible',timeout:10000});await row.click();await page.locator('.o360').waitFor({state:'visible',timeout:10000});
 const launcher=page.getByRole('button',{name:'Документы заказа',exact:true});await launcher.waitFor({state:'visible',timeout:10000});if(await page.locator('.docsHint').isVisible().catch(()=>false))fail('legacy double-click documents hint is visible');await launcher.click();
 await page.locator('[data-documents-center],.warehouseScreen').waitFor({state:'visible',timeout:10000});await page.getByRole('heading',{name:'Фото и документы заказа'}).waitFor({state:'visible'});for(const name of ['Заказ-наряд','Дефектный акт','АВР','Гарантийный талон'])await page.getByText(name,{exact:true}).waitFor({state:'visible'});if(await page.locator('.o360').isVisible().catch(()=>false))fail('Order 360 stayed above documents center');
 const first=await api(page,`/documents-api/v1/requests/${order.id}/documents`,{method:'POST',body:{document_type:'WORK_ORDER'}});if(first.status!==201||first.data?.version!==1||!first.data?.content_hash)fail(`first document version invalid ${first.status}`);const second=await api(page,`/documents-api/v1/requests/${order.id}/documents`,{method:'POST',body:{document_type:'WORK_ORDER'}});if(second.status!==201||second.data?.version!==2||Number(second.data?.supersedes_id)!==Number(first.data?.id))fail('document version chain invalid');if(String(second.data?.content_hash||'').length!==64||second.data?.snapshot?.request?.number!==order.number)fail('immutable document snapshot/hash missing');
 await page.getByRole('button',{name:'Закрыть документы'}).click();await page.getByRole('button',{name:/Заказы/}).first().click();await page.getByText(order.number,{exact:true}).first().click();await page.getByRole('button',{name:'Документы заказа',exact:true}).click();await page.getByText(second.data.document_number,{exact:true}).waitFor({state:'visible',timeout:10000});
 console.log(`documents_entrypoint_regression=ok order=${order.number} version=${second.data.version}`);
 }catch(error){try{await page.screenshot({path:path.join(artifacts,'documents-entrypoint-failure.png'),fullPage:true})}catch{}fs.writeFileSync(path.join(artifacts,'documents-entrypoint-error.txt'),String(error.stack||error));console.error(error);process.exitCode=1}finally{await browser.close()}})();
