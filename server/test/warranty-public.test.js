import test from 'node:test';
import assert from 'node:assert/strict';
import {publicWarrantyPayload} from '../src/warranty-public.js';

test('public warranty payload excludes internal cost and audit fields',()=>{
 const card={
  id:91,request_id:777,token:'secret-token',content_hash:'internal-hash',warranty_days:90,issued_at:'2026-09-01T00:00:00Z',warranty_until:'2026-12-01',
  snapshot:{
   request:{id:777,number:'W-777',customer_name:'Клиент',phone:'+77000000000',address:'Внутренний адрес',category:'Холодильник',brand:'LG',model:'GC',serial_number:'SN1',engineer_id:55,total:45000,paid:45000,closed_at:'2026-09-01T00:00:00Z',warranty_until:'2026-12-01'},
   works:[{id:1,name:'Замена компрессора',qty:1,unit_price:20000,direct_cost:7000,performed_by:55}],
   parts:[{id:2,name:'Компрессор',qty:1,sale_price:25000,purchase_price:12000,status:'INSTALLED'}]
  }
 };
 const current={number:'W-777',customer_name:'Клиент',phone:'+77000000000',category:'Холодильник',brand:'LG',model:'GC',serial_number:'SN1',engineer_name:'Сергей',total:45000,paid:45000,closed_at:'2026-09-01T00:00:00Z',warranty_until:'2026-12-01'};
 const data=publicWarrantyPayload(card,current);
 assert.equal(data.engineer_name,'Сергей');
 assert.deepEqual(data.works,[{name:'Замена компрессора',qty:1,unit_price:20000}]);
 assert.deepEqual(data.parts,[{name:'Компрессор',qty:1,sale_price:25000}]);
 for(const key of ['snapshot','content_hash','request_id','token','id','address','engineer_id'])assert.equal(key in data,false,key);
 assert.equal('direct_cost' in data.works[0],false);
 assert.equal('performed_by' in data.works[0],false);
 assert.equal('purchase_price' in data.parts[0],false);
 assert.equal('status' in data.parts[0],false);
});

test('legacy warranty without snapshot is redacted through the same contract',()=>{
 const card={request_id:8,token:'legacy',content_hash:null,warranty_days:30,warranty_until:'2026-10-01'};
 const current={number:'LEG-8',customer_name:'Клиент',phone:'777',category:'ТВ',engineer_name:'Егор',total:12000,paid:12000};
 const data=publicWarrantyPayload(card,current,{
  works:[{id:3,name:'Ремонт платы',qty:1,unit_price:9000,direct_cost:3000}],
  parts:[{id:4,name:'Микросхема',qty:1,sale_price:3000,purchase_price:900}]
 });
 assert.deepEqual(data.works,[{name:'Ремонт платы',qty:1,unit_price:9000}]);
 assert.deepEqual(data.parts,[{name:'Микросхема',qty:1,sale_price:3000}]);
 assert.equal('direct_cost' in data.works[0],false);
 assert.equal('purchase_price' in data.parts[0],false);
 assert.equal('token' in data,false);
});
