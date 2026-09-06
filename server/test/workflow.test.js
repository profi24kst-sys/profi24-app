import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './harness.js';

// workflow.js is the order status state machine (NEW -> ... -> CLOSED). The
// audit found it had zero test coverage even though it gates who can move an
// order forward and under what conditions. These tests walk a real order
// through every stage and lock in the guard conditions along the way.
test('Workflow: последовательность этапов заказа и её ограничения',async t=>{
  const s=await setup();
  const {query,call,order}=s;
  await s.load('approvals-portal'); // creates customer_approvals, which START_REPAIR reads
  await s.load('workflow');
  try{
    await t.test('ASSIGN требует уже назначенного инженера',async()=>{
      const id=await order('NEW',null,1000,2);
      const res=await call('workflow','POST',`/api/v1/requests/${id}/workflow`,{event:'ASSIGN'},2);
      assert.equal(res.status,422);
      assert.equal(res.error.code,'ENGINEER_REQUIRED');
    });

    const id=await order('NEW',3,1000,2);

    await t.test('Только назначенный инженер и владелец/менеджер видят заявку',async()=>{
      const foreign=await call('workflow','GET',`/api/v1/requests/${id}/workflow`,undefined,4);
      assert.equal(foreign.status,403);
      const asEngineer=await call('workflow','GET',`/api/v1/requests/${id}/workflow`,undefined,3);
      assert.equal(asEngineer.status,200);
      assert.equal(asEngineer.data.status,'NEW');
      assert.equal(asEngineer.data.next,null,'ASSIGN is owner/manager-only, an engineer should not see it as available');
    });

    await t.test('Роль без прав на этап отклоняется, до перехода состояние не меняется',async()=>{
      const res=await call('workflow','POST',`/api/v1/requests/${id}/workflow`,{event:'ASSIGN'},3);
      assert.equal(res.status,403);
      assert.equal(res.error.code,'FORBIDDEN');
    });

    await t.test('NEW -> ASSIGNED -> ACCEPTED -> (виртуальный ON_ROUTE) -> DIAGNOSTICS',async()=>{
      const assign=await call('workflow','POST',`/api/v1/requests/${id}/workflow`,{event:'ASSIGN'},2);
      assert.equal(assign.status,200,JSON.stringify(assign));
      assert.equal(assign.data.status,'ASSIGNED');

      const accept=await call('workflow','POST',`/api/v1/requests/${id}/workflow`,{event:'ACCEPT'},3);
      assert.equal(accept.status,200,JSON.stringify(accept));
      assert.equal(accept.data.status,'ACCEPTED');

      const beforeDepart=await call('workflow','GET',`/api/v1/requests/${id}/workflow`,undefined,3);
      assert.equal(beforeDepart.data.status,'ACCEPTED');

      const depart=await call('workflow','POST',`/api/v1/requests/${id}/workflow`,{event:'DEPART'},3);
      assert.equal(depart.status,200,JSON.stringify(depart));

      const onRoute=await call('workflow','GET',`/api/v1/requests/${id}/workflow`,undefined,3);
      assert.equal(onRoute.data.status,'ON_ROUTE','DEPART without a matching ARRIVE must show as the virtual ON_ROUTE stage');
      assert.equal(onRoute.data.request_status,'ACCEPTED','the underlying DB status stays ACCEPTED while on the road');
      assert.equal(onRoute.data.next.event,'ARRIVE');

      const arrive=await call('workflow','POST',`/api/v1/requests/${id}/workflow`,{event:'ARRIVE'},3);
      assert.equal(arrive.status,200,JSON.stringify(arrive));
      assert.equal(arrive.data.status,'DIAGNOSTICS');
    });

    await t.test('SEND_APPROVAL требует заполненной диагностики',async()=>{
      const blocked=await call('workflow','POST',`/api/v1/requests/${id}/workflow`,{event:'SEND_APPROVAL'},3);
      assert.equal(blocked.status,422);
      assert.equal(blocked.error.code,'DIAGNOSIS_REQUIRED');

      await query("UPDATE requests SET diagnosis='Неисправен блок питания' WHERE id=$1",[id]);
      const sent=await call('workflow','POST',`/api/v1/requests/${id}/workflow`,{event:'SEND_APPROVAL'},3);
      assert.equal(sent.status,200,JSON.stringify(sent));
      assert.equal(sent.data.status,'APPROVAL_REQUIRED');
    });

    await t.test('START_REPAIR требует согласия клиента (customer_approvals)',async()=>{
      const blocked=await call('workflow','POST',`/api/v1/requests/${id}/workflow`,{event:'START_REPAIR'},3);
      assert.equal(blocked.status,409);
      assert.equal(blocked.error.code,'APPROVAL_REQUIRED');

      await query("INSERT INTO customer_approvals(request_id,token,status,total,created_by) VALUES($1,'wf-test-token','APPROVED',1000,1)",[id]);
      const started=await call('workflow','POST',`/api/v1/requests/${id}/workflow`,{event:'START_REPAIR'},3);
      assert.equal(started.status,200,JSON.stringify(started));
      assert.equal(started.data.status,'REPAIR');
    });

    await t.test('Несовпадающее событие отклоняется, а официально верное — тоже, если оно относится к процедуре завершения',async()=>{
      const wrongEvent=await call('workflow','POST',`/api/v1/requests/${id}/workflow`,{event:'CLOSE'},3);
      assert.equal(wrongEvent.status,409);
      assert.equal(wrongEvent.error.code,'INVALID_TRANSITION');

      // START_TEST is the "correct" next step per the flow map, but closing out
      // a repair must go through the dedicated completion module, not this endpoint.
      const mustUseCompletion=await call('workflow','POST',`/api/v1/requests/${id}/workflow`,{event:'START_TEST'},3);
      assert.equal(mustUseCompletion.status,409);
      assert.equal(mustUseCompletion.error.code,'COMPLETION_PROCEDURE_REQUIRED');

      const stillRepair=await call('workflow','GET',`/api/v1/requests/${id}/workflow`,undefined,3);
      assert.equal(stillRepair.data.status,'REPAIR','a blocked transition must not have changed the order status');
    });

    await t.test('Закрытый заказ можно просматривать, но нельзя переводить дальше',async()=>{
      const closedId=await order('CLOSED',3,500,2);
      const view=await call('workflow','GET',`/api/v1/requests/${closedId}/workflow`,undefined,1);
      assert.equal(view.status,200);
      assert.equal(view.data.request_status,'CLOSED');
      const mutate=await call('workflow','POST',`/api/v1/requests/${closedId}/workflow`,{event:'ASSIGN'},1);
      assert.equal(mutate.status,409);
      assert.equal(mutate.error.code,'ORDER_FINISHED');
    });
  }finally{await s.close();}
});
