const {chromium}=require('playwright');
const fs=require('fs'),path=require('path');
const BASE=(process.env.BASE_URL||'http://127.0.0.1:5173').replace(/\/$/,'');
const EMAIL=process.env.E2E_EMAIL||'browser-owner@test.invalid';
const PASSWORD=process.env.E2E_PASSWORD||'BrowserOwner2026Kst9';
const STAFF_PASSWORD='PilotBrowser2026Kst9';
const artifacts=path.join(__dirname,'artifacts');fs.mkdirSync(artifacts,{recursive:true});
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zg3sAAAAASUVORK5CYII=';
function ok(value,message){if(!value)throw Error(message)}
async function login(browser,email,password){
  const context=await browser.newContext({viewport:{width:1500,height:950}});
  const page=await context.newPage();
  await page.goto(BASE+'/orders',{waitUntil:'domcontentloaded',timeout:30000});
  await page.locator('input[autocomplete="username"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.getByRole('button',{name:'Войти',exact:true}).click();
  await page.waitForFunction(expected=>{try{return JSON.parse(localStorage.user||'null')?.email===expected&&Boolean(localStorage.token)}catch{return false}},email,{timeout:15000});
  await page.locator('aside').waitFor({state:'visible',timeout:15000});
  page.pilotToken=await page.evaluate(()=>localStorage.token);
  return{page,context};
}
async function api(page,url,{method='GET',body,key,expect}={}){
  const headers={Authorization:'Bearer '+page.pilotToken};
  if(body!==undefined)headers['Content-Type']='application/json';
  if(key)headers['Idempotency-Key']=key;
  const response=await page.request.fetch(BASE+url,{method,headers,...(body===undefined?{}:{data:body})});
  const text=await response.text();let json={};try{json=JSON.parse(text)}catch{}
  const result={status:response.status(),data:json.data,error:json.error,text};
  if(expect!==undefined)ok([].concat(expect).includes(result.status),method+' '+url+': '+result.status+' '+text.slice(0,300));
  return result;
}
async function openOrder(page,number){
  await page.goto(BASE+'/orders',{waitUntil:'domcontentloaded',timeout:30000});
  await page.locator('aside').waitFor({state:'visible',timeout:15000});
  await page.getByText(number,{exact:true}).first().click({timeout:20000});
  await page.locator('.o360, .engScreen, .orderdetail').first().waitFor({state:'visible',timeout:10000});
}
(async()=>{
 const browser=await chromium.launch({headless:true}),sessions=[];
 let lastPage;
 try{
  const suffix=Date.now().toString(36).toUpperCase();
  const owner=await login(browser,EMAIL,PASSWORD);sessions.push(owner);lastPage=owner.page;
  const branchResponse=await api(owner.page,'/branch-api/v1/branches',{expect:200});
  const branch=branchResponse.data.find(x=>x.code==='KST');ok(branch,'KST branch missing');
  const users={};
  for(const role of ['SUPERVISOR','MANAGER','ENGINEER','ACCOUNTANT']){
    const email='pilot-'+role.toLowerCase()+'-'+suffix+'@test.invalid';
    const created=await api(owner.page,'/api/v1/users',{method:'POST',body:{name:'Pilot '+role+' '+suffix,email,role,password:STAFF_PASSWORD},expect:201});
    users[role]={...created.data,email};
    await api(owner.page,'/branch-api/v1/users/'+created.data.id+'/branches',{method:'PUT',body:{branch_ids:[branch.id],primary_branch_id:branch.id},expect:200});
  }
  const cash=(await api(owner.page,'/finance-api/v1/accounts',{method:'POST',body:{name:'Pilot cash '+suffix,type:'CASH',branch_id:branch.id,initial_amount:'0'},expect:201})).data;
  const mgr=await login(browser,users.MANAGER.email,STAFF_PASSWORD);sessions.push(mgr);lastPage=mgr.page;
  await mgr.page.locator('section.table[aria-busy="false"]').waitFor({state:'visible',timeout:20000});
  await mgr.page.getByRole('button',{name:/Новый заказ/}).click();
  const drawer=mgr.page.locator('.drawer');await drawer.waitFor({state:'visible'});
  const clientName='Pilot Client '+suffix;
  await drawer.locator('#new-customer-name').fill(clientName);
  await drawer.locator('#new-customer-phone').fill('+7705'+String(Date.now()).slice(-7));
  await drawer.locator('#new-customer-address').fill('Костанай, пилотный выезд');
  await drawer.getByRole('button',{name:'Далее',exact:true}).click();
  await drawer.locator('#new-equipment-brand').fill('LG');
  await drawer.locator('#new-equipment-model').fill('PILOT-'+suffix);
  await drawer.getByRole('button',{name:'Далее',exact:true}).click();
  await drawer.locator('#new-order-complaint').fill('Не сливает воду PILOT-'+suffix);
  await drawer.locator('.grid2 select').nth(2).selectOption(String(users.ENGINEER.id));
  await drawer.getByRole('button',{name:'Создать заказ',exact:true}).click();
  await drawer.waitFor({state:'detached',timeout:20000});
  const orders=(await api(mgr.page,'/api/v1/requests',{expect:200})).data;
  const order=orders.find(x=>String(x.complaint).includes('PILOT-'+suffix));
  ok(order,'manager-created order missing');ok(Number(order.engineer_id)===Number(users.ENGINEER.id),'engineer was not assigned');
  await openOrder(mgr.page,order.number);

  const stock=(await api(owner.page,'/warehouse-api/v1/items',{method:'POST',body:{name:'Pilot drain consumable '+suffix,sku:'PILOT-'+suffix,branch_id:branch.id,purchase_price:500,sale_price:0,min_quantity:0},expect:201})).data;
  await api(owner.page,'/warehouse-api/v1/items/'+stock.id+'/receive',{method:'POST',body:{quantity:2,purchase_price:500,comment:'Pilot goods receipt'},expect:200});
  const sup=await login(browser,users.SUPERVISOR.email,STAFF_PASSWORD);sessions.push(sup);
  await api(sup.page,'/procurement-api/v1/reservations',{method:'POST',body:{item_id:stock.id,request_id:order.id,quantity:1},expect:201});
  const stage=(await api(sup.page,'/workflow-api/v1/requests/'+order.id+'/workflow',{expect:200})).data;
  if(stage.status==='NEW')await api(sup.page,'/workflow-api/v1/requests/'+order.id+'/workflow',{method:'POST',body:{event:'ASSIGN'},expect:200});
  const eng=await login(browser,users.ENGINEER.email,STAFF_PASSWORD);sessions.push(eng);lastPage=eng.page;
  const mine=(await api(eng.page,'/api/v1/requests',{expect:200})).data;
  ok(mine.some(x=>Number(x.id)===Number(order.id)),'engineer cannot see assigned order');
  await openOrder(eng.page,order.number);
  for(const event of ['ACCEPT','DEPART','ARRIVE'])await api(eng.page,'/workflow-api/v1/requests/'+order.id+'/workflow',{method:'POST',body:{event},expect:200});
