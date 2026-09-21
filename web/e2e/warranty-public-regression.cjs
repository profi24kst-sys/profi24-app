const {chromium}=require('playwright');
const {execFileSync}=require('child_process');
const fs=require('fs'),path=require('path');
const BASE=process.env.BASE_URL||'http://127.0.0.1:5173';
const artifacts=path.join(__dirname,'artifacts');fs.mkdirSync(artifacts,{recursive:true});
function fail(m){throw new Error(m)}
function seed(){
 const suffix=Date.now().toString(36).toUpperCase(),number='E2E-WARRANTY-'+suffix,token=('a'.repeat(47)+String(Date.now()%10)).slice(0,48);
 const snapshot=JSON.stringify({
  request:{id:999999,number,customer_name:'E2E Warranty Client',phone:'+77025550999',address:'INTERNAL ADDRESS',category:'Холодильник',brand:'LG',model:'E2E-W',serial_number:'W-'+suffix,engineer_id:999,engineer_name:'E2E Engineer',total:45000,paid:45000,closed_at:new Date().toISOString(),warranty_until:'2026-12-31'},
  works:[{id:111,name:'Замена компрессора',qty:1,unit_price:20000,direct_cost:7000,performed_by:999}],
  parts:[{id:222,name:'Компрессор',qty:1,sale_price:25000,purchase_price:12000,status:'INSTALLED'}],
  warranty_days:90
 }).replace(/'/g,"''");
 const sql=`WITH u AS (
   INSERT INTO users(name,email,password_hash,role) VALUES('E2E Engineer','e2e-warranty-${suffix}@test.invalid','x','ENGINEER') RETURNING id
 ), c AS (
   INSERT INTO customers(name,phone,address) VALUES('E2E Warranty Client','+77025550999','INTERNAL ADDRESS') RETURNING id
 ), e AS (
   INSERT INTO equipment(customer_id,category,brand,model,serial_number) SELECT c.id,'Холодильник','LG','E2E-W','W-${suffix}' FROM c RETURNING id,customer_id
 ), r AS (
   INSERT INTO requests(number,customer_id,equipment_id,engineer_id,status,complaint,total,paid,closed_at,warranty_until)
   SELECT '${number}',e.customer_id,e.id,u.id,'CLOSED','Browser warranty acceptance',45000,45000,now(),CURRENT_DATE+90 FROM e,u RETURNING id
 )
 INSERT INTO warranty_cards(request_id,token,warranty_days,warranty_until,snapshot,content_hash)
 SELECT r.id,'${token}',90,CURRENT_DATE+90,'${snapshot}'::jsonb,'INTERNAL-CONTENT-HASH' FROM r RETURNING request_id;`;
 const out=execFileSync('docker',['compose','exec','-T','db','psql','-U','profi24','-d','profi24','-At','-c',sql],{encoding:'utf8'}).trim().split('\n')[0];
 if(!Number(out))fail('failed to seed warranty fixture: '+out);
 return{number,token};
}
(async()=>{
 const fixture=seed(),browser=await chromium.launch({headless:true}),ctx=await browser.newContext(),page=await ctx.newPage();
 try{
  const api=await page.request.get(BASE+'/warranty-api/public/warranty/'+fixture.token);
  if(api.status()!==200)fail('public warranty API '+api.status());
  const body=await api.json(),data=body.data||{};
  const serialized=JSON.stringify(data);
  for(const secret of ['direct_cost','purchase_price','performed_by','content_hash','request_id','snapshot','INTERNAL ADDRESS','INTERNAL-CONTENT-HASH']){
   if(serialized.includes(secret))fail('public warranty leaked '+secret);
  }
  if(data.number!==fixture.number)fail('warranty number missing');
  if(data.engineer_name!=='E2E Engineer')fail('engineer name missing');
  if(Number(data.works?.[0]?.unit_price)!==20000)fail('public work sale price missing');
  if(Number(data.parts?.[0]?.sale_price)!==25000)fail('public part sale price missing');

  await page.goto(BASE+'/warranty/'+fixture.token,{waitUntil:'domcontentloaded'});
  await page.getByText('Электронный гарантийный талон',{exact:true}).waitFor({state:'visible',timeout:10000});
  await page.getByRole('heading',{name:fixture.number,exact:true}).waitFor({state:'visible'});
  await page.getByText('E2E Warranty Client',{exact:true}).waitFor({state:'visible'});
  await page.getByText('E2E Engineer',{exact:true}).waitFor({state:'visible'});
  await page.getByText('Замена компрессора × 1',{exact:true}).waitFor({state:'visible'});
  await page.getByText('Компрессор × 1',{exact:true}).waitFor({state:'visible'});
  if(await page.getByText(/INTERNAL ADDRESS|12000|7000/).isVisible().catch(()=>false))fail('sensitive warranty value rendered in UI');
  console.log('warranty_public_regression=ok order='+fixture.number);
 }catch(e){
  try{await page.screenshot({path:path.join(artifacts,'warranty-public-failure.png'),fullPage:true})}catch{}
  fs.writeFileSync(path.join(artifacts,'warranty-public-error.txt'),String(e.stack||e));
  console.error(e);process.exitCode=1;
 }finally{await ctx.close().catch(()=>{});await browser.close()}
})();
