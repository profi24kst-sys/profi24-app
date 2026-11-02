const assert=require('node:assert/strict'),{chromium}=require('playwright');
const BASE=process.env.BASE_URL||'http://127.0.0.1:5173',EMAIL=process.env.E2E_EMAIL||'browser-owner@test.invalid',PASSWORD=process.env.E2E_PASSWORD;
(async()=>{
 const browser=await chromium.launch({headless:true}),context=await browser.newContext({acceptDownloads:true,serviceWorkers:'block'}),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 try{
  assert.ok(PASSWORD,'E2E_PASSWORD is required');await page.goto(BASE+'/orders');await page.getByPlaceholder('Email').fill(EMAIL);await page.getByPlaceholder('Пароль').fill(PASSWORD);await page.getByRole('button',{name:'Войти',exact:true}).click();await page.locator('section.table[aria-busy="false"]').waitFor();
  await page.locator('aside').getByRole('button',{name:/Отч[её]ты/}).click();
  const box=page.locator('.dir-report-box'),period=page.locator('.reportPeriod'),buttons=box.getByRole('button',{name:'Excel (.xlsx)',exact:true});
  assert.equal(await box.locator('input[type="month"]').count(),0,'exports must use the report range, not a separate month');
  await period.getByLabel('С',{exact:true}).fill('2026-02-01');await period.getByLabel('По',{exact:true}).fill('2026-02-03');
  for(let i=0;i<2;i++){
   const [request,download]=await Promise.all([page.waitForRequest(r=>new URL(r.url()).pathname==='/api/v1/directory/'+(i?'customers':'orders')+'/export'),page.waitForEvent('download'),buttons.nth(i).click()]);
   const url=new URL(request.url());assert.equal(url.searchParams.get('from'),'2026-02-01');assert.equal(url.searchParams.get('to'),'2026-02-03');assert.equal(url.searchParams.has('month'),false);assert.equal(await download.failure(),null);assert.match(download.suggestedFilename(),/\.xlsx$/);
  }
  await period.getByLabel('По',{exact:true}).fill('');assert.equal(await buttons.nth(0).isDisabled(),true);assert.equal(await buttons.nth(1).isDisabled(),true);await box.getByRole('alert').waitFor();
  await period.getByLabel('По',{exact:true}).fill('2026-01-01');assert.equal(await buttons.nth(0).isDisabled(),true);
  await period.getByLabel('По',{exact:true}).fill('2027-03-01');assert.equal(await buttons.nth(0).isDisabled(),true);
  await period.getByLabel('По',{exact:true}).fill('2026-02-03');assert.equal(await buttons.nth(0).isEnabled(),true);
  assert.deepEqual(errors,[]);console.log('REPORT_EXPORTS_PERIOD: ok selected_range=ok invalid_range_blocked=ok downloads=2');
 }finally{await context.close();await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
