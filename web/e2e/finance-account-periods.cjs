const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const BASE=process.env.BASE_URL||'http://127.0.0.1:5173',artifacts=path.join(__dirname,'artifacts');
(async()=>{
 const browser=await chromium.launch({headless:true}),context=await browser.newContext({timezoneId:'America/Los_Angeles'}),page=await context.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(BASE,{waitUntil:'domcontentloaded'});
  await page.locator('input[autocomplete="username"]').fill(process.env.E2E_EMAIL);
  await page.locator('input[autocomplete="current-password"]').fill(process.env.E2E_PASSWORD);
  const reload=page.waitForEvent('framenavigated',{predicate:f=>f===page.mainFrame(),timeout:10000});
  await page.getByRole('button',{name:'Войти'}).click();await reload;await page.waitForLoadState('domcontentloaded');
  await page.locator('aside').getByRole('button',{name:'Денежные счета',exact:true}).click();
  const panel=page.locator('.finScreen');await panel.waitFor();
  await panel.getByRole('button',{name:'Движение денег',exact:true}).click();
  await panel.getByLabel('Тип периода').selectOption('range');
  await panel.getByLabel('С даты',{exact:true}).fill('2025-09-10');
  const selected=page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname==='/finance-api/v1/transactions'&&u.searchParams.get('from')==='2025-09-10'&&u.searchParams.get('to')==='2025-09-12'});
  await panel.getByLabel('По дату включительно').fill('2025-09-12');
  const response=await selected;assert.equal(response.status(),200);const {data}=await response.json();assert.equal(data.period.from,'2025-09-10');assert.equal(data.period.to,'2025-09-12');
  await page.waitForFunction(()=>document.querySelector('.finScreen')?.getAttribute('aria-busy')==='false');
  assert.equal(await panel.locator('.finPeriod b').count(),4);assert.equal(await panel.getByRole('alert').count(),0);
  await panel.getByRole('button',{name:'P&L',exact:true}).click();
  await panel.getByText('ФОТ учитывается за полные календарные месяцы.',{exact:false}).waitFor();
  assert.equal(await panel.locator('.finPeriod b').nth(3).textContent(),'—');assert.equal(await panel.locator('.finPeriod b').nth(5).textContent(),'—');
  const monthly=page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname==='/finance-api/v1/pnl'&&u.searchParams.has('month')});
  await panel.getByLabel('Тип периода').selectOption('month');assert.equal((await monthly).status(),200);
  await page.waitForFunction(()=>document.querySelector('.finScreen')?.getAttribute('aria-busy')==='false');
  assert.equal(await panel.getByText('ФОТ учитывается за полные календарные месяцы.',{exact:false}).count(),0);
  await panel.getByRole('button',{name:'Движение денег',exact:true}).click();await panel.getByLabel('Тип периода').selectOption('range');
  await panel.getByLabel('По дату включительно').fill('2025-09-09');await panel.getByRole('alert').filter({hasText:'Конец периода не может быть раньше начала'}).waitFor();
  assert.equal(await panel.locator('.finPeriod b').count(),0,'Previous totals must not survive an invalid date range');
  assert.deepEqual(errors,[]);console.log('FINANCE_ACCOUNT_PERIODS: ok');
 }catch(error){fs.mkdirSync(artifacts,{recursive:true});await page.screenshot({path:path.join(artifacts,'finance-account-periods-failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(artifacts,'finance-account-periods-error.txt'),String(error.stack||error));console.error(error);process.exitCode=1;}
 finally{await context.close();await browser.close();}
})();
