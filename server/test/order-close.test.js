import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {assertCloseReady,OrderCloseError} from '../src/order-close.js';
import {closeOrder} from '../src/order-close.js';
import {installDocumentVersionSchema} from '../src/document-version-schema.js';

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
      CREATE TABLE customers(id SERIAL PRIMARY KEY,name TEXT,phone TEXT,address TEXT);
      INSERT INTO customers(name,phone) VALUES('Client','7700');
      CREATE TABLE equipment(id SERIAL PRIMARY KEY,category TEXT,brand TEXT,model TEXT,serial_number TEXT);
      INSERT INTO equipment(category,brand) VALUES('Washer','LG');
      CREATE TABLE requests(id SERIAL PRIMARY KEY,number TEXT,customer_id INT REFERENCES customers(id),equipment_id INT REFERENCES equipment(id),engineer_id INT REFERENCES users(id),complaint TEXT,status TEXT,total NUMERIC,paid NUMERIC,deleted_at TIMESTAMPTZ,closed_at TIMESTAMPTZ,warranty_until DATE,updated_at TIMESTAMPTZ DEFAULT now());
      INSERT INTO requests(number,customer_id,equipment_id,engineer_id,complaint,status,total,paid) VALUES('CLOSE-1',1,1,1,'No spin','PAYMENT_REQUIRED',100000,100000);
      CREATE TABLE repair_completions(request_id INT PRIMARY KEY REFERENCES requests(id),repair_result TEXT,test_result TEXT,parts_posted BOOLEAN,warranty_days INT,closed_at TIMESTAMPTZ,updated_at TIMESTAMPTZ DEFAULT now());
      INSERT INTO repair_completions VALUES(1,'Ремонт выполнен','Контроль пройден',true,90,NULL,now());
      CREATE TABLE request_files(id SERIAL PRIMARY KEY,request_id INT REFERENCES requests(id),kind TEXT);
      INSERT INTO request_files(request_id,kind) VALUES(1,'PHOTO_AFTER');
      CREATE TABLE request_signatures(id SERIAL PRIMARY KEY,request_id INT REFERENCES requests(id),signer_type TEXT,signer_name TEXT,signature_data TEXT,created_at TIMESTAMPTZ DEFAULT now());
      INSERT INTO request_signatures(request_id,signer_type,signature_data) VALUES(1,'CLIENT','data:image/png;base64,x');
      CREATE TABLE request_works(id SERIAL PRIMARY KEY,request_id INT REFERENCES requests(id),name TEXT,qty NUMERIC,unit_price NUMERIC,direct_cost NUMERIC,performed_by INT);
      CREATE TABLE parts(id SERIAL PRIMARY KEY,request_id INT REFERENCES requests(id),name TEXT,qty NUMERIC,sale_price NUMERIC,purchase_price NUMERIC,status TEXT);
      CREATE TABLE generated_documents(id SERIAL PRIMARY KEY,request_id INT REFERENCES requests(id),document_type TEXT,document_number TEXT,created_by INT REFERENCES users(id));
      CREATE TABLE request_history(id SERIAL PRIMARY KEY,request_id INT REFERENCES requests(id),user_id INT REFERENCES users(id),action TEXT,details JSONB);
      CREATE FUNCTION request_close_guard() RETURNS trigger AS $$ BEGIN
        IF NEW.status='CLOSED' AND OLD.status IS DISTINCT FROM 'CLOSED' AND COALESCE(current_setting('app.completion_close_request',true),'')<>NEW.id::text THEN
          RAISE EXCEPTION 'Закройте заказ через процедуру завершения ремонта';
        END IF; RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER request_close_guard BEFORE UPDATE OF status ON requests FOR EACH ROW EXECUTE FUNCTION request_close_guard();
    `);
    await installDocumentVersionSchema(db);
    await assert.rejects(db.exec("UPDATE requests SET status='CLOSED' WHERE id=1"),/процедуру завершения ремонта/i);
    await db.exec('BEGIN');
    const result=await closeOrder(db,{requestId:1,userId:1});
    await db.exec('COMMIT');
    assert.equal(result.status,'CLOSED');assert.equal(result.documents.length,2);
    const request=(await db.query('SELECT status,closed_at,warranty_until FROM requests WHERE id=1')).rows[0];
    assert.equal(request.status,'CLOSED');assert.ok(request.closed_at);assert.ok(request.warranty_until);
    assert.equal((await db.query('SELECT count(*) n FROM generated_documents WHERE request_id=1')).rows[0].n,2);
    const documents=(await db.query('SELECT version,snapshot,content_hash FROM generated_documents WHERE request_id=1 ORDER BY document_type')).rows;
    assert.ok(documents.every(x=>Number(x.version)===1&&x.snapshot.request.number==='CLOSE-1'&&/^[a-f0-9]{64}$/.test(x.content_hash)));
    const history=(await db.query("SELECT details FROM request_history WHERE action='REQUEST_CLOSED'")).rows[0];
    assert.equal(history.details.checks.after_photos,1);assert.equal(history.details.checks.client_signature,true);
  }finally{await db.close();}
});
