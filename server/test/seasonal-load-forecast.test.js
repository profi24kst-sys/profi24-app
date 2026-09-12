import {test}from'node:test';
import assert from'node:assert/strict';
import{PGlite}from'@electric-sql/pglite';
import{buildSeasonalLoadForecast,resolveSeasonalForecastBranchIds}from'../src/seasonal-load-forecast.js';

const q=(db,sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(result=>result.at(-1));
const isoMonth=(year,month)=>`${year}-${String(month).padStart(2,'0')}-10T06:00:00Z`;

test('seasonal forecast exposes demand, specialty capacity, branch scope and measured error',async()=>{
 const db=await PGlite.create();
 try{
  await q(db,`CREATE TABLE branches(id SERIAL PRIMARY KEY,code TEXT,name TEXT);
CREATE TABLE users(id SERIAL PRIMARY KEY,name TEXT,role TEXT,active BOOLEAN DEFAULT true,primary_branch_id INT);
CREATE TABLE user_branches(user_id INT,branch_id INT);
CREATE TABLE equipment(id SERIAL PRIMARY KEY,category TEXT);
CREATE TABLE requests(id SERIAL PRIMARY KEY,number TEXT,equipment_id INT,branch_id INT,engineer_id INT,status TEXT,created_at TIMESTAMPTZ,closed_at TIMESTAMPTZ,deleted_at TIMESTAMPTZ);`);
  const kst=(await q(db,"INSERT INTO branches(code,name) VALUES('KST','Костанай') RETURNING id")).rows[0].id;
  const tld=(await q(db,"INSERT INTO branches(code,name) VALUES('TLD','Талдыкорган') RETURNING id")).rows[0].id;
  const manager=(await q(db,"INSERT INTO users(name,role,primary_branch_id) VALUES('Менеджер','MANAGER',$1) RETURNING id",[kst])).rows[0].id;
  const fridgeEngineer=(await q(db,"INSERT INTO users(name,role,primary_branch_id) VALUES('Холодильщик','ENGINEER',$1) RETURNING id",[kst])).rows[0].id;
  const washerEngineer=(await q(db,"INSERT INTO users(name,role,primary_branch_id) VALUES('Мастер СМ','ENGINEER',$1) RETURNING id",[kst])).rows[0].id;
  const newEngineer=(await q(db,"INSERT INTO users(name,role,primary_branch_id) VALUES('Новый мастер','ENGINEER',$1) RETURNING id",[kst])).rows[0].id;
  const foreignEngineer=(await q(db,"INSERT INTO users(name,role,primary_branch_id) VALUES('Чужой мастер','ENGINEER',$1) RETURNING id",[tld])).rows[0].id;
  await q(db,'INSERT INTO user_branches(user_id,branch_id) VALUES($1,$2),($3,$2),($4,$2),($5,$2),($6,$7)',[manager,kst,fridgeEngineer,washerEngineer,newEngineer,foreignEngineer,tld]);
  const fridge=(await q(db,"INSERT INTO equipment(category) VALUES('Холодильник') RETURNING id")).rows[0].id;
  const washer=(await q(db,"INSERT INTO equipment(category) VALUES('Стиральная машина') RETURNING id")).rows[0].id;
  const dishwasher=(await q(db,"INSERT INTO equipment(category) VALUES('Посудомоечная машина') RETURNING id")).rows[0].id;
  let sequence=0;
  for(let offset=0;offset<24;offset++){
   const date=new Date(Date.UTC(2024,5+offset,10,6)),year=date.getUTCFullYear(),month=date.getUTCMonth()+1,fridgeCount=month===7?20:5;
   for(let index=0;index<fridgeCount;index++){const created=isoMonth(year,month);await q(db,"INSERT INTO requests(number,equipment_id,branch_id,engineer_id,status,created_at,closed_at) VALUES($1,$2,$3,$4,'CLOSED',$5,$5)",[`K-F-${++sequence}`,fridge,kst,fridgeEngineer,created])}
   for(let index=0;index<4;index++){const created=isoMonth(year,month);await q(db,"INSERT INTO requests(number,equipment_id,branch_id,engineer_id,status,created_at,closed_at) VALUES($1,$2,$3,$4,'CLOSED',$5,$5)",[`K-W-${++sequence}`,washer,kst,washerEngineer,created])}
   await q(db,"INSERT INTO requests(number,equipment_id,branch_id,status,created_at) VALUES($1,$2,$3,'NEW',$4)",[`K-D-${++sequence}`,dishwasher,kst,isoMonth(year,month)]);
   await q(db,"INSERT INTO requests(number,equipment_id,branch_id,engineer_id,status,created_at,closed_at) VALUES($1,$2,$3,$4,'CLOSED',$5,$5)",[`T-${++sequence}`,fridge,tld,foreignEngineer,isoMonth(year,month)]);
  }
  await q(db,"INSERT INTO requests(number,equipment_id,branch_id,status,created_at) VALUES('CANCELLED',$1,$2,'CANCELLED','2026-05-10T06:00:00Z')",[fridge,kst]);
  await q(db,"INSERT INTO requests(number,equipment_id,branch_id,status,created_at,deleted_at) VALUES('DELETED',$1,$2,'NEW','2026-05-10T06:00:00Z','2026-05-11T06:00:00Z')",[fridge,kst]);

  assert.deepEqual(await resolveSeasonalForecastBranchIds(db,{id:manager,role:'MANAGER'}),[Number(kst)]);
  const result=await buildSeasonalLoadForecast(db,{branchIds:[Number(kst)],branchId:Number(kst),asOf:'2026-06-15',historyMonths:24,horizonMonths:2,now:new Date('2026-06-15T08:00:00Z')});
  assert.equal(result.months.length,2);assert.equal(result.months[0].month,'2026-06');assert.equal(result.months[1].month,'2026-07');
  assert.ok(result.months[1].forecast_orders>result.months[0].forecast_orders,'July seasonality must raise demand');
  assert.ok(result.summary.backtest.points>=6);assert.notEqual(result.summary.backtest.wape_pct,null);assert.ok(result.summary.backtest.accuracy_pct>=0);
  assert.ok(result.summary.projected_gap>0);assert.ok(result.summary.overloaded_specialties>0);
  assert.ok(result.specialties.every(row=>row.branch_id===Number(kst)));assert.ok(!result.specialties.some(row=>row.branch_name==='Талдыкорган'));
  const fridgeRow=result.specialties.find(row=>row.category==='Холодильник');assert.ok(fridgeRow);assert.equal(fridgeRow.engineer_count,1);assert.ok(fridgeRow.monthly_capacity>0);assert.equal(fridgeRow.forecast[1].month,'2026-07');
  assert.equal(result.capacity.classified_engineers,2);assert.equal(result.capacity.unclassified_engineers,1);
  await assert.rejects(buildSeasonalLoadForecast(db,{branchIds:[Number(kst)],branchId:Number(tld),asOf:'2026-06-15'}),error=>error.code==='FORBIDDEN');
  await assert.rejects(buildSeasonalLoadForecast(db,{branchIds:[Number(kst)],asOf:'2026-06-15',historyMonths:6}),error=>error.code==='VALIDATION');
 }finally{await db.close()}
});
