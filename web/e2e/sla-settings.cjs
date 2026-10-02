// Synthetic API only: no customer records or production settings are changed.
const assert=require('node:assert/strict'),{chromium}=require('playwright');
const BASE=process.env.BASE_URL||'http://127.0.0.1:5173';
(async()=>{
 const browser=await chromium.launch({headless:true}),context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
 const errors=[],writes=[];let reject=true,finished=false;
 page.on('pageerror',e=>errors.push(e.message));
 const rows=['REPAIR','FIELD','PAID_WORKSHOP'].flatMap(order_type=>['NORMAL','CRITICAL'].map(priority=>({order_type,priority,reaction_minutes:priority==='CRITICAL'?15:60,execution_minutes:priority==='CRITICAL'?1440:4320})));
 await page.addInitScript(()=>{localStorage.user=JSON.stringify({id:801,name:'SLA Tester',role:'OWNER'});localStorage.token='synthetic-sla-token'});
 await page.route(/\/(?:api\/v1|[^/]+-api\/)/,async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  if(request.method()==='PUT'){
   assert.equal(path,'/api/v1/sla/policies/REPAIR/NORMAL');writes.push(request.postDataJSON());
   return route.fulfill({status:reject?422:200,json:reject?{data:null,error:{message:'Synthetic SLA save rejected'}}:{data:rows[1]}});
  }
  if(request.method()!=='GET'&&request.method()!=='HEAD')return route.fulfill({status:403,json:{error:{message:'Unexpected write'}}});
  const order={id:1,number:'SLA-SYNTHETIC',status:finished?'PAYMENT_REQUIRED':'ACCEPTED',customer_name:'Synthetic',complaint:'SLA browser fixture',total:0,paid:0,works:[],parts:[],history:[],sla_reaction_minutes:60,sla_reaction_deadline:'2026-10-02T10:00:00Z',sla_reacted_at:'2026-10-02T09:30:00Z',sla_execution_deadline:'2026-10-05T09:30:00Z'};
  const data=/^\/api\/v1\/requests\/1$/.test(path)?order:path==='/api/v1/sla/policies'?rows:path.includes('/dashboard')?{}:[];
  return route.fulfill({json:{data}});
 });
 try{
  await page.goto(BASE+'/orders/1',{waitUntil:'networkidle'});
  const summary=page.getByRole('region',{name:'SLA заказа'});
  await summary.getByText('Реакция: Принят',{exact:false}).waitFor();
  await summary.getByText('Выполнение: до',{exact:false}).waitFor();
  finished=true;await page.reload({waitUntil:'networkidle'});
  await summary.getByText('Выполнение: Контроль остановлен',{exact:true}).waitFor();
  await page.locator('aside').getByRole('button',{name:'Сроки SLA',exact:true}).click();
  const panel=page.getByRole('dialog',{name:'Сроки SLA'});
  await panel.getByLabel('REPAIR NORMAL reaction_minutes').fill('90');
  await panel.getByLabel('REPAIR NORMAL execution_minutes').fill('120');
  assert.equal(writes.length,0);
  const row=panel.locator('tr').filter({has:page.getByLabel('REPAIR NORMAL reaction_minutes')});
  await row.getByRole('button',{name:'Сохранить',exact:true}).click();
  await panel.getByRole('alert').filter({hasText:'Synthetic SLA save rejected'}).waitFor();
  assert.equal(await panel.getByLabel('REPAIR NORMAL reaction_minutes').inputValue(),'90');
  reject=false;await row.getByRole('button',{name:'Сохранить',exact:true}).click();
  await panel.getByRole('status').filter({hasText:'Они применяются к новым заказам'}).waitFor();
  assert.deepEqual(writes,[{reaction_minutes:90,execution_minutes:120},{reaction_minutes:90,execution_minutes:120}]);
  assert.deepEqual(errors,[]);console.log('SLA_SETTINGS: ok');
 }finally{await context.close();await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
