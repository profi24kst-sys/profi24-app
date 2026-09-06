import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './harness.js';

// kpi.js turns a handful of metrics (jobs, revenue, SLA, quality, tasks...) into
// a 0-100 score and a bonus amount that is actually paid out. The audit found
// no test exercised that formula at all - these pin it down with hand-checked
// numbers so a refactor can't quietly change how much an engineer gets paid.
test('KPI: расчёт бонуса инженера по плановым показателям',async t=>{
  const s=await setup();
  const {query,call}=s;
  await s.load('kpi');
  let seq=0;
  // Requests are already CLOSED at insert time (rather than created open and
  // updated afterwards) because a DB guard rejects any later UPDATE on a
  // closed order - closing must happen once, with every column already final.
  const closedOrder=async(engineer,total,createdAt)=>(await query(
    "INSERT INTO requests(number,customer_id,engineer_id,manager_id,status,complaint,total,created_at) VALUES($1,1,$2,2,'CLOSED','Test',$3,$4) RETURNING id",
    ['KPI-'+(++seq),engineer,total,createdAt]
  )).rows[0].id;
  try{
    await t.test('Выполнение плана ровно на 100% даёт score=100 и полный бонус',async()=>{
      await call('kpi','PUT','/api/v1/plans/3',{month:'2026-01',target_jobs:2,target_revenue:2000,target_avg_check:1000,target_conversion:100,target_sla:100,target_quality:100,bonus_max:5000},1);
      await closedOrder(3,1000,'2026-01-10T00:00:00Z');
      await closedOrder(3,1000,'2026-01-10T00:00:00Z');
      const report=await call('kpi','GET','/api/v1/report?month=2026-01',undefined,1);
      assert.equal(report.status,200,JSON.stringify(report));
      const row=report.data.rows.find(u=>u.id===3);
      assert.equal(row.assigned,2);assert.equal(row.closed,2);assert.equal(row.revenue,2000);
      assert.equal(row.conversion,100);assert.equal(row.sla,100);assert.equal(row.quality,100);
      assert.equal(row.score,100);
      assert.equal(row.bonus,5000);
      assert.equal(row.forecast_revenue,2000);
    });

    await t.test('Выполнение плана наполовину пропорционально снижает бонус',async()=>{
      await call('kpi','PUT','/api/v1/plans/4',{month:'2026-01',target_jobs:2,target_revenue:2000,target_avg_check:1000,target_conversion:100,target_sla:100,target_quality:100,bonus_max:5000},1);
      await closedOrder(4,1000,'2026-01-10T00:00:00Z');
      const report=await call('kpi','GET','/api/v1/report?month=2026-01',undefined,1);
      const row=report.data.rows.find(u=>u.id===4);
      // ratios: jobs 1/2, revenue 1000/2000, avg_check/conversion/sla/quality/tasks all at 1x -> (0.5+0.5+1+1+1+1+1)/7 = 0.857142...
      assert.equal(row.score,86);
      assert.equal(row.bonus,4300);
      assert.equal(row.forecast_revenue,1000);
    });

    await t.test('Отдельные показатели с перевыполнением не дают более чем 1.2x вклад в score, но бонус не превышает bonus_max',async()=>{
      await call('kpi','PUT','/api/v1/plans/3',{month:'2026-02',target_jobs:1,target_revenue:1000,target_avg_check:1000,target_conversion:100,target_sla:100,target_quality:100,bonus_max:5000},1);
      for(let i=0;i<4;i++)await closedOrder(3,1000,'2026-02-10T00:00:00Z');
      const report=await call('kpi','GET','/api/v1/report?month=2026-02',undefined,1);
      const row=report.data.rows.find(u=>u.id===3);
      // jobs 4/1=4 and revenue 4000/1000=4 are both capped to 1.2 before averaging: (1.2+1.2+1+1+1+1+1)/7 = 1.0571..., score rounds to 106.
      assert.equal(row.score,106);
      assert.equal(row.bonus,5000,'bonus can never exceed bonus_max even when score is over 100');
    });

    await t.test('Инженер видит в отчёте только свою строку',async()=>{
      const report=await call('kpi','GET','/api/v1/report?month=2026-01',undefined,3);
      assert.equal(report.status,200);
      assert.equal(report.data.rows.length,1);
      assert.equal(report.data.rows[0].id,3);
    });

    await t.test('План можно менять только владельцу; без выбранного сотрудника — ошибка валидации',async()=>{
      assert.equal((await call('kpi','PUT','/api/v1/plans/3',{month:'2026-01'},3)).status,403);
      assert.equal((await call('kpi','PUT','/api/v1/plans/0',{month:'2026-01'},1)).status,422);
    });
  }finally{await s.close();}
});
