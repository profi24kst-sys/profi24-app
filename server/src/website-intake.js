import {createHash,timingSafeEqual} from 'node:crypto';

const MAX={name:120,phone:40,email:200,address:500,category:120,brand:120,model:160,complaint:2500,page_url:1000,utm:200,idempotency:160};
const VISIT_TYPES=new Set(['FIELD','WORKSHOP']);

function clean(value,max){
  if(value==null)return null;
  const s=String(value).trim();
  if(!s)return null;
  return s.slice(0,max);
}
function normalizePhone(value){
  return String(value||'').replace(/\D/g,'').replace(/^8(?=7\d{9}$)/,'7');
}
function sameSecret(actual,expected){
  const a=Buffer.from(String(actual||'')),b=Buffer.from(String(expected||''));
  return a.length===b.length&&a.length>0&&timingSafeEqual(a,b);
}
function payloadHash(value){return createHash('sha256').update(JSON.stringify(value)).digest('hex')}
function fail(reply,code,message,status=422){return reply.code(status).send({data:null,error:{code,message}})}
function yearInTimezone(timezone){
  try{return new Intl.DateTimeFormat('en',{year:'numeric',timeZone:timezone||'Asia/Qostanay'}).format(new Date())}
  catch{return String(new Date().getFullYear())}
}

export function sanitizeWebsiteIntake(body={}){
  const payload={
    name:clean(body.name,MAX.name),
    phone:clean(body.phone,MAX.phone),
    email:clean(body.email,MAX.email),
    address:clean(body.address,MAX.address),
    category:clean(body.category,MAX.category),
    brand:clean(body.brand,MAX.brand),
    model:clean(body.model,MAX.model),
    complaint:clean(body.complaint,MAX.complaint),
    visit_type:VISIT_TYPES.has(String(body.visit_type||'').toUpperCase())?String(body.visit_type).toUpperCase():'FIELD',
    branch_code:(clean(body.branch_code,16)||'KST').toUpperCase(),
    page_url:clean(body.page_url,MAX.page_url),
    utm_source:clean(body.utm_source,MAX.utm),
    utm_medium:clean(body.utm_medium,MAX.utm),
    utm_campaign:clean(body.utm_campaign,MAX.utm)
  };
  return payload;
}

export function installWebsiteIntake(app,pool,{secret=process.env.WEBSITE_INTAKE_SECRET}={}){
  app.post('/api/v1/website-intake',{config:{rateLimit:{max:30,timeWindow:'1 minute'}}},async(req,reply)=>{
    if(!secret)return fail(reply,'WEBSITE_INTAKE_DISABLED','Приём заявок с сайта не настроен',503);
    if(!sameSecret(req.headers['x-profi24-intake-secret'],secret))return fail(reply,'UNAUTHORIZED','Неверный ключ интеграции',401);

    const key=clean(req.headers['x-idempotency-key']??req.body?.idempotency_key,MAX.idempotency);
    if(!key||key.length<8||!/^[A-Za-z0-9._:-]+$/.test(key))return fail(reply,'IDEMPOTENCY_REQUIRED','Передайте корректный X-Idempotency-Key',422);
    const payload=sanitizeWebsiteIntake(req.body||{}),pn=normalizePhone(payload.phone);
    if(!payload.name||!payload.phone||!payload.complaint)return fail(reply,'VALIDATION','Имя, телефон и описание неисправности обязательны',422);
    if(pn.length<10||pn.length>15)return fail(reply,'VALIDATION','Некорректный телефон',422);
    if(payload.email&&(!payload.email.includes('@')||payload.email.length<5))return fail(reply,'VALIDATION','Некорректный email',422);
    const hash=payloadHash(payload);

    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      const claimed=(await c.query(`INSERT INTO website_intake_events(idempotency_key,payload_hash,status)
        VALUES($1,$2,'RECEIVED') ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`,[key,hash])).rows[0];
      if(!claimed){
        const previous=(await c.query('SELECT * FROM website_intake_events WHERE idempotency_key=$1 FOR UPDATE',[key])).rows[0];
        if(!previous){await c.query('ROLLBACK');return fail(reply,'INTAKE_CONFLICT','Не удалось проверить повторную заявку',409)}
        if(previous.payload_hash!==hash){await c.query('ROLLBACK');return fail(reply,'IDEMPOTENCY_CONFLICT','Этот X-Idempotency-Key уже использован с другими данными',409)}
        if(!previous.request_id){await c.query('ROLLBACK');return fail(reply,'INTAKE_CONFLICT','Заявка с этим ключом ещё обрабатывается',409)}
        const old=(await c.query('SELECT id,number,status,customer_id,equipment_id FROM requests WHERE id=$1',[previous.request_id])).rows[0];
        await c.query('COMMIT');
        return reply.code(200).send({data:{...old,duplicate:true}});
      }

      const branch=(await c.query('SELECT id,code,timezone FROM branches WHERE code=$1 AND active=true',[payload.branch_code])).rows[0];
      if(!branch){await c.query('ROLLBACK');return fail(reply,'BRANCH_NOT_FOUND','Филиал не найден или отключён',422)}

      let customer=(await c.query('SELECT * FROM customers WHERE phone_norm=$1 AND deleted_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE',[pn])).rows[0];
      if(customer){
        customer=(await c.query(`UPDATE customers SET
          email=CASE WHEN NULLIF(email,'') IS NULL AND $1::text IS NOT NULL THEN $1 ELSE email END,
          address=CASE WHEN NULLIF(address,'') IS NULL AND $2::text IS NOT NULL THEN $2 ELSE address END,
          updated_at=now() WHERE id=$3 RETURNING *`,[payload.email,payload.address,customer.id])).rows[0];
      }else{
        customer=(await c.query('INSERT INTO customers(name,phone,phone_norm,email,address,notes) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[
          payload.name,payload.phone,pn,payload.email,payload.address,'Создан автоматически из заявки на сайте'
        ])).rows[0];
      }

      let equipment=null;
      if(payload.category){
        equipment=(await c.query('INSERT INTO equipment(customer_id,category,brand,model,notes) VALUES($1,$2,$3,$4,$5) RETURNING *',[
          customer.id,payload.category,payload.brand,payload.model,'Создано автоматически из заявки на сайте'
        ])).rows[0];
      }

      const seq=(await c.query("SELECT nextval('request_number_seq') n")).rows[0].n;
      const number=`${branch.code}-${yearInTimezone(branch.timezone)}-${String(seq).padStart(7,'0')}`;
      const sla=new Date(Date.now()+60*60000);
      const request=(await c.query(`INSERT INTO requests(number,customer_id,equipment_id,branch_id,status,priority,source,complaint,sla_deadline,visit_type)
        VALUES($1,$2,$3,$4,'NEW','NORMAL','SITE',$5,$6,$7) RETURNING *`,[
          number,customer.id,equipment?.id||null,branch.id,payload.complaint,sla,payload.visit_type
        ])).rows[0];
      const metadata={intake_event_id:claimed.id,page_url:payload.page_url,utm_source:payload.utm_source,utm_medium:payload.utm_medium,utm_campaign:payload.utm_campaign,branch_code:branch.code};
      await c.query('INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,NULL,$2,$3)',[request.id,'REQUEST_CREATED',{source:'SITE',priority:'NORMAL',visit_type:payload.visit_type,external:true}]);
      await c.query('INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,NULL,$2,$3)',[request.id,'WEBSITE_INTAKE_ACCEPTED',metadata]);
      await c.query("UPDATE website_intake_events SET request_id=$1,status='CREATED',completed_at=now() WHERE id=$2",[request.id,claimed.id]);
      await c.query('COMMIT');
      return reply.code(201).send({data:{id:request.id,request_id:request.id,number:request.number,status:request.status,customer_id:customer.id,equipment_id:equipment?.id||null,duplicate:false}});
    }catch(error){
      try{await c.query('ROLLBACK')}catch{}
      req.log?.error?.({err:error},'website intake failed');
      return fail(reply,'INTAKE_FAILED','Не удалось создать заявку',500);
    }finally{c.release()}
  });
}
