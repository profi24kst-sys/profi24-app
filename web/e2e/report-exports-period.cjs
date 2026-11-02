const assert=require('node:assert/strict'),{chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),artifacts=path.join(__dirname,'artifacts');
const BASE=process.env.BASE_URL||'http://127.0.0.1:5173',EMAIL=process.env.E2E_EMAIL||'browser-owner@test.invalid',PASSWORD=process.env.E2E_PASSWORD;
(async()=>{
 const browser=await chromium.launch({headless:true}),context=await browser.newContext({acceptDownloads:true,serviceWorkers:'block'}),page=await context.newPage(),errors=[],exportRequests=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{const url=new URL(r.url());if(url.pathname.endsWith('/export'))exportRequests.push(url.pathname+url.search)});
 try{
  assert.ok(PASSWORD,'E2E_PASSWORD is required');await page.goto(BASE+'/orders');await page.getByPlaceholder('Email').fill(EMAIL);await page.getByPlaceholder('Пароль').fill(PASSWORD);
  // Role-dependent addon roots reload once after login; wait for that navigation.
  const loginReload=page.waitForEvent('framenavigated',{predicate:frame=>frame===page.mainFrame(),timeout:15000});
  await page.getByRole('button',{name:'Войти',exact:true}).click();await loginReload;await page.waitForLoadState('domcontentloaded');await page.locator('section.table[aria-busy="false"]').waitFor();
  await page.locator('aside').getByRole('button',{name:/Отч[её]ты/}).click();
  const box=page.locator('.dir-report-box'),period=page.locator('.reportPeriod'),buttons=box.locator('.dir-export-btn');
  assert.equal(await box.locator('input[type="month"]').count(),0,'exports must use the report range, not a separate month');
  await period.getByLabel('С',{exact:true}).fill('2026-02-01');
  const selected=page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname==='/api/v1/dashboard/finance'&&u.searchParams.get('from')==='2026-02-01'&&u.searchParams.get('to')==='2026-02-03'});
  await period.getByLabel('По',{exact:true}).fill('2026-02-03');assert.equal((await selected).status(),200);
  for(let i=0;i<2;i++){
   const requested=page.waitForRequest(r=>new URL(r.url()).pathname==='/api/v1/directory/'+(i?'customers':'orders')+'/export'),downloaded=page.waitForEvent('download');
   await buttons.nth(i).click();const [request,download]=await Promise.all([requested,downloaded]);
   const url=new URL(request.url());assert.equal(url.searchParams.get('from'),'2026-02-01');assert.equal(url.searchParams.get('to'),'2026-02-03');assert.equal(url.searchParams.has('month'),false);assert.equal(await download.failure(),null);assert.match(download.suggestedFilename(),/\.xlsx$/);
  }
  await period.getByLabel('По',{exact:true}).fill('');assert.equal(await buttons.nth(0).isDisabled(),true);assert.equal(await buttons.nth(1).isDisabled(),true);await box.getByRole('alert').waitFor();
  await period.getByLabel('По',{exact:true}).fill('2026-01-01');assert.equal(await buttons.nth(0).isDisabled(),true);
  await period.getByLabel('По',{exact:true}).fill('2027-03-01');assert.equal(await buttons.nth(0).isDisabled(),true);
  await period.getByLabel('По',{exact:true}).fill('2026-02-03');assert.equal(await buttons.nth(0).isEnabled(),true);
  assert.deepEqual(errors,[]);console.log('REPORT_EXPORTS_PERIOD: ok selected_range=ok invalid_range_blocked=ok downloads=2');
 }catch(error){fs.mkdirSync(artifacts,{recursive:true});await page.screenshot({path:path.join(artifacts,'report-exports-period-failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(artifacts,'report-exports-period-error.txt'),JSON.stringify({error:String(error.stack||error),url:page.url(),exportRequests,errors},null,2));throw error}
 finally{await context.close();await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
