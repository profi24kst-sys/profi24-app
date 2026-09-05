import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrateFinance } from '../src/finance/migrate.js';
import { buildFinanceApp } from '../src/finance/app.js';
import { money,today } from '../src/finance/service.js';

const fixture=`
CREATE TABLE users(id SERIAL PRIMARY KEY,name TEXT,email TEXT,password_hash TEXT,role TEXT,active BOOLEAN DEFAULT true);
INSERT INTO users(name,role) VALUES ('Owner','OWNER'),('Sergey','ENGINEER'),('Manager','MANAGER'),('Other engineer','ENGINEER');
CREATE TABLE requests(id SERIAL PRIMARY KEY,number TEXT,engineer_id INT REFERENCES users(id),manager_id INT REFERENCES users(id),deleted_at TIMESTAMPTZ,status TEXT DEFAULT 'REPAIR',total NUMERIC DEFAULT 100000,paid NUMERIC DEFAULT 0,direct_cost NUMERIC DEFAULT 0,discount_amount NUMERIC DEFAULT 0,closed_at TIMESTAMPTZ,updated_at TIMESTAMPTZ DEFAULT now());
INSERT INTO requests(number,engineer_id,manager_id) VALUES ('TEST-1',2,3),('TEST-2',4,3);
CREATE TABLE request_history(id SERIAL PRIMARY KEY,request_id INT REFERENCES requests(id),user_id INT REFERENCES users(id),action TEXT,details JSONB,created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE payments(id SERIAL PRIMARY KEY,request_id INT REFERENCES requests(id),amount NUMERIC(14,2) CHECK(amount>0),method TEXT,kind TEXT,reference TEXT,created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE parts(id SERIAL PRIMARY KEY,request_id INT REFERENCES requests(id),name TEXT,qty NUMERIC(10,2),purchase_price NUMERIC(14,2),sale_price NUMERIC(14,2),supplier TEXT,status TEXT,created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE request_works(id SERIAL PRIMARY KEY,request_id INT REFERENCES requests(id),qty NUMERIC,unit_price NUMERIC,direct_cost NUMERIC);
CREATE TABLE payroll_rules(user_id INT,active BOOLEAN DEFAULT true,base_salary NUMERIC,order_percent NUMERIC,work_percent NUMERIC,gross_profit_percent NUMERIC);
CREATE TABLE payroll_adjustments(period_month DATE,amount NUMERIC);
`;
async function setup(legacy=''){
  const db=await PGlite.create();await db.exec(fixture+legacy);
  const query=async(sql,params=[])=>params.length?db.query(sql,params):(await db.exec(sql)).at(-1);
  let queue=Promise.resolve();
  const pool={query,connect:async()=>{const prior=queue;let release;queue=new Promise(r=>{release=r});await prior;return {query,release};}};
  await migrateFinance(pool);const app=await buildFinanceApp(pool,{logger:false,secret:'isolated-finance-test-secret'});
  let seq=0;
  const api=async(method,url,body,user=1,key)=>{
    const res=await app.inject({method,url,headers:{authorization:'Bearer '+app.jwt.sign({id:user,role:user===1?'OWNER':'ENGINEER'}),'idempotency-key':key||'test-operation-'+String(++seq).padStart(8,'0')},payload:body});
    return {status:res.statusCode,...res.json()};
  };
  const create=async(name,type='CASH',amount=0,responsible_id=null)=>{const r=await api('POST','/api/v1/accounts',{name,type,initial_amount:amount,initial_reason:'Документ открытия счёта',responsible_id});assert.equal(r.status,201,JSON.stringify(r));return r.data.id;};
  const balance=async account=>Number((await query('SELECT balance FROM finance_account_balances WHERE id=$1',[account])).rows[0].balance);
  return {db,pool,app,api,create,balance,query,close:async()=>{await app.close();await db.close();}};
}

test('Сведения о покупке в заказе: источник, документ, автор и права доступа',async()=>{
  const s=await setup();try{
    const cash=await s.create('Касса офиса','CASH',10000),card=await s.create('Карта инженера','CARD',10000,2);
    const body={account_id:card,name:'Насос',qty:2,purchase_price:1500,sale_price:2000,document_reference:'Чек 123'};
    const first=await s.api('POST','/api/v1/requests/1/part-purchases',body,2,'purchase-details-key-001');
    assert.equal(first.status,201);
    assert.equal((await s.api('POST','/api/v1/requests/1/part-purchases',body,2,'purchase-details-key-001')).data.id,first.data.id);
    await s.api('POST','/api/v1/requests/1/part-purchases',{...body,account_id:cash,name:'Фильтр'});
    const owner=await s.api('GET','/api/v1/requests/1/part-purchases');
    assert.equal(owner.status,200);assert.equal(owner.data.length,2);
    const own=await s.api('GET','/api/v1/requests/1/part-purchases',undefined,2);
    assert.equal(own.data.length,1);assert.equal(own.data[0].part_id,first.data.id);
    assert.equal(own.data[0].account_name,'Карта инженера');assert.equal(own.data[0].document_reference,'Чек 123');
    assert.ok(own.data[0].created_by_name);assert.equal(Number(own.data[0].amount),3000);
    assert.equal(await s.balance(card),7000);
    assert.equal((await s.api('GET','/api/v1/requests/2/part-purchases',undefined,2)).status,403);
  }finally{await s.close();}
});

test('Точный денежный ввод: не принимаем NaN, Infinity, третью цифру и отрицательный расход',()=>{
  assert.equal(money('2250.10'),'2250.10');assert.equal(money('-12.01',{signed:true}),'-12.01');
  for(const value of ['NaN','Infinity',NaN,Infinity,'1.001','-1',0,'1e3',null])assert.throws(()=>money(value));
});

test('Аудит счетов, пример 319250, роли, переводы, сторно, покупки и оплаты',async()=>{
  const s=await setup();try{
    const cash=await s.create('Касса','CASH',300000),advance=await s.create('Подотчёт Сергея','ADVANCE',0,2);
    assert.equal((await s.api('POST','/api/v1/transactions',{account_id:cash,type:'INCOME',category:'OTHER_INCOME',amount:120000,comment:'Получены наличные'})).status,201);
    assert.equal((await s.api('POST','/api/v1/requests/1/part-purchases',{account_id:cash,name:'Компрессор',qty:1,purchase_price:48500,sale_price:70000,document_reference:'Чек 001'})).status,201);
    assert.equal((await s.api('POST','/api/v1/requests/1/expenses',{account_id:cash,category:'TAXI',amount:2250,comment:'Такси инженеру'})).status,201);
    const beforePnl=(await s.api('GET','/api/v1/pnl')).data;
    const transfer=await s.api('POST','/api/v1/transfers',{from_account_id:cash,to_account_id:advance,amount:50000,comment:'Выдача Сергею под отчёт'});
    assert.equal(transfer.status,201,JSON.stringify(transfer));assert.equal(await s.balance(cash),319250);assert.equal(await s.balance(advance),50000);
    assert.deepEqual((await s.api('GET','/api/v1/pnl')).data,beforePnl,'Перевод не меняет P&L');
    const log=(await s.api('GET',`/api/v1/transactions?account_id=${cash}`)).data;
    assert.equal(log.rows.length,5);assert.equal(Number(log.rows[0].balance_after),319250);
    assert.equal(Number(log.summary.closing),319250);
    assert.equal((await s.api('PATCH',`/api/v1/accounts/${cash}`,{opening_balance:700000})).status,422);
    assert.equal((await s.api('PATCH',`/api/v1/accounts/${cash}`,{name:'Касса офиса'})).status,200);
    assert.equal(await s.balance(cash),319250);
    assert.equal((await s.api('PATCH',`/api/v1/accounts/${cash}`,{is_active:false})).status,422);
    await assert.rejects(s.query('UPDATE finance_accounts SET opening_balance=700000 WHERE id=$1',[cash]));
    await assert.rejects(s.query('DELETE FROM finance_transactions WHERE id=$1',[transfer.data.id]));
    await assert.rejects(s.query("UPDATE finance_audit_log SET actor_name='Hidden'"));
    assert.equal((await s.api('DELETE',`/api/v1/transactions/${transfer.data.id}`)).status,409);

    const own=(await s.api('GET','/api/v1/accounts',undefined,2)).data;
    assert.deepEqual(own.map(x=>x.id),[advance]);
    assert.equal((await s.api('POST','/api/v1/accounts',{name:'Forbidden',type:'CASH'},2)).status,403);
    assert.equal((await s.api('POST','/api/v1/transfers',{from_account_id:advance,to_account_id:cash,amount:1,comment:'Запрещено'},2)).status,403);
    assert.equal((await s.api('GET','/api/v1/audit',undefined,2)).status,403);
    assert.equal((await s.api('GET',`/api/v1/transactions?account_id=${cash}`,undefined,2)).status,403);
    assert.equal((await s.api('POST','/api/v1/requests/1/expenses',{category:'TAXI',amount:10,comment:'Нет источника'},2)).status,422);
    assert.equal((await s.api('POST','/api/v1/requests/1/expenses',{account_id:cash,category:'TAXI',amount:10,comment:'Чужой источник'},2)).status,403);
    assert.equal((await s.api('POST','/api/v1/requests/2/expenses',{account_id:advance,category:'TAXI',amount:10,comment:'Чужой заказ'},2)).status,403);
    const spent=await s.api('POST','/api/v1/requests/1/expenses',{account_id:advance,category:'TAXI',amount:'10.15',comment:'Свой подотчёт'},2);
    assert.equal(spent.status,201);assert.equal(await s.balance(advance),49989.85);
    const reversed=await s.api('POST',`/api/v1/transactions/${spent.data.id}/reverse`,{reason:'Ошибочный расход, чек отменён'});
    assert.equal(reversed.status,201);assert.equal(await s.balance(advance),50000);
    assert.equal((await s.api('POST',`/api/v1/transactions/${spent.data.id}/reverse`,{reason:'Повторное сторно'})).status,409);

    const cancelled=await s.api('POST',`/api/v1/transactions/${transfer.data.id}/reverse`,{reason:'Отмена ошибочной выдачи'});
    assert.equal(cancelled.status,201,JSON.stringify(cancelled));assert.equal(await s.balance(cash),369250);assert.equal(await s.balance(advance),0);
    assert.equal((await s.query('SELECT count(*) n FROM finance_transactions WHERE transfer_group_id=$1',[cancelled.data.transfer_group_id])).rows[0].n,2);
    assert.deepEqual((await s.api('GET','/api/v1/pnl')).data,beforePnl);

    const body={account_id:advance,category:'TAXI',amount:1000,comment:'Повтор запроса при сбое сети'};
    const adjusted=await s.api('POST',`/api/v1/accounts/${advance}/adjustments`,{delta:2000,reason:'Акт сверки начального остатка',document_reference:'Акт 17'});
    assert.equal(adjusted.status,201);
    const first=await s.api('POST','/api/v1/requests/1/expenses',body,2,'same-request-00000001');
    const duplicate=await s.api('POST','/api/v1/requests/1/expenses',body,2,'same-request-00000001');
    assert.equal(first.status,201);assert.equal(first.data.id,duplicate.data.id);assert.equal(await s.balance(advance),1000);
    assert.equal((await s.api('POST','/api/v1/requests/1/expenses',{...body,amount:2000},2,'same-request-00000001')).status,409);
    const partCount=(await s.query('SELECT count(*) n FROM parts')).rows[0].n;
    assert.equal((await s.api('POST','/api/v1/requests/1/part-purchases',{account_id:advance,name:'Дорогой модуль',qty:1,purchase_price:5000,document_reference:'Чек 002'},2)).status,409);
    assert.equal((await s.query('SELECT count(*) n FROM parts')).rows[0].n,partCount,'Покупка откатывается целиком');

    const card=await s.create('Карта менеджера','CARD',0,3);
    await assert.rejects(s.query("INSERT INTO payments(request_id,amount,method,kind,created_by) VALUES(1,5000,'CARD','PAYMENT',3)"));
    const p=(await s.query("INSERT INTO payments(request_id,amount,method,kind,created_by,account_id) VALUES(1,5000,'CARD','PAYMENT',3,$1) RETURNING id",[card])).rows[0];
    assert.equal(await s.balance(card),5000);
    assert.equal((await s.api('POST','/api/v1/transfers',{from_account_id:card,to_account_id:cash,amount:3000,comment:'Перевод клиентской оплаты'})).status,201);
    await s.query("INSERT INTO payments(request_id,amount,method,kind,created_by,reference) VALUES(1,1000,'CARD','REFUND',3,$1)",['refund:'+p.id]);
    assert.equal(await s.balance(card),1000);
    assert.equal((await s.api('POST','/api/v1/transfers',{from_account_id:card,to_account_id:cash,amount:2000,comment:'Больше остатка после возврата'})).status,409);
    await s.query('UPDATE requests SET deleted_at=now() WHERE id=1');
    assert.equal(await s.balance(card),1000,'Удаление заказа не меняет остатки');
    const count=(await s.query('SELECT count(*) n FROM finance_transactions')).rows[0].n;
    await migrateFinance(s.pool);assert.equal((await s.query('SELECT count(*) n FROM finance_transactions')).rows[0].n,count);
  }finally{await s.close();}
});

test('Миграция прежней версии сохраняет начальные остатки, старые операции и возвраты',async()=>{
  const legacy=`CREATE TABLE finance_accounts(id SERIAL PRIMARY KEY,name TEXT,type TEXT,currency TEXT DEFAULT 'KZT',opening_balance NUMERIC DEFAULT 0,is_active BOOLEAN DEFAULT true,created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now());
  INSERT INTO finance_accounts(name,type,opening_balance) VALUES ('Kaspi','KASPI',300000);
  INSERT INTO payments(request_id,amount,method,kind,created_by) VALUES(1,120000,'KASPI','PAYMENT',1),(1,20000,'KASPI','REFUND',1);
  CREATE TABLE finance_transactions(id SERIAL PRIMARY KEY,occurred_at DATE DEFAULT CURRENT_DATE,type TEXT,category TEXT,amount NUMERIC,payment_method TEXT,request_id INT REFERENCES requests(id),counterparty TEXT,comment TEXT,created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now());
  INSERT INTO finance_transactions(type,category,amount,payment_method,request_id,created_by) VALUES('EXPENSE','TAXI',2250,'KASPI',1,2);`;
  const s=await setup(legacy);try{
    assert.equal(await s.balance(1),397750);assert.equal((await s.api('GET','/api/v1/accounts')).data[0].type,'BANK');
    const count=(await s.query('SELECT count(*) n FROM finance_audit_log')).rows[0].n;assert.equal(count,4);
    await migrateFinance(s.pool);assert.equal(await s.balance(1),397750);
    assert.equal((await s.query('SELECT count(*) n FROM finance_audit_log')).rows[0].n,count);
  }finally{await s.close();}
});
