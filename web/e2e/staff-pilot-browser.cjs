const assert=(v,m)=>{if(!v)throw Error(m)};
async function api(p,url,body,method){
 const token=await p.evaluate(()=>localStorage.token);
 const r=await p.request.fetch(p.pilotBase+url,{method:method||(body?'POST':'GET'),headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{data:body}:{})});
 const j=await r.json();assert(r.ok(),url+' '+r.status()+' '+JSON.stringify(j.error||{}));return j.data;
}
async function signIn(browser,email,password,base){
 const ctx=await browser.newContext(),p=await ctx.newPage();p.pilotBase=base;
 await p.goto(base+'/orders',{waitUntil:'domcontentloaded'});
 await p.locator('input[autocomplete="username"]').fill(email);
 await p.locator('input[autocomplete="current-password"]').fill(password);
 await p.getByRole('button',{name:'Войти'}).click();
 await p.locator('aside').waitFor({state:'visible',timeout:12000});
 // A login triggers a one-time reload while independent addon roots sync the role.
 // Do not open the order drawer until that reload and the orders bootstrap finish.
 await p.waitForTimeout(1000);
 await p.waitForFunction(expected=>{try{return JSON.parse(localStorage.user||'null')?.email===expected}catch{return false}},email,{timeout:12000});
 if(email.startsWith('pilot-manager-'))await p.locator('section.table[aria-busy="false"]').waitFor({state:'visible',timeout:20000});
 return{ctx,p};
}
module.exports=async({browser,owner,base})=>{
 const s=Date.now().toString(36).toUpperCase(),password='PilotBrowser2026Kst9',sessions=[];owner.pilotBase=base;
 const branch=(await api(owner,'/branch-api/v1/branches')).find(x=>x.code==='KST');assert(branch,'KST branch missing');
 try{
  const users={};
  for(const role of ['MANAGER','ENGINEER']){
   const email='pilot-'+role.toLowerCase()+'-'+s+'@test.invalid';
   users[role]={...await api(owner,'/api/v1/users',{name:'Pilot '+role,email,role,password}),email};
   await api(owner,'/branch-api/v1/users/'+users[role].id+'/branches',{branch_ids:[branch.id],primary_branch_id:branch.id},'PUT');
  }
  const m=await signIn(browser,users.MANAGER.email,password,base);sessions.push(m);
  await m.p.locator('section.table[aria-busy="false"]').waitFor({state:'visible',timeout:20000});
  await m.p.getByRole('button',{name:/Новый заказ/}).click();
  const d=m.p.locator('.drawer');await d.waitFor({state:'visible'});
  await d.locator('#new-customer-name').fill('Pilot Client '+s);
  await d.locator('#new-customer-phone').fill('+7705'+String(Date.now()).slice(-7));
  await d.getByRole('button',{name:'Далее',exact:true}).click();
  await d.locator('#new-equipment-brand').fill('LG');
  await d.locator('#new-equipment-model').fill('PILOT-'+s);
  await d.getByRole('button',{name:'Далее',exact:true}).click();
  await d.locator('#new-order-complaint').fill('Пилотный заказ '+s);
  await d.locator('.grid2 select').nth(2).selectOption(String(users.ENGINEER.id));
  await d.getByRole('button',{name:'Создать заказ',exact:true}).click();
  await d.waitFor({state:'detached',timeout:20000});
  const rows=await api(m.p,'/api/v1/requests');
  const order=rows.find(x=>String(x.complaint).includes(s));
  assert(order&&Number(order.engineer_id)===Number(users.ENGINEER.id),'manager order/assignment missing');
  const e=await signIn(browser,users.ENGINEER.email,password,base);sessions.push(e);
  const assigned=await api(e.p,'/api/v1/requests');
  assert(assigned.some(x=>Number(x.id)===Number(order.id)),'engineer cannot see assigned job');
  await e.p.getByText(order.number,{exact:true}).first().click({timeout:15000});
  await e.p.locator('.o360, .engScreen').first().waitFor({state:'visible',timeout:10000});
  console.log('pilot_manager_engineer=ok order='+order.number);
 }finally{for(const session of sessions.reverse())await session.ctx.close().catch(()=>{})}
};