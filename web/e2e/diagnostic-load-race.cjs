// Isolated browser regression: all diagnostic responses are synthetic; no CRM writes.
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const BASE=process.env.BASE_URL||'http://127.0.0.1:5173';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
(async()=>{
 const browser=await chromium.launch({headless:true});
 const page=await browser.newPage({serviceWorkers:'block'});
 const initial=deferred(),initialStarted=deferred(),old=deferred(),oldStarted=deferred(),oldFinished=deferred();
 let holdOld=false;
 const wait=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('mock response not requested within 10s')),10000)})])}finally{clearTimeout(timer)}};
 const respond=(route,data)=>route.fulfill({json:{data}});
 try{
  await page.route('**/diagnostic-api/v1/**',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname.endsWith('/fault-taxonomy'))return respond(route,{faults:[],causes:[],actions:[]});
   if(url.pathname.endsWith('/fault-patterns'))return respond(route,{patterns:[]});
   const id=Number(url.pathname.split('/').pop());
   if(id===1&&holdOld){oldStarted.resolve();await old.promise}
   await respond(route,{request:{id,number:'MOCK-'+id},diagnostic:{symptoms:'order '+id,diagnosis:'',recommendation:''},lines:[],reservations:[]});
  });
  await page.route('**/knowledge-api/v1/suggest?**',async route=>{
   const url=new URL(route.request().url()),id=Number(url.searchParams.get('request_id')),query=url.searchParams.get('q');
   if(id===1&&!holdOld){initialStarted.resolve();await initial.promise}
   await respond(route,{articles:query==='Ошибка H21'?[{id:99,title:'Решение H21',solution:'Проверить привод',match_score:10}]:[]});
   if(id===1&&holdOld)oldFinished.resolve();
  });
  await page.goto(BASE,{waitUntil:'networkidle'});
  const open=id=>page.evaluate(id=>{window.Profi24O360State={id};window.dispatchEvent(new CustomEvent('profi24:open-diagnostics'))},id);
  await open(1);await wait(initialStarted.promise);
  assert.equal(await page.locator('.df label textarea').count(),0,'initial suggestions must finish before editable diagnosis appears');
  initial.resolve();await page.locator('.df').getByLabel('Симптомы').waitFor();
  holdOld=true;await open(1);await wait(oldStarted.promise);
  await open(2);const symptoms=page.locator('.df').getByLabel('Симптомы');await symptoms.waitFor();
  assert.equal(await symptoms.inputValue(),'order 2');
  await symptoms.fill('Ошибка H21');
  const response=page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname==='/knowledge-api/v1/suggest'&&u.searchParams.get('request_id')==='2'&&u.searchParams.get('q')==='Ошибка H21'});
  await page.locator('.df').getByRole('button',{name:'Подобрать по симптомам'}).click();await response;
  await page.locator('.dfKbItem').filter({hasText:'Решение H21'}).waitFor();
  old.resolve();await wait(oldFinished.promise);
  // Give React time to commit any stale update, then assert both form and suggestions.
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.equal(await symptoms.inputValue(),'Ошибка H21','old order response must not overwrite current input');
  assert.equal(await page.locator('.dfKbItem').filter({hasText:'Решение H21'}).count(),1,'old suggestions must not replace current matches');
  console.log('diagnostic_load_race=ok');
 }finally{initial.resolve();old.resolve();await page.close();await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
