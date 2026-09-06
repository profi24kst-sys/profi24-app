import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './harness.js';

// pricing-guard.js is the guard that is supposed to stop a manager sending a
// customer an approval that would sell the order below cost. The audit found
// it had no test coverage at all - these lock in the margin math and the
// approve-blocking behaviour so a future edit can't silently defang the guard.
test('Guard-маржа: расчёт и блокировка низкой маржи',async t=>{
  const s=await setup();
  const {query,call,order}=s;
  await s.load('index2'); // creates request_works, which pricing-guard's margin calc reads
  await s.load('payroll');
  await s.load('pricing-guard');
  try{
    // 5% order commission for both the assigned engineer and manager.
    await query('INSERT INTO payroll_rules(user_id,order_percent) VALUES(2,5),(3,5)');

    await t.test('Здоровая маржа считается как GOOD и не блокирует согласование',async()=>{
      const id=await order('REPAIR',3,1000,2);
      await query('UPDATE requests SET direct_cost=400 WHERE id=$1',[id]);
      const check=await call('pricing-guard','GET',`/api/v1/requests/${id}/check`,undefined,1);
      assert.equal(check.status,200,JSON.stringify(check));
      // direct_cost(400) dominates work_cost+parts_cost(0); 5%+5% of price(1000) = 100 commission; no overhead (nothing closed this month yet).
      assert.equal(check.data.direct_cost,400);
      assert.equal(check.data.payroll_estimate,100);
      assert.equal(check.data.net_profit,500);
      assert.equal(check.data.net_margin,50);
      assert.equal(check.data.level,'GOOD');
      assert.equal(check.data.can_send,true);
      assert.ok(check.data.recommended_price>=check.data.minimum_price,'recommended price should never undercut the minimum price');

      const approve=await call('pricing-guard','POST',`/api/v1/requests/${id}/validate-approval`,{},1);
      assert.equal(approve.status,200,JSON.stringify(approve));
    });

    await t.test('Низкая маржа помечается DANGER и, если включен block_below_min, блокирует согласование',async()=>{
      const id=await order('REPAIR',3,1000,2);
      await query('UPDATE requests SET direct_cost=750 WHERE id=$1',[id]);
      const before=await call('pricing-guard','GET',`/api/v1/requests/${id}/check`,undefined,1);
      assert.equal(before.status,200,JSON.stringify(before));
      assert.equal(before.data.net_profit,150);
      assert.equal(before.data.net_margin,15);
      assert.equal(before.data.level,'DANGER');
      assert.equal(before.data.can_send,true,'block_below_min is still off by default');

      const badSettings=await call('pricing-guard','PUT','/api/v1/settings',{min_net_margin:30,target_net_margin:20},1);
      assert.equal(badSettings.status,422,'target must stay above the minimum margin');

      const forbidden=await call('pricing-guard','PUT','/api/v1/settings',{min_net_margin:20,target_net_margin:30,block_below_min:true},3);
      assert.equal(forbidden.status,403,'only the owner can change the guard thresholds');

      const settings=await call('pricing-guard','PUT','/api/v1/settings',{min_net_margin:20,target_net_margin:30,block_below_min:true},1);
      assert.equal(settings.status,200,JSON.stringify(settings));
      assert.equal(settings.data.block_below_min,true);

      const after=await call('pricing-guard','GET',`/api/v1/requests/${id}/check`,undefined,1);
      assert.equal(after.data.can_send,false,'DANGER orders must be blocked once block_below_min is on');

      const blocked=await call('pricing-guard','POST',`/api/v1/requests/${id}/validate-approval`,{},1);
      assert.equal(blocked.status,409);
      assert.equal(blocked.error.code,'LOW_MARGIN');
    });
  }finally{await s.close();}
});
