const {chromium}=require('playwright');
const BASE=process.env.BASE_URL||'http://127.0.0.1:5173';
const EMAIL=process.env.E2E_EMAIL,PASSWORD=process.env.E2E_PASSWORD;
function fail(message){throw new Error(message)}
async function login(page){await page.goto(BASE,{waitUntil:'domcontentloaded'});await page.locator('input[autocomplete="username"]').fill(EMAIL);await page.locator('input[autocomplete="current-password"]').fill(PASSWORD);await page.getByRole('button',{name:'Войти'}).click();await page.waitForFunction(email=>{try{return JSON.parse(localStorage.user||'null')?.email===email}catch{return false}},EMAIL,{timeout:10000});}
async function api(page,url,{method='GET',body}={}){return page.evaluate(async({url,method,body})=>{const token=localStorage.token||'',r=await fetch(url,{method,headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)}),text=await r.text();let json={};try{json=JSON.parse(text)}catch{}return{status:r.status,data:json.data,error:json.error,text}}, {url,method,body})}
(async()=>{const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1500,height:950}});try{
 await login(page);const suffix=Date.now().toString(36).toUpperCase();
 let r=await api(page,'/api/v1/users',{method:'POST',body:{name:'Inline Engineer '+suffix,email:'inline-'+suffix+'@test.invalid',password:'InlineEngineer2026Kst9',role:'ENGINEER'}});if(r.status!==201)fail('engineer '+r.status+' '+r.text);const engineer=r.data;
 r=await api(page,'/api/v1/customers',{method:'POST',body:{name:'Inline Client '+suffix,phone:'+7 701 '+String(Date.now()).slice(-7),address:'Костанай'}});if(r.status!==201)fail('customer '+r.status);const customer=r.data;
 r=await api(page,'/api/v1/equipment',{method:'POST',body:{customer_id:customer.id,category:'Холодильник',brand:'LG',model:'INLINE-'+suffix}});if(r.status!==201)fail('equipment '+r.status);const equipment=r.data;
 r=await api(page,'/api/v1/requests',{method:'POST',body:{customer_id:customer.id,equipment_id:equipment.id,complaint:'Inline workflow acceptance '+suffix,engineer_id:engineer.id,visit_type:'FIELD'}});if(r.status!==201)fail('order '+r.status+' '+r.text);const order=r.data;
 await page.goto(BASE+'/orders',{waitUntil:'domcontentloaded'});const status=page.getByRole('combobox',{name:'Статус '+order.number});await status.waitFor({state:'visible',timeout:10000});
 if(await status.inputValue()!=='ASSIGNED')fail('expected ASSIGNED before inline transition');
 await status.selectOption('ACCEPTED');
 await page.waitForFunction(async id=>{const token=localStorage.token||'',r=await fetch('/api/v1/requests/'+id,{headers:{Authorization:'Bearer '+token}});if(!r.ok)return false;return (await r.json()).data?.status==='ACCEPTED'},order.id,{timeout:10000});
 await page.waitForFunction(number=>{const select=[...document.querySelectorAll('select')].find(x=>x.getAttribute('aria-label')==='Статус '+number);return select?.value==='ACCEPTED'},order.number,{timeout:10000});
 console.log('order_list_inline_workflow=ok order='+order.number);
}finally{await browser.close()}})().catch(error=>{console.error(error);process.exit(1)});
