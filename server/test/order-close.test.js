import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {assertCloseReady,OrderCloseError} from '../src/order-close.js';
import {closeOrder} from '../src/order-close.js';

const ready={status:'PAYMENT_REQUIRED',total:100000,paid:100000,repair_result:'Ремонт выполнен',parts_posted:true,test_result:'Тест пройден',after_photos:1,client_signatures:1};
test('закрытие разрешено только после полного набора подтверждений',()=>assert.doesNotThrow(()=>assertCloseReady(ready)));
test('каждый обязательный этап отдельно блокирует закрытие',()=>{
  const cases=[
    [{status:'TESTING'},'STATE_CONFLICT'],[{paid:99999},'PAYMENT_REQUIRED'],[{paid:100100},'OVERPAYMENT_REQUIRES_REVIEW'],[{repair_result:''},'REPAIR_COMPLETION_REQUIRED'],
    [{parts_posted:false},'REPAIR_COMPLETION_REQUIRED'],[{test_result:''},'TEST_REQUIRED'],[{after_photos:0},'PHOTO_REQUIRED'],[{client_signatures:0},'CLIENT_SIGNATURE_REQUIRED']
  ];
  for(const [change,code] of cases)assert.throws(()=>assertCloseReady({...ready,...change}),error=>error instanceof OrderCloseError&&error.code===code);
});

test('закрытие атомарно выпускает документы и оставляет историю проверок',async()=>{
  const db=await PGlite.create();
  try{
    await db.exec(`
      CREATE TABLE users(id SERIAL PRIMARY KEY,name TEXT);
      INSERT INTO users(name) VALUES('Owner');
      CREATE TABLE requests(id SERIAL PRIMARY KEY,status TEXT,total NUMERIC,paid NUMERIC,deleted_at TIMESTAMPTZ,closed_at TIMESTAMPTZ,warranty_until DATE,updated_at TIMESTAMPTZ DEFAULT now());
      INSERT INTO requests(status,total,paid) VALUES('PAYMENT_REQUIRED',100000,100000);
      CREATE TABLE repair_completions(request_id INT PRIMARY KEY REFERENCES requests(id),repair_result TEXT,test_result TEXT,parts_posted BOOLEAN,warranty_days INT,closed_at TIMESTAMPTZ,updated_at TIMESTAMPTZ DEFAULT now());
      INSERT INTO repair_completions VALUES(1,'Ремонт выполнен','Контроль пройден',true,90,NULL,now());
      CREATE TABLE request_files(id SERIAL PRIMARY KEY,request_id INT REFERENCES requests(id),kind TEXT);
      INSERT INTO request_files(request_id,kind) VALUES(1,'PHOTO_AFTER');
      CREATE TABLE request_signatures(id SERIAL PRIMARY KEY,request_id INT REFERENCES requests(id),signer_type TEXT);
      INSERT INTO request_signatures(request_id,signer_type) VALUES(1,'CLIENT');
      CREATE TABLE generated_documents(id SERIAL PRIMARY KEY,request_id INT REFERENCES requests(id),document_type TEXT,document_number TEXT,created_by INT REFERENCES users(id));
      CREATE TABLE request_history(id SERIAL PRIMARY KEY,request_id INT REFERENCES requests(id),user_id INT REFERENCES users(id),action TEXT,details JSONB);
      CREATE FUNCTION request_close_guard() RETURNS trigger AS $$ BEGIN
        IF NEW.status='CLOSED' AND OLD.status IS DISTINCT FROM 'CLOSED' AND COALESCE(current_setting('app.completion_close_request',true),'')<>NEW.id::text THEN
          RAISE EXCEPTION 'Закройте заказ через процедуру завершения ремонта';
        END IF; RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER request_close_guard BEFORE UPDATE OF status ON requests FOR EACH ROW EXECUTE FUNCTION request_close_guard();
    `);
    await assert.rejects(db.exec("UPDATE requests SET status='CLOSED' WHERE id=1"),/процедуру завершения ремонта/i);
    await db.exec('BEGIN');
    const result=await closeOrder(db,{requestId:1,userId:1});
    await db.exec('COMMIT');
    assert.equal(result.status,'CLOSED');assert.equal(result.documents.length,2);
    const request=(await db.query('SELECT status,closed_at,warranty_until FROM requests WHERE id=1')).rows[0];
    assert.equal(request.status,'CLOSED');assert.ok(request.closed_at);assert.ok(request.warranty_until);
    assert.equal((await db.query('SELECT count(*) n FROM generated_documents WHERE request_id=1')).rows[0].n,2);
    const history=(await db.query("SELECT details FROM request_history WHERE action='REQUEST_CLOSED'")).rows[0];
    assert.equal(history.details.checks.after_photos,1);assert.equal(history.details.checks.client_signature,true);
  }finally{await db.close();}
});
