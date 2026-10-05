// Pilot handoff across real browser sessions: MANAGER accepts and assigns a new order,
// ENGINEER sees only the assigned job, accepts it and leaves a service note.
// The detailed financial/close workflow is covered by staff-day-acceptance.test.js.
const {chromium}=require('playwright');
const fs=require('fs'),path=require('path');
const BASE=process.env.BASE_URL||'http://127.0.0.1:5173';
const EMAIL=process.env.E2E_EMAIL||'browser-owner@test.invalid';
const PASSWORD=process.env.E2E_PASSWORD||'BrowserOwner2026Kst9';
const artifacts=path.join(__dirname,'artifacts');
fs.mkdirSync(artifacts,{recursive:true});

function fail(message){throw Error(message)}
async function login(page,email,password){
  await page.goto(BASE+'/orders',{waitUntil:'domcontentloaded'});
  await page.locator('input[autocomplete="username"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.getByRole('button',{name:'Войти',exact:true}).click();
  await page.waitForFunction(expected=>{try{return JSON.parse(localStorage.user||'null')?.email===expected}catch{return false}},email,{timeout:12000});
  await page.locator('aside').waitFor({state:'visible',timeout:12000});
  await page.locator('section.table[aria-busy="false"]').waitFor({state:'visible',timeout:25000});
}
async function api(page,url,{method='GET',body}={}){
  const token=await page.evaluate(()=>localStorage.getItem('token'));
  const options={method,headers:{Authorization:'Bearer '+token}};
  if(body!==undefined){options.headers['Content-Type']='application/json';options.data=body}
  const r=await page.request.fetch(new URL(url,BASE).toString(),options);
  const text=await r.text();let json={};try{json=JSON.parse(text)}catch{}
  return{status:r.status(),data:json.data,error:json.error,text};
}
function expectStatus(result,status,step){
  if(result.status!==status)fail(step+': expected '+status+', got '+result.status+' '+result.text);
  return result.data;
}
(async()=>{
 const browser=await chromium.launch({headless:true});
 const contexts=[],errors=[],suffix=Date.now().toString(36).toUpperCase();
 let active;
 try{
  const ownerCtx=await browser.newContext(),owner=await ownerCtx.newPage();contexts.push(ownerCtx);active=owner;
  await login(owner,EMAIL,PASSWORD);
  const branch=expectStatus(await api(owner,'/branch-api/v1/branches'),200,'branch lookup').find(x=>x.code==='KST');
  if(!branch)fail('KST branch is missing');
  const managerEmail='pilot-manager-'+suffix.toLowerCase()+'@test.invalid';
  const engineerEmail='pilot-engineer-'+suffix.toLowerCase()+'@test.invalid';
  const password='PilotHandoff2026Kst9';
  const manager=expectStatus(await api(owner,'/api/v1/users',{method:'POST',body:{
    name:'Pilot Manager '+suffix,email:managerEmail,password,role:'MANAGER'
  }}),201,'create manager');
  const engineer=expectStatus(await api(owner,'/api/v1/users',{method:'POST',body:{
    name:'Pilot Engineer '+suffix,email:engineerEmail,password,role:'ENGINEER'
  }}),201,'create engineer');
  for(const user of [manager,engineer]){
    expectStatus(await api(owner,'/branch-api/v1/users/'+user.id+'/branches',{method:'PUT',body:{
      branch_ids:[branch.id],primary_branch_id:branch.id
    }}),200,'assign branch to '+user.role);
  }
  const managerCtx=await browser.newContext(),managerPage=await managerCtx.newPage();contexts.push(managerCtx);active=managerPage;
  managerPage.on('pageerror',e=>errors.push('MANAGER '+e.message));
  await login(managerPage,managerEmail,password);
  if(!await managerPage.getByRole('button',{name:/Новый заказ/}).isVisible())fail('MANAGER cannot open new order');
  await managerPage.getByRole('button',{name:/Новый заказ/}).click();
  const drawer=managerPage.locator('.drawer');
  await drawer.waitFor({state:'visible',timeout:10000});
  const phone='+7706'+String(Date.now()).slice(-7);
  await drawer.locator('#new-customer-name').fill('Pilot Client '+suffix);
  await drawer.locator('#new-customer-phone').fill(phone);
  await drawer.locator('#new-customer-address').fill('Костанай, пилотный заказ');
  await drawer.getByRole('button',{name:'Далее',exact:true}).click();
  await drawer.locator('#new-equipment-brand').fill('LG');
  await drawer.locator('#new-equipment-model').fill('PILOT-'+suffix);
  await drawer.locator('#new-equipment-serial').fill('PILOT-SN-'+suffix);
  await drawer.getByRole('button',{name:'Далее',exact:true}).click();
  await drawer.locator('#new-order-complaint').fill('Пилот: стиральная машина не сливает воду');
  const engineerSelect=drawer.locator('select').filter({hasText:'Pilot Engineer '+suffix});
  if(await engineerSelect.count()!==1)fail('MANAGER cannot choose branch engineer');
  await engineerSelect.selectOption(String(engineer.id));
  const createdResponse=managerPage.waitForResponse(r=>r.url().endsWith('/api/v1/requests')&&r.request().method()==='POST',{timeout:15000});
  await drawer.getByRole('button',{name:'Создать заказ'}).click();
  const create=await createdResponse;
  const created=await create.json();if(create.status()!==201)fail('UI order creation failed: '+JSON.stringify(created));
  const order=created.data;if(!order?.id||!order?.number)fail('New order has no ID or number');
  await drawer.waitFor({state:'detached',timeout:25000});
  await managerPage.getByText(order.number,{exact:true}).first().waitFor({state:'visible',timeout:15000});
  await managerPage.getByText(order.number,{exact:true}).first().click();
  await managerPage.waitForFunction(id=>location.pathname==='/orders/'+id,String(order.id),{timeout:12000});
  const engineerCtx=await browser.newContext(),engineerPage=await engineerCtx.newPage();contexts.push(engineerCtx);active=engineerPage;
  engineerPage.on('pageerror',e=>errors.push('ENGINEER '+e.message));
  await login(engineerPage,engineerEmail,password);
  await engineerPage.getByText(order.number,{exact:true}).first().waitFor({state:'visible',timeout:20000});
  await engineerPage.getByText(order.number,{exact:true}).first().click();
  await engineerPage.waitForFunction(id=>location.pathname==='/orders/'+id,String(order.id),{timeout:12000});
  const forbidden=await api(engineerPage,'/api/v1/requests/'+order.id+'/payment',{method:'POST',body:{amount:1,account_id:1}});
  if(forbidden.status!==403)fail('ENGINEER payment must be forbidden, got '+forbidden.status);
  const accept=await api(engineerPage,'/workflow-api/v1/requests/'+order.id+'/workflow',{method:'POST',body:{event:'ACCEPT'}});
  expectStatus(accept,200,'engineer accepts assigned order');
  const note=await api(engineerPage,'/api/v1/requests/'+order.id+'/notes',{method:'POST',body:{
    text:'Пилот: инженер принял заявку и согласовал время выезда'
  }});
  expectStatus(note,201,'engineer creates handoff note');
  const refreshed=expectStatus(await api(managerPage,'/api/v1/requests/'+order.id),200,'manager reopens assigned order');
  if(refreshed.status!=='ACCEPTED')fail('Manager cannot observe engineer ACCEPT status: '+refreshed.status);
  if(!refreshed.notes?.some(n=>n.text?.includes('Пилот: инженер принял')))fail('Manager cannot read engineer handoff note');
  await managerPage.reload({waitUntil:'domcontentloaded'});
  await managerPage.locator('aside').waitFor({state:'visible',timeout:12000});
  await managerPage.getByText(order.number,{exact:true}).first().waitFor({state:'visible',timeout:15000});
  if(errors.length)fail('browser errors: '+errors.join(' / '));
  console.log('pilot_manager_engineer_handoff=ok order='+order.number+' manager='+manager.id+' engineer='+engineer.id);
 }catch(error){
  try{await active?.screenshot({path:path.join(artifacts,'pilot-handoff-failure.png'),fullPage:true})}catch{}
  fs.writeFileSync(path.join(artifacts,'pilot-handoff-error.txt'),String(error.stack||error));
  console.error(error);process.exitCode=1;
 }finally{for(const ctx of contexts.reverse())await ctx.close().catch(()=>{});await browser.close()}
})();
