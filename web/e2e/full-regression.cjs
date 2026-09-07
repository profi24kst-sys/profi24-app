const {chromium}=require('playwright');
const fs=require('fs');
const path=require('path');

const BASE=process.env.BASE_URL||'http://127.0.0.1:5173';
const OWNER_EMAIL=process.env.E2E_EMAIL||'browser-owner@test.invalid';
const OWNER_PASSWORD=process.env.E2E_PASSWORD||'BrowserOwner2026Kst9';
const ROLE_PASSWORD='RoleBrowser2026Kst9';
const artifacts=path.join(__dirname,'artifacts');
fs.mkdirSync(artifacts,{recursive:true});

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zg3sAAAAASUVORK5CYII=','base64');
const pdf=Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n','utf8');
const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>','utf8');

function fail(message){throw new Error(message)}
async function login(page,email,password){
  await page.goto(BASE,{waitUntil:'domcontentloaded'});
  await page.locator('input[autocomplete="username"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.getByRole('button',{name:'Войти'}).click();
  await page.locator('aside').waitFor({state:'visible',timeout:10000});
  await page.waitForTimeout(500);
}
async function api(page,url,{method='GET',body,headers={}}={}){
  return page.evaluate(async({url,method,body,headers})=>{
    const token=localStorage.getItem('token')||'';
    const r=await fetch(url,{method,headers:{Authorization:`Bearer ${token}`,...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    const text=await r.text();let json={};try{json=JSON.parse(text)}catch{}
    return{status:r.status,ok:r.ok,data:json.data,error:json.error,text};
  },{url,method,body,headers});
}
async function createUser(page,name,role){
  const email=`e2e-${role.toLowerCase()}@test.invalid`;
  const r=await api(page,'/api/v1/users',{method:'POST',body:{name,email,role,password:ROLE_PASSWORD}});
  if(r.status!==201)fail(`create ${role}: ${r.status} ${r.error?.message||r.text}`);
  return{...r.data,email,password:ROLE_PASSWORD};
}
async function openOrder(page,number){
  await page.getByRole('button',{name:/Заказы/}).first().click();
  const target=page.getByText(number,{exact:true}).first();
  await target.waitFor({state:'visible',timeout:8000});
  await target.click();
  const currentLayout=page.locator('.hcHeroLeft strong').filter({hasText:number}).first();
  const legacyLayout=page.locator('.ordertitle h2').filter({hasText:number}).first();
  await Promise.race([
    currentLayout.waitFor({state:'visible',timeout:8000}),
    legacyLayout.waitFor({state:'visible',timeout:8000})
  ]);
}
async function visibleNav(page,label){return page.getByRole('button',{name:new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`)}).first().isVisible().catch(()=>false)}
async function assertVisible(page,label,want=true){const got=await visibleNav(page,label);if(got!==want)fail(`${label} visibility expected ${want}, got ${got}`)}

(async()=>{
  const browser=await chromium.launch({headless:true});
  const errors=[];const failures=[];
  const ownerCtx=await browser.newContext();const owner=await ownerCtx.newPage();
  owner.on('pageerror',e=>errors.push(`pageerror:${e.message}`));
  owner.on('console',m=>{if(m.type()==='error')errors.push(`console:${m.text()}`)});
  owner.on('response',r=>{try{const u=new URL(r.url());if(u.origin===BASE&&r.status()>=500)failures.push(`${r.status()} ${u.pathname}`)}catch{}});
  try{
    await login(owner,OWNER_EMAIL,OWNER_PASSWORD);

    // OWNER navigation and Staff regression.
    await assertVisible(owner,'Финансы',true);await assertVisible(owner,'Сотрудники',true);
    await owner.getByRole('button',{name:/Сотрудники/}).click();
    await owner.getByText('Добавить сотрудника',{exact:true}).waitFor({state:'visible',timeout:6000});
    const roles=await owner.locator('main select').first().locator('option').evaluateAll(opts=>opts.map(o=>o.value));
    for(const role of ['OWNER','SUPERVISOR','ACCOUNTANT','MANAGER','ENGINEER','TRAINEE'])if(!roles.includes(role))fail(`Staff missing role ${role}`);

    // Build the six-role fixture through the real API.
    const supervisor=await createUser(owner,'E2E Supervisor','SUPERVISOR');
    const accountant=await createUser(owner,'E2E Accountant','ACCOUNTANT');
    const manager=await createUser(owner,'E2E Manager','MANAGER');
    const engineer=await createUser(owner,'E2E Engineer','ENGINEER');
    const trainee=await createUser(owner,'E2E Trainee','TRAINEE');

    const c=await api(owner,'/api/v1/customers',{method:'POST',body:{name:'E2E Клиент',phone:'+77010000001',address:'Костанай'}});
    if(c.status!==201)fail(`customer create ${c.status} ${c.error?.message||''}`);
    const e=await api(owner,'/api/v1/equipment',{method:'POST',body:{customer_id:c.data.id,category:'Холодильник',brand:'E2E',model:'Browser'}});
    if(e.status!==201)fail(`equipment create ${e.status}`);
    const o=await api(owner,'/api/v1/requests',{method:'POST',body:{customer_id:c.data.id,equipment_id:e.data.id,complaint:'E2E проверка полного цикла',source:'OTHER',engineer_id:engineer.id,visit_type:'FIELD'}});
    if(o.status!==201)fail(`order create ${o.status} ${o.error?.message||''}`);
    const order=o.data;

    let r=await api(owner,`/directory-api/v1/trainees/${trainee.id}/mentor`,{method:'PUT',body:{mentor_id:engineer.id}});
    if(!r.ok)fail(`mentor ${r.status} ${r.error?.message||''}`);
    r=await api(owner,`/directory-api/v1/requests/${order.id}/participants`,{method:'POST',body:{user_id:trainee.id}});
    if(!r.ok)fail(`trainee participant ${r.status} ${r.error?.message||''}`);

    // Attachment API contract: all real business kinds work; invalid/spoofed content does not.
    const pngUrl=`data:image/png;base64,${png.toString('base64')}`;
    const pdfUrl=`data:application/pdf;base64,${pdf.toString('base64')}`;
    const uploaded=[];
    for(const kind of ['DEFECT_PHOTO','PHOTO_BEFORE','NAMEPLATE','PHOTO_AFTER']){
      const x=await api(owner,`/documents-api/v1/requests/${order.id}/files`,{method:'POST',body:{name:`${kind.toLowerCase()}.png`,kind,data:pngUrl}});
      if(x.status!==201)fail(`upload ${kind}: ${x.status} ${x.error?.message||x.text}`);uploaded.push(x.data);
    }
    const p=await api(owner,`/documents-api/v1/requests/${order.id}/files`,{method:'POST',body:{name:'proof.pdf',kind:'OTHER',data:pdfUrl}});
    if(p.status!==201)fail(`upload pdf ${p.status} ${p.error?.message||''}`);uploaded.push(p.data);
    const badKind=await api(owner,`/documents-api/v1/requests/${order.id}/files`,{method:'POST',body:{name:'bad.png',kind:'UNKNOWN_PHOTO',data:pngUrl}});
    if(badKind.status!==422)fail(`invalid attachment kind expected 422 got ${badKind.status}`);
    const badSvg=await api(owner,`/documents-api/v1/requests/${order.id}/files`,{method:'POST',body:{name:'bad.svg',kind:'OTHER',data:`data:image/svg+xml;base64,${svg.toString('base64')}`}});
    if(badSvg.status!==422)fail(`unsafe SVG expected 422 got ${badSvg.status}`);
    const protectedNoAuth=await owner.evaluate(async id=>(await fetch(`/documents-api/v1/files/${id}`)).status,uploaded[0].id);
    if(protectedNoAuth!==401)fail(`protected file without bearer expected 401 got ${protectedNoAuth}`);
    const protectedAuth=await api(owner,`/documents-api/v1/files/${uploaded[0].id}`);
    if(protectedAuth.status!==200)fail(`protected file with bearer expected 200 got ${protectedAuth.status}`);

    // Exact browser workflow from the reported bug: Order 360 -> Documents -> PHOTO_BEFORE input.
    await owner.goto(BASE,{waitUntil:'domcontentloaded'});await owner.waitForTimeout(500);
    await openOrder(owner,order.number);
    await owner.getByRole('button',{name:/Документы/}).click();
    await owner.locator('.orderFilesCard').waitFor({state:'visible',timeout:8000});
    await owner.locator('[data-kind]').selectOption('PHOTO_BEFORE');
    await owner.locator('[data-file-input]').setInputFiles({name:'browser-before.png',mimeType:'image/png',buffer:png});
    await owner.getByText('browser-before.png',{exact:true}).waitFor({state:'visible',timeout:10000});
    if(await owner.locator('.orderFilesError:not([hidden])').isVisible().catch(()=>false))fail('Order 360 attachment UI shows an error after valid PHOTO_BEFORE upload');

    // Completion must open for OWNER with finance controls available.
    await owner.getByRole('button',{name:/Основное/}).click();
    await owner.getByRole('button',{name:'Открыть завершение ремонта'}).click();
    await owner.locator('.co').waitFor({state:'visible',timeout:8000});
    await owner.getByRole('heading',{name:'Завершение ремонта'}).waitFor({state:'visible'});
    await owner.locator('.co header button').click();

    // Sweep every visible OWNER sidebar entry in a clean render and prove UI remains responsive.
    await owner.goto(BASE,{waitUntil:'domcontentloaded'});await owner.waitForTimeout(1000);
    const navLabels=await owner.locator('aside nav button:visible').evaluateAll(btns=>btns.map(b=>(b.textContent||'').replace(/\d+$/,'').trim()).filter(Boolean));
    if(navLabels.length<10)fail(`too few visible owner navigation modules: ${navLabels.join(', ')}`);
    for(const label of [...new Set(navLabels)]){
      await owner.goto(BASE,{waitUntil:'domcontentloaded'});await owner.waitForTimeout(450);
      const button=owner.locator('aside nav button:visible').filter({hasText:label}).first();
      if(!await button.count())continue;
      await button.click({timeout:6000});await owner.waitForTimeout(250);
      const alive=await owner.evaluate(()=>21*2);if(alive!==42)fail(`main thread stopped responding after nav ${label}`);
    }

    async function roleCase(account,expected){
      const ctx=await browser.newContext();const page=await ctx.newPage();
      page.on('pageerror',e=>errors.push(`${account.role}:pageerror:${e.message}`));
      await login(page,account.email,account.password);
      for(const [label,want] of Object.entries(expected.nav||{}))await assertVisible(page,label,want);
      if(expected.order){
        await openOrder(page,order.number);
        for(const [label,want] of Object.entries(expected.tabs||{})){
          const b=page.locator('.ordertabs button').filter({hasText:label}).first();const got=await b.isVisible().catch(()=>false);if(got!==want)fail(`${account.role} tab ${label} expected ${want}, got ${got}`);
        }
        if(expected.completion){
          const b=page.getByRole('button',{name:'Открыть завершение ремонта'});
          if(!await b.isVisible())fail(`${account.role} completion should be visible`);
          await b.click();await page.locator('.co').waitFor({state:'visible',timeout:8000});
          if(account.role==='ENGINEER'){
            if(await page.getByRole('button',{name:'Принять оплату'}).isVisible().catch(()=>false))fail('ENGINEER sees payment action in completion');
            if(await page.getByRole('button',{name:/Закрыть заказ/}).isVisible().catch(()=>false))fail('ENGINEER sees close action in completion');
            if(!await page.getByRole('button',{name:/Зафиксировать ремонт/}).isVisible().catch(()=>false))fail('ENGINEER cannot access technical completion');
          }
        }
      }
      await ctx.close();
    }

    await roleCase({...supervisor,role:'SUPERVISOR'},{nav:{'Финансы':true,'Сотрудники':false,'Наставничество':true},order:true,tabs:{'Работы':true,'Запчасти':true,'Оплаты':true},completion:true});
    await roleCase({...accountant,role:'ACCOUNTANT'},{nav:{'Финансы':true,'Сотрудники':false,'Наставничество':false},order:true,tabs:{'Работы':false,'Запчасти':false,'Оплаты':true},completion:false});
    await roleCase({...manager,role:'MANAGER'},{nav:{'Финансы':true,'Сотрудники':false},order:true,tabs:{'Работы':true,'Запчасти':true,'Оплаты':true},completion:true});
    await roleCase({...engineer,role:'ENGINEER'},{nav:{'Финансы':false,'Сотрудники':false,'Мастер':true},order:true,tabs:{'Работы':true,'Запчасти':true,'Оплаты':true},completion:true});
    await roleCase({...trainee,role:'TRAINEE'},{nav:{'Финансы':false,'Сотрудники':false,'Наставничество':false},order:true,tabs:{'Работы':false,'Запчасти':false,'Оплаты':false},completion:false});

    // Server-side negative RBAC probes for the highest-risk money/technical boundaries.
    const probe=async(account,checks)=>{
      const ctx=await browser.newContext();const page=await ctx.newPage();await login(page,account.email,account.password);
      for(const check of checks){const res=await api(page,check.url,{method:check.method||'GET',body:check.body});if(!check.status.includes(res.status))fail(`${account.role} ${check.method||'GET'} ${check.url}: expected ${check.status}, got ${res.status}`)}
      await ctx.close();
    };
    await probe({...engineer,role:'ENGINEER'},[
      {url:'/finance-api/v1/accounts',status:[403]},
      {url:`/api/v1/requests/${order.id}/payment`,method:'POST',body:{amount:1,account_id:1},status:[403,422]},
      {url:`/completion-api/v1/requests/${order.id}`,status:[200]}
    ]);
    await probe({...trainee,role:'TRAINEE'},[
      {url:`/api/v1/requests/${order.id}/diagnosis`,method:'POST',body:{diagnosis:'forbidden'},status:[403]},
      {url:`/completion-api/v1/requests/${order.id}/repair-done`,method:'POST',body:{repair_result:'forbidden'},status:[403]},
      {url:`/documents-api/v1/requests/${order.id}/files`,method:'POST',body:{name:'trainee.png',kind:'PHOTO_BEFORE',data:pngUrl},status:[201]}
    ]);
    await probe({...accountant,role:'ACCOUNTANT'},[
      {url:`/api/v1/requests/${order.id}/diagnosis`,method:'POST',body:{diagnosis:'forbidden'},status:[403]},
      {url:'/finance-api/v1/accounts',status:[200]}
    ]);
    await probe({...manager,role:'MANAGER'},[
      {url:'/finance-api/v1/audit',status:[403]},
      {url:'/finance-api/v1/accounts',status:[200]}
    ]);

    if(errors.length)fail(`browser errors:\n${errors.join('\n')}`);
    if(failures.length)fail(`same-origin 5xx responses:\n${failures.join('\n')}`);
    console.log(`full_regression=ok nav_modules=${navLabels.length} order=${order.number}`);
  }catch(error){
    try{await owner.screenshot({path:path.join(artifacts,'full-regression-failure.png'),fullPage:true})}catch{}
    fs.writeFileSync(path.join(artifacts,'full-regression-error.txt'),String(error.stack||error));
    console.error(error);process.exitCode=1;
  }finally{await ownerCtx.close().catch(()=>{});await browser.close()}
})();
