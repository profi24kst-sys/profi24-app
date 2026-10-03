// Writes only synthetic fixtures in the isolated, loopback CI stack.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const BASE=process.env.BASE_URL||'http://127.0.0.1:5173',artifacts=path.join(__dirname,'artifacts');
if(!['localhost','127.0.0.1','[::1]'].includes(new URL(BASE).hostname))throw new Error('Cash-flow browser fixtures require an isolated local stack');
(async()=>{
 const browser=await chromium.launch({headless:true}),context=await browser.newContext(),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(BASE,{waitUntil:'domcontentloaded'});
  await page.locator('input[autocomplete="username"]').fill(process.env.E2E_EMAIL);
  await page.locator('input[autocomplete="current-password"]').fill(process.env.E2E_PASSWORD);
  const reload=page.waitForEvent('framenavigated',{predicate:f=>f===page.mainFrame(),timeout:10000});
  await page.getByRole('button',{name:'Войти'}).click();await reload;await page.waitForLoadState('domcontentloaded');
  await page.locator('aside').getByRole('button',{name:'Денежные счета',exact:true}).click();
  const panel=page.locator('.finScreen'),name='DDS browser '+Date.now();
  await panel.getByRole('button',{name:'Статьи ДДС',exact:true}).click();
  await panel.getByRole('button',{name:'Добавить статью',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.getByLabel('Название статьи').fill(name);
  for(const label of ['Расчётный счёт','Корпоративная карта','Подотчёт','Прочее'])await dialog.getByLabel(label,{exact:true}).uncheck();
  const created=page.waitForResponse(r=>new URL(r.url()).pathname==='/finance-api/v1/categories'&&r.request().method()==='POST');
  await dialog.getByRole('button',{name:'Сохранить статью',exact:true}).click();assert.equal((await created).status(),201);
  await dialog.waitFor({state:'hidden'});await panel.getByRole('cell',{name,exact:true}).waitFor();
  const account=await page.evaluate(async name=>{
   const r=await fetch('/finance-api/v1/accounts',{method:'POST',headers:{Authorization:'Bearer '+localStorage.token,'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({name,type:'CASH',initial_amount:100,initial_reason:'Synthetic DDS browser fixture'})});
   if(!r.ok)throw new Error(await r.text());return (await r.json()).data;
  },name+' cash');
  await panel.getByRole('button',{name:'Движение денег',exact:true}).click();
  await panel.getByRole('button',{name:'Операция',exact:true}).click();
  await dialog.getByLabel('Источник оплаты',{exact:true}).selectOption(String(account.id));
  await dialog.getByLabel('Статья ДДС',{exact:true}).selectOption({label:name});
  await dialog.getByLabel('Сумма, ₸',{exact:true}).fill('3.25');await dialog.getByLabel('Назначение',{exact:true}).fill('Synthetic DDS browser expense');
  await dialog.getByLabel('Дата',{exact:true}).fill('2025-09-11');
  const posting=page.waitForResponse(r=>new URL(r.url()).pathname==='/finance-api/v1/transactions'&&r.request().method()==='POST');
  await dialog.getByRole('button',{name:'Провести',exact:true}).click();assert.equal((await posting).status(),201);await dialog.waitFor({state:'hidden'});
  await panel.getByRole('button',{name:'ДДС',exact:true}).click();await panel.getByLabel('Тип периода').selectOption('range');
  await panel.getByLabel('С даты',{exact:true}).fill('2025-09-10');await panel.getByLabel('По дату включительно').fill('2025-09-12');
  const selected=page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname==='/finance-api/v1/cash-flow'&&u.searchParams.get('account_id')===String(account.id)&&u.searchParams.get('from')==='2025-09-10'&&u.searchParams.get('to')==='2025-09-12'});
  await panel.getByLabel('Счёт',{exact:true}).selectOption(String(account.id));const response=await selected;assert.equal(response.status(),200);
  const report=(await response.json()).data;assert.equal(report.summary.expense,3.25);assert.equal(report.rows[0].category_name,name);assert.equal(report.rows[0].payment_method,'CASH');
  await panel.getByRole('cell',{name,exact:true}).waitFor();
  const filtered=page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname==='/finance-api/v1/cash-flow'&&u.searchParams.get('payment_method')==='BANK'});
  await panel.getByLabel('Способ оплаты',{exact:true}).selectOption('BANK');assert.equal((await filtered).status(),200);await panel.getByText('За этот период операций нет',{exact:true}).waitFor();
  await panel.getByLabel('По дату включительно').fill('2025-09-09');await panel.getByRole('alert').filter({hasText:'Конец периода не может быть раньше начала'}).waitFor();
  assert.equal(await panel.locator('.finPeriod b').count(),0,'Invalid periods must clear stale totals');
  assert.deepEqual(errors,[]);console.log('CASH_FLOW_CATEGORIES: ok');
 }catch(error){fs.mkdirSync(artifacts,{recursive:true});await page.screenshot({path:path.join(artifacts,'cash-flow-categories-failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(artifacts,'cash-flow-categories-error.txt'),String(error.stack||error));console.error(error);process.exitCode=1;}
 finally{await context.close();await browser.close();}
})();
