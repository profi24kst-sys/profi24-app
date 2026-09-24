const {chromium}=require('playwright');
const fs=require('fs'),path=require('path');
const BASE=(process.env.BASE_URL||'http://127.0.0.1:5173').replace(/\/$/,'');
const EMAIL=process.env.E2E_EMAIL||'browser-owner@test.invalid';
const PASSWORD=process.env.E2E_PASSWORD||'BrowserOwner2026Kst9';
const artifacts=path.join(__dirname,'artifacts');
fs.mkdirSync(artifacts,{recursive:true});
function assert(condition,message){if(!condition)throw new Error(message)}
(async()=>{
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1600,height:1000},acceptDownloads:true});
  let shrunkResponse=false;
  const interceptedUrls=[];
  try{
    await page.goto(BASE+'/orders',{waitUntil:'domcontentloaded',timeout:30000});
    await page.locator('input[autocomplete="username"]').fill(EMAIL);
    await page.locator('input[autocomplete="current-password"]').fill(PASSWORD);
    await page.getByRole('button',{name:'Войти',exact:true}).click();
    await page.locator('aside').waitFor({state:'visible',timeout:15000});
    await page.waitForFunction(()=>Boolean(localStorage.getItem('token')),{timeout:15000});
    const token=await page.evaluate(()=>localStorage.getItem('token'));
    async function api(url,{method='GET',body}={}){
      const response=await page.request.fetch(BASE+url,{method,
        headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},
        ...(body?{data:body}:{})});
      let result;
      try{result=await response.json()}catch{result={}};
      assert(response.ok(),method+' '+url+': '+response.status()+' '+JSON.stringify(result.error||{}));
      return result.data;
    }
    const suffix=Date.now().toString(36).toUpperCase();
    const name='E2E Пагинация '+suffix;
    const customer=await api('/api/v1/customers',{method:'POST',body:{name,phone:'+7704'+String(Date.now()).slice(-7),address:'Костанай'}});
    for(let index=1;index<=27;index++){
      await api('/api/v1/requests',{method:'POST',body:{customer_id:customer.id,complaint:'Проверка каталога '+suffix+' №'+index,source:'OTHER'}});
    }
    await page.goto(BASE+'/orders',{waitUntil:'domcontentloaded'});
    await page.locator('.dir-toolbar .search input').fill(name);
    // A previously rendered unfiltered first page also has 25 rows. Wait for the
    // debounced server search and the exact filtered count before asserting.
    await page.waitForFunction(expected=>{
      const header=document.querySelector('.dir-toolbar')?.textContent||'';
      const rows=[...document.querySelectorAll('.trow')];
      return /Найдено:\s*27/.test(header)&&rows.length===25&&rows.every(row=>row.textContent.includes(expected));
    },name,{timeout:20000});
    await page.getByRole('button',{name:'Следующая страница'}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.trow').length===2,{timeout:15000});
    const pagination=await page.locator('.dir-pagination').innerText();
    assert(pagination.includes('26–27 из 27'),'Wrong pagination total: '+pagination);
    const [xlsx]=await Promise.all([
      page.waitForEvent('download',{timeout:15000}),
      page.locator('.dir-toolbar .dir-export-btn').click()
    ]);
    assert(xlsx.suggestedFilename().endsWith('.xlsx'),'Excel file name was not .xlsx');
    // Simulate a page-2 result disappearing after refresh. The list must recover to page 1.
    shrunkResponse=false;
    const intercept=async route=>{
      const url=new URL(route.request().url);
      interceptedUrls.push(url.toString());
      // Keep shrinking page 2 until React consumes the response: global refresh can
      // also trigger a second directory reload and abort the first fetch.
      if(url.searchParams.get('search')===name&&url.searchParams.get('page')==='2'){
        shrunkResponse=true;
        return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
          data:[],meta:{page:2,limit:25,total:25,pages:1,counts:{active:25}}
        })});
      }
      return route.continue();
    };
    await page.route(/\/api\/v1\/directory\/orders(?:\?|$)/,intercept);
    await page.getByRole('button',{name:'Обновить данные'}).click();
    await page.waitForFunction(()=>{
      const footer=document.querySelector('.dir-pagination')?.textContent||'';
      return footer.includes('Стр. 1 / 2')&&document.querySelectorAll('.trow').length===25;
    },null,{timeout:20000});
    assert(shrunkResponse,'Refresh did not refetch page 2');
    await page.unroute(/\/api\/v1\/directory\/orders(?:\?|$)/,intercept);
    const customerNav=page.locator('aside nav').getByRole('button',{name:/Клиенты/}).first();
    await customerNav.click();
    await page.locator('.dir-toolbar .search input').fill(name);
    await page.locator('[data-search-record="customers-'+customer.id+'"]').waitFor({state:'visible',timeout:15000});
    const global=page.getByRole('combobox',{name:'Глобальный поиск'});
    await global.fill(name);
    const globalClient=page.locator('.globalSearchResults button').filter({hasText:name}).filter({hasText:'Клиент'}).first();
    await globalClient.waitFor({state:'visible',timeout:8000});
    await globalClient.click();
    await page.locator('.dir-focus').filter({hasText:name}).waitFor({state:'visible',timeout:8000});
    await page.locator('[data-search-record="customers-'+customer.id+'"].searchHit').waitFor({state:'visible',timeout:8000});
    await page.locator('.dir-focus button').click();
    await page.locator('.dir-focus').waitFor({state:'detached',timeout:8000});
    await global.fill(name);
    await globalClient.waitFor({state:'visible',timeout:8000});
    await globalClient.click();
    await page.locator('.dir-focus').filter({hasText:name}).waitFor({state:'visible',timeout:8000});
    await page.locator('[data-search-record="customers-'+customer.id+'"].searchHit').waitFor({state:'visible',timeout:8000});
    console.log('directory_browser_acceptance=ok pages=2 orders=27 customer_refocus='+customer.id);
  }catch(error){
    try{await page.screenshot({path:path.join(artifacts,'directory-pagination-failure.png'),fullPage:true})}catch{}
    fs.writeFileSync(path.join(artifacts,'directory-pagination-error.txt'),String(error.stack||error));
    try{const state=await page.evaluate(()=>({footer:document.querySelector('.dir-pagination')?.textContent,toolbar:document.querySelector('.dir-toolbar')?.textContent,rows:document.querySelectorAll('.trow').length,alert:document.querySelector('.errorbox')?.textContent}));console.error('directory-browser-state',JSON.stringify(state),'shrink_intercepted',shrunkResponse,'intercepted_urls',JSON.stringify(interceptedUrls))}catch{};
    console.error(error);process.exitCode=1;
  }finally{await browser.close()}
})();
