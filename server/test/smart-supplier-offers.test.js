import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readSupplierOffers} from '../src/smart-supplier-selection.js';

test('актуальный прайс поставщика не перезаписывается старой ценой карточки склада',async()=>{
  let call=0;
  const db={query:async sql=>{
    call++;
    if(String(sql).includes('supplier_catalog_links'))return{rows:[{item_id:7,supplier_id:11,supplier_name:'Live Supplier',unit_cost:1200,supplier_available_qty:5,lead_time_days:2,currency:'KZT'}]};
    return{rows:[{item_id:7,supplier_id:11,supplier_name:'Live Supplier',unit_cost:800}]};
  }};
  const offers=await readSupplierOffers(db,[7]),rows=offers.get(7);
  assert.equal(call,2);
  assert.equal(rows.length,1);
  assert.equal(rows[0].source,'CATALOG');
  assert.equal(Number(rows[0].unit_cost),1200);
  assert.equal(Number(rows[0].lead_time_days),2);
});

test('карточка склада остаётся fallback, когда связанного прайса вообще нет',async()=>{
  const db={query:async sql=>String(sql).includes('supplier_catalog_links')?{rows:[]}:{rows:[{item_id:8,supplier_id:12,supplier_name:'Fallback Supplier',unit_cost:900}]}};
  const rows=(await readSupplierOffers(db,[8])).get(8);
  assert.equal(rows.length,1);
  assert.equal(rows[0].source,'WAREHOUSE_CARD');
  assert.equal(Number(rows[0].unit_cost),900);
});
