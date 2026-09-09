import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chooseSupplierOffer} from '../src/smart-supplier-selection.js';

const offer=(supplier_id,supplier_name,unit_cost,lead_time_days,currency='KZT')=>({item_id:1,supplier_id,supplier_name,unit_cost,lead_time_days,supplier_available_qty:50,currency,source:'CATALOG',auto_eligible:currency==='KZT',auto_exclusion_reason:currency==='KZT'?null:'FOREIGN_CURRENCY'});
const profile=(supplier_id,score,confidence='HIGH',recommendation_code='MONITOR')=>({supplier_id,score,rating:score>=85?'A':score>=70?'B':score>=55?'C':'D',confidence,recommendation_code,on_time_rate:score,overdue_open_orders:recommendation_code==='DELIVERY_RISK'?2:0});

test('умный выбор меняет веса для критичного ремонта и обычного пополнения',()=>{
  const cheap=offer(1,'Дешёвый поставщик',10000,10),fast=offer(2,'Быстрый поставщик',12000,2);
  const criticalProfiles=new Map([[1,profile(1,55,'MEDIUM','DELIVERY_RISK')],[2,profile(2,90,'HIGH','PREFERRED')]]);
  let decision=chooseSupplierOffer({row:{priority:'CRITICAL',recommended_quantity:2},offers:[cheap,fast],profiles:criticalProfiles});
  assert.equal(decision.selected.supplier_id,2);
  assert.equal(decision.selected.selection_strategy,'SERVICE_CRITICAL');
  assert.equal(decision.selected.cheapest_supplier_id,1);
  assert.equal(Number(decision.selected.price_premium_pct),20);
  assert.match(decision.selected.selection_reason,/критичный ремонт/i);
  assert.ok(decision.selected.selection_score>decision.alternatives.find(x=>x.supplier_id===1).selection_score);

  const routineProfiles=new Map([[1,profile(1,70,'MEDIUM','MONITOR')],[2,profile(2,90,'HIGH','PREFERRED')]]);
  decision=chooseSupplierOffer({row:{priority:'HIGH',recommended_quantity:2},offers:[cheap,fast],profiles:routineProfiles});
  assert.equal(decision.selected.supplier_id,1,'при обычном пополнении цена должна оставаться главным фактором');
  assert.equal(decision.selected.selection_strategy,'STOCK_REPLENISHMENT');
  assert.equal(Number(decision.selected.price_premium_pct),0);
});

test('иностранная валюта не участвует в автоматическом сравнении с KZT',()=>{
  const usd=offer(3,'USD Supplier',500,1,'USD'),kzt=offer(4,'KZT Supplier',250000,5,'KZT');
  let decision=chooseSupplierOffer({row:{priority:'CRITICAL',recommended_quantity:1},offers:[usd,kzt],profiles:new Map()});
  assert.equal(decision.selected.supplier_id,4);
  assert.equal(decision.selected.currency,'KZT');
  decision=chooseSupplierOffer({row:{priority:'HIGH',recommended_quantity:1},offers:[usd],profiles:new Map()});
  assert.equal(decision.selected,null);
  assert.equal(decision.alternatives[0].auto_exclusion_reason,'FOREIGN_CURRENCY');
});
