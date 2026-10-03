// All API replies and writes are intercepted; this scenario cannot change CRM data.
const assert=require('node:assert/strict'),{chromium}=require('playwright');
const BASE=process.env.BASE_URL||'http://127.0.0.1:5173';
(async()=>{
 const browser=await chromium.launch({headless:true}),context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
 let failDiagnosis=true,failWork=true,writes=0,denyOrder=false;
 const diagnostic={symptoms:'server symptoms',diagnosis:'',recommendation:''},completion={repair_result:'',test_result:'',parts_posted:false};
 const order=id=>({id,number:'DRAFT-'+id,status:'REPAIR',customer_name:'Synthetic',complaint:'Draft test',diagnosis:'',total:0,paid:0,direct_cost:0,works:[],parts:[],history:[]});
 await page.addInitScript(()=>{if(!localStorage.user)localStorage.user=JSON.stringify({id:701,name:'Draft Tester',role:'OWNER'});localStorage.token='synthetic-draft-test-token'});
 const reply=(route,data,status=200)=>route.fulfill({status,json:status<400?{data}:{data:null,error:{code:'VALIDATION',message:data}}});
 await page.route(/\/(?:api\/v1|[^/]+-api\/)/,async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method(),id=Number(path.match(/requests\/(\d+)/)?.[1]||1);
  if(method!=='GET'&&method!=='HEAD'){
   writes++;const body=request.postDataJSON()||{};
   if(path.includes('/diagnostic-api/')&&path.endsWith('/diagnosis')){if(failDiagnosis)return reply(route,'Synthetic save rejected',422);Object.assign(diagnostic,body);return reply(route,diagnostic)}
   if(path.endsWith('/repair-done')){Object.assign(completion,body,{parts_posted:true});return reply(route,completion)}
   if(path.endsWith('/test')){Object.assign(completion,body);return reply(route,completion)}
   if(path.endsWith('/works'))return failWork?reply(route,'Synthetic work rejected',422):reply(route,{id:99,...body});
   return reply(route,{});
  }
  if(path.includes('/diagnostic-api/')){
   if(path.endsWith('/fault-taxonomy'))return reply(route,{faults:[],causes:[],actions:[]});
   if(path.endsWith('/fault-patterns'))return reply(route,{patterns:[]});
   if(denyOrder)return reply(route,'Нет доступа к заказу',403);
   return reply(route,{request:order(id),diagnostic:id===1?diagnostic:{symptoms:'other order',diagnosis:'',recommendation:''},lines:[],reservations:[]});
  }
  if(path.includes('/knowledge-api/'))return reply(route,{articles:[]});
  if(path.includes('/completion-api/'))return reply(route,{request:order(id),completion,files:[],signatures:[]});
  if(/^\/api\/v1\/requests\/\d+$/.test(path))return reply(route,order(id));
  if(path==='/api/v1/requests')return reply(route,[order(1),order(2)]);
  if(path.includes('/dashboard'))return reply(route,path.endsWith('/finance')?{totals:{}}:{});
  return reply(route,[]);
 });
 const openDiag=async id=>{await page.evaluate(id=>{window.Profi24O360State={id};window.dispatchEvent(new CustomEvent('profi24:open-diagnostics'))},id);await page.locator('.df').getByLabel('Симптомы').waitFor()};
 const reload=()=>page.reload({waitUntil:'networkidle'});
 try{
  await page.goto(BASE,{waitUntil:'networkidle'});await openDiag(1);
  await page.locator('.df').getByLabel('Симптомы').fill('Unsaved symptoms');await page.locator('.df').getByLabel('Диагноз',{exact:true}).fill('Unsaved diagnosis');
  assert.equal(writes,0,'Typing must never send a request');
  await page.locator('.df').getByRole('button',{name:'Сохранить диагностику',exact:true}).click();await page.locator('.dfMsg').filter({hasText:'Synthetic save rejected'}).waitFor();
  await reload();await openDiag(2);assert.equal(await page.locator('.df').getByRole('button',{name:'Восстановить черновик'}).count(),0);
  await openDiag(1);await page.locator('.df').getByRole('button',{name:'Восстановить черновик'}).click();assert.equal(await page.locator('.df').getByLabel('Симптомы').inputValue(),'Unsaved symptoms');
  // Successful POST clears only the confirmed draft.
  failDiagnosis=false;await page.locator('.df').getByRole('button',{name:'Сохранить диагностику',exact:true}).click();await page.locator('.dfMsg').filter({hasText:'Диагностика сохранена'}).waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('profi24:order-draft:v1:701:1:diagnostic')),null);
  // Conflicting server text is shown first; draft restoration remains explicit.
  await page.locator('.df').getByLabel('Симптомы').fill('Local conflict');diagnostic.symptoms='Changed by colleague';await reload();await openDiag(1);
  await page.locator('.df .orderDraftNotice').filter({hasText:'Данные заказа изменились'}).waitFor();assert.equal(await page.locator('.df').getByLabel('Симптомы').inputValue(),'Changed by colleague');
  await page.locator('.df').getByRole('button',{name:'Восстановить черновик'}).click();assert.equal(await page.locator('.df').getByLabel('Симптомы').inputValue(),'Local conflict');
  // A failed authorized read must not expose a locally cached form.
  denyOrder=true;await reload();await page.evaluate(()=>{window.Profi24O360State={id:1};window.dispatchEvent(new CustomEvent('profi24:open-diagnostics'))});
  await page.locator('.dfMsg').filter({hasText:'Нет доступа'}).waitFor();assert.equal(await page.locator('.df textarea').count(),0);denyOrder=false;
  await reload();await page.evaluate(()=>window.dispatchEvent(new CustomEvent('profi24:open-completion',{detail:{id:1}})));
  const panel=page.locator('.co');await panel.getByPlaceholder('Что выполнено').fill('Unsaved repair');await panel.getByPlaceholder('Результат проверки').fill('Unsaved verification');
  await reload();await page.evaluate(()=>window.dispatchEvent(new CustomEvent('profi24:open-completion',{detail:{id:1}})));
  await panel.getByRole('button',{name:'Восстановить черновик'}).click();assert.equal(await panel.getByPlaceholder('Результат проверки').inputValue(),'Unsaved verification');
  await panel.getByRole('button',{name:'Зафиксировать ремонт и списать резерв'}).click();await panel.getByPlaceholder('Результат проверки').waitFor();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('profi24:order-draft:v1:701:1:completion')||'null')?.baseline.repair_result==='Unsaved repair');
  await reload();await page.evaluate(()=>window.dispatchEvent(new CustomEvent('profi24:open-completion',{detail:{id:1}})));
  await panel.getByRole('button',{name:'Восстановить черновик'}).click();assert.equal(await panel.getByPlaceholder('Результат проверки').inputValue(),'Unsaved verification');
  await panel.getByRole('button',{name:'Проверка пройдена'}).click();await page.waitForFunction(()=>!localStorage.getItem('profi24:order-draft:v1:701:1:completion'));
  // Work form persists without adding a work item and survives a rejected POST.
  await reload();await page.evaluate(()=>window.dispatchEvent(new CustomEvent('profi24:open-order360',{detail:{id:1}})));
  const work=page.locator('.o360Card').filter({has:page.locator('input[placeholder="Работа"]')});await work.getByPlaceholder('Работа',{exact:true}).fill('Draft work');await work.getByPlaceholder('Цена клиенту').fill('15000');
  await work.getByRole('button',{name:'Добавить работу',exact:true}).click();await page.locator('.o360Err').filter({hasText:'Synthetic work rejected'}).waitFor();
  await reload();await page.evaluate(()=>window.dispatchEvent(new CustomEvent('profi24:open-order360',{detail:{id:1}})));
  await work.getByRole('button',{name:'Восстановить черновик'}).click();assert.equal(await work.getByPlaceholder('Работа',{exact:true}).inputValue(),'Draft work');
  failWork=false;await work.getByRole('button',{name:'Добавить работу',exact:true}).click();await page.waitForFunction(()=>!localStorage.getItem('profi24:order-draft:v1:701:1:work'));
  // Another employee must not be offered the first user's draft.
  await reload();await openDiag(1);await page.locator('.df').getByLabel('Симптомы').fill('Private user draft');
  await page.evaluate(()=>localStorage.user=JSON.stringify({id:702,name:'Other User',role:'OWNER'}));await reload();await openDiag(1);
  assert.equal(await page.locator('.df').getByRole('button',{name:'Восстановить черновик'}).count(),0);assert.equal(await page.locator('.df').getByLabel('Симптомы').inputValue(),'Changed by colleague');
  console.log('ENGINEER_FORM_DRAFTS: ok');
 }finally{await context.close();await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
