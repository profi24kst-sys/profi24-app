import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrateFinance } from '../src/finance/migrate.js';
import { buildFinanceApp } from '../src/finance/app.js';
import { fingerprint,money,today } from '../src/finance/service.js';
import {cancelOrder,cancellationReadiness,refundPayment} from '../src/order-financial-actions.js';

const fixture=`
CREATE TABLE users(id SERIAL PRIMARY KEY,name TEXT,email TEXT,password_hash TEXT,role TEXT,active BOOLEAN DEFAULT true);
INSERT INTO users(name,role) VALUES ('Owner','OWNER'),('Sergey','ENGINEER'),('Manager','MANAGER'),('Other engineer','ENGINEER');
CREATE TABLE requests(id SERIAL PRIMARY KEY,number TEXT,engineer_id INT REFERENCES users(id),manager_id INT REFERENCES users(id),deleted_at TIMESTAMPTZ,status TEXT DEFAULT 'REPAIR',total NUMERIC DEFAULT 100000,paid NUMERIC DEFAULT 0,direct_cost NUMERIC DEFAULT 0,discount_amount NUMERIC DEFAULT 0,closed_at TIMESTAMPTZ,cancelled_at TIMESTAMPTZ,updated_at TIMESTAMPTZ DEFAULT now());
INSERT INTO requests(number,engineer_id,manager_id) VALUES ('TEST-1',2,3),('TEST-2',4,3);
CREATE TABLE request_history(id SERIAL PRIMARY KEY,request_id INT REFERENCES requests(id),user_id INT REFERENCES users(id),action TEXT,details JSONB,created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE payments(id SERIAL PRIMARY KEY,request_id INT REFERENCES requests(id),amount NUMERIC(14,2) CHECK(amount>0),method TEXT,kind TEXT,reference TEXT,created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE parts(id SERIAL PRIMARY KEY,request_id INT REFERENCES requests(id),name TEXT,qty NUMERIC(10,2),purchase_price NUMERIC(14,2),sale_price NUMERIC(14,2),supplier TEXT,status TEXT,created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE request_works(id SERIAL PRIMARY KEY,request_id INT REFERENCES requests(id),qty NUMERIC,unit_price NUMERIC,direct_cost NUMERIC,performed_by INT REFERENCES users(id));
CREATE TABLE payroll_rules(user_id INT,active BOOLEAN DEFAULT true,base_salary NUMERIC,order_percent NUMERIC,work_percent NUMERIC,gross_profit_percent NUMERIC);
CREATE TABLE payroll_adjustments(user_id INT REFERENCES users(id),period_month DATE,amount NUMERIC);
CREATE TABLE tasks(id SERIAL PRIMARY KEY,title TEXT,request_id INT REFERENCES requests(id),assigned_to INT REFERENCES users(id),status TEXT DEFAULT 'OPEN');
CREATE TABLE stock_reservations(id SERIAL PRIMARY KEY,request_id INT REFERENCES requests(id),status TEXT DEFAULT 'ACTIVE',released_at TIMESTAMPTZ);
CREATE TABLE dispatch_controls(request_id INT PRIMARY KEY REFERENCES requests(id),status TEXT DEFAULT 'OPEN',resolution TEXT,resolved_at TIMESTAMPTZ,updated_by INT REFERENCES users(id),updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE owner_order_corrections(request_id INT PRIMARY KEY REFERENCES requests(id),active BOOLEAN DEFAULT true,closed_by INT REFERENCES users(id),closed_at TIMESTAMPTZ,close_reason TEXT);
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
async function runTx(pool,fn){const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result}catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}}

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

test('Документированный возврат покупки восстанавливает счёт и сохраняет аудит',async()=>{
  const s=await setup();try{
    const card=await s.create('Карта инженера','CARD',10000,2);
    const purchase=await s.api('POST','/api/v1/requests/1/part-purchases',{account_id:card,name:'Насос',qty:2,purchase_price:1500,sale_price:2000,document_reference:'Чек 123'},2);
    assert.equal(purchase.status,201);assert.equal(await s.balance(card),7000);
    await assert.rejects(s.query("UPDATE parts SET status='CANCELLED' WHERE id=$1",[purchase.data.id]),/документированным возвратом/i);
    const body={reason:'Поставщик принял неподошедшую деталь',document_reference:'Накладная возврата 17'};
    assert.equal((await s.api('POST',`/api/v1/requests/1/part-purchases/${purchase.data.id}/return`,body,2)).status,403);
    const returned=await s.api('POST',`/api/v1/requests/1/part-purchases/${purchase.data.id}/return`,body,1,'part-return-key-0001');
    assert.equal(returned.status,201,JSON.stringify(returned));assert.equal(returned.data.kind,'PART_RETURN');assert.equal(await s.balance(card),10000);
    const part=(await s.query('SELECT * FROM parts WHERE id=$1',[purchase.data.id])).rows[0];
    assert.equal(part.status,'CANCELLED');assert.equal(part.return_reason,body.reason);assert.equal(part.return_document_reference,body.document_reference);assert.equal(part.returned_by,1);
    const request=(await s.query('SELECT total,direct_cost FROM requests WHERE id=1')).rows[0];
    assert.equal(Number(request.total),0);assert.equal(Number(request.direct_cost),0);
    const movements=(await s.query("SELECT id,kind,type,reversal_of FROM finance_transactions WHERE part_id=$1 ORDER BY id",[purchase.data.id])).rows;
    assert.deepEqual(movements.map(x=>x.kind),['PART_PURCHASE','PART_RETURN']);assert.equal(movements[1].type,'INCOME');assert.equal(movements[1].reversal_of,movements[0].id);
    const details=(await s.api('GET','/api/v1/requests/1/part-purchases')).data[0];
    assert.equal(details.return_transaction_id,returned.data.id);assert.equal(details.return_reason,body.reason);assert.equal(details.return_document_reference,body.document_reference);
    const replay=await s.api('POST',`/api/v1/requests/1/part-purchases/${purchase.data.id}/return`,body,1,'part-return-key-0001');
    assert.equal(replay.data.id,returned.data.id);assert.equal(await s.balance(card),10000);
  }finally{await s.close();}
});

test('Статус CLOSED защищён на уровне базы данных',async()=>{
  const s=await setup();try{
    await s.query("UPDATE requests SET status='CLOSED',closed_at=now() WHERE id=1");
    await assert.rejects(s.query("UPDATE requests SET total=1 WHERE id=1"),/закрытый|отменённый/i);
    await assert.rejects(s.query("INSERT INTO parts(request_id,name,qty,status,created_by) VALUES(1,'После закрытия',1,'REQUESTED',1)"),/закрыт|отменён/i);
    const before=(await s.query('SELECT total,direct_cost FROM requests WHERE id=1')).rows[0];
    assert.equal((await s.api('POST','/api/v1/requests/1/part-purchases',{account_id:999,name:'После закрытия',qty:1,purchase_price:1,sale_price:1,document_reference:'Нет'})).status,409);
    const after=(await s.query('SELECT total,direct_cost FROM requests WHERE id=1')).rows[0];assert.deepEqual(after,before);
  }finally{await s.close();}
});

test('Возврат оплаты связан с исходным платежом, требует документ и открывает закрытый заказ',async()=>{
  const s=await setup();try{
    const cash=await s.create('Касса','CASH',0);
    const payment=await s.api('POST','/api/v1/requests/1/payment',{amount:10000,method:'CASH',account_id:cash,reference:'Чек продажи 1'},1,'payment-original-0001');
    assert.equal(payment.status,201,JSON.stringify(payment));assert.equal(await s.balance(cash),10000);
    await s.query("UPDATE requests SET status='CLOSED',closed_at=now() WHERE id=1");
    const bad=await s.api('POST','/api/v1/requests/1/refund',{payment_id:payment.data.id,amount:1000,reason:'Возврат',document_reference:'Чек возврата 1'},1,'refund-payment-0001');
    assert.equal(bad.status,201,JSON.stringify(bad));assert.equal(await s.balance(cash),9000);
    const request=(await s.query('SELECT status,closed_at,paid FROM requests WHERE id=1')).rows[0];assert.equal(request.status,'PAYMENT_REQUIRED');assert.equal(request.closed_at,null);assert.equal(Number(request.paid),9000);
  }finally{await s.close();}
});

test('Безопасная отмена блокируется деньгами и покупками, но сохраняет признанные расходы',async()=>{
  const s=await setup();try{
    const cash=await s.create('Касса','CASH',100000);
    await s.api('POST','/api/v1/requests/1/expenses',{account_id:cash,category:'TAXI',amount:2250,comment:'Такси инженеру'});
    const payment=await s.api('POST','/api/v1/requests/1/payment',{amount:10000,method:'CASH',account_id:cash,reference:'Чек оплаты 1'},1,'cancel-payment-0001');
    assert.equal((await cancellationReadiness(s.pool,1)).ready,false);
    await refundPayment(s.pool,{id:1,role:'OWNER'},1,{payment_id:payment.data.id,amount:10000,reason:'Отмена заказа',document_reference:'Чек возврата 2',idempotency_key:'cancel-refund-0001'});
    assert.equal((await cancellationReadiness(s.pool,1)).ready,true);
    const result=await cancelOrder(s.pool,{id:1,role:'OWNER'},1,{category:'CUSTOMER_REFUSAL',reason:'Клиент отказался после выезда',document_reference:'Акт отмены 1',expenses_acknowledged:true,idempotency_key:'cancel-order-doc-001'});
    assert.equal(result.request.status,'CANCELLED');assert.equal(Number(result.document.expense_amount),2250);
  }finally{await s.close();}
});

test('Точный денежный ввод: не принимаем NaN, Infinity, третью цифру и отрицательный расход',()=>{
  assert.throws(()=>money('NaN'));assert.throws(()=>money('Infinity'));assert.throws(()=>money('1.001'));assert.throws(()=>money('-1'));assert.equal(money('-1',{signed:true}),'-1.00');assert.equal(money('0',{zero:true}),'0.00');assert.equal(today().length,10);
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

    const engineerAccounts=await s.api('GET','/api/v1/accounts',undefined,2);
    assert.equal(engineerAccounts.status,403,'Инженер не получает глобальный список денежных счетов');
    assert.equal((await s.api('POST','/api/v1/accounts',{name:'Forbidden',type:'CASH'},2)).status,403);
    assert.equal((await s.api('POST','/api/v1/transfers',{from_account_id:advance,to_account_id:cash,amount:1,comment:'Запрещено'},2)).status,403);
    assert.equal((await s.api('GET','/api/v1/audit',undefined,2)).status,403);
    assert.equal((await s.api('GET',`/api/v1/transactions?account_id=${cash}`,undefined,2)).status,403);
    assert.equal((await s.api('POST','/api/v1/requests/1/expenses',{category:'TAXI',amount:10,comment:'Нет источника'},2)).status,422);
    assert.equal((await s.api('POST','/api/v1/requests/1/expenses',{account_id:cash,category:'TAXI',amount:10,comment:'Чужой источник'},2)).status,403);
    assert.equal((await s.api('POST','/api/v1/requests/2/expenses',{account_id:advance,category:'TAXI',amount:10,comment:'Чужой заказ'},2)).status,403);
    const spent=await s.api('POST','/api/v1/requests/1/expenses',{account_id:advance,category:'TAXI',amount:'10.15',comment:'Свой подотчёт'},2);
    assert.equal(spent.status,201);assert.equal(await s.balance(advance),49989.85);
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
