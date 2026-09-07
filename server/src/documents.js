import {authenticate,installOrderAccess,protectOrderTables} from './access.js';
import {contentDispositionAttachment,decodeDataUrl,inspectUpload,fileSecurityError} from './file-security.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import pg from 'pg';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const app=Fastify({logger:true,bodyLimit:12*1024*1024});
await app.register(cors,{origin:(process.env.CORS_ORIGIN||'http://localhost:5173').split(',').map(x=>x.trim()),credentials:true});
await app.register(helmet,{contentSecurityPolicy:false});
await app.register(rateLimit,{max:200,timeWindow:'1 minute'});
await app.register(jwt,{secret:process.env.JWT_SECRET||'dev-secret-change-me'});
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const q=(s,p=[])=>pool.query(s,p);
const fail=(r,c,m,s=422)=>r.code(s).send({data:null,error:{code:c,message:m}});
const root=path.resolve(process.env.UPLOAD_DIR||'/data/uploads');
const allowedKinds=new Set(['DEFECT_PHOTO','PHOTO_BEFORE','NAMEPLATE','PHOTO_AFTER','RECEIPT','OTHER']);
await fs.mkdir(root,{recursive:true});

for(const s of[
  `CREATE TABLE IF NOT EXISTS request_files(id SERIAL PRIMARY KEY,request_id INT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,kind TEXT NOT NULL DEFAULT 'OTHER',original_name TEXT NOT NULL,stored_name TEXT NOT NULL,mime_type TEXT NOT NULL,size_bytes INT NOT NULL,uploaded_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_request_files_request ON request_files(request_id,created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS request_signatures(id SERIAL PRIMARY KEY,request_id INT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,signer_type TEXT NOT NULL CHECK(signer_type IN('CLIENT','ENGINEER')),signer_name TEXT,signature_data TEXT NOT NULL,signed_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS generated_documents(id SERIAL PRIMARY KEY,request_id INT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,document_type TEXT NOT NULL,document_number TEXT NOT NULL,created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now())`
])await q(s);

const auth=async(req,r)=>{if(!await authenticate(req,r,pool))return false;return true;};
async function requestAccess(req,r,id){
  if(!await auth(req,r))return false;
  if(req.order&&Number(req.order.id)===Number(id))return true;
  const exists=(await q('SELECT id FROM requests WHERE id=$1 AND deleted_at IS NULL',[id])).rows[0];
  if(!exists){fail(r,'NOT_FOUND','Заказ не найден',404);return false;}
  return true;
}
const hist=(id,u,a,d={})=>q('INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,$3,$4)',[id,u,a,d]);
function storagePath(storedName){
  const base=path.basename(String(storedName||''));
  if(!base||base!==storedName)throw fileSecurityError('UNSAFE_FILE_PATH','Некорректный путь вложения',409);
  const target=path.resolve(root,base);
  if(!target.startsWith(root+path.sep))throw fileSecurityError('UNSAFE_FILE_PATH','Некорректный путь вложения',409);
  return target;
}
function sendSecurityError(reply,error){return fail(reply,error.code||'FILE_REJECTED',error.message,error.statusCode||422);}

await protectOrderTables(pool,['request_files','request_signatures']);
installOrderAccess(app,pool,'documents');

app.get('/health',async()=>{await q('SELECT 1');return{ok:true,service:'profi24-documents'}});

app.get('/api/v1/requests/:id/files',async(req,r)=>{
  if(!await requestAccess(req,r,req.params.id))return;
  return{data:(await q('SELECT f.*,u.name uploaded_by_name FROM request_files f LEFT JOIN users u ON u.id=f.uploaded_by WHERE request_id=$1 ORDER BY created_at DESC',[req.params.id])).rows};
});

app.post('/api/v1/requests/:id/files',async(req,r)=>{
  if(!await requestAccess(req,r,req.params.id))return;
  const b=req.body||{};
  if(!b.name||!b.data)return fail(r,'VALIDATION','Файл не передан');
  const kind=String(b.kind||'OTHER').toUpperCase();
  if(!allowedKinds.has(kind))return fail(r,'VALIDATION','Некорректный тип вложения');
  let decoded,meta;
  try{
    decoded=decodeDataUrl(b.data);
    meta=inspectUpload({buffer:decoded.buffer,declaredMime:decoded.declaredMime,originalName:b.name});
  }catch(error){return sendSecurityError(r,error);}
  const stored=crypto.randomUUID()+meta.extension;
  const target=storagePath(stored);
  try{
    await fs.writeFile(target,decoded.buffer,{flag:'wx',mode:0o600});
    const x=(await q(
      'INSERT INTO request_files(request_id,kind,original_name,stored_name,mime_type,size_bytes,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [req.params.id,kind,meta.originalName,stored,meta.mime,meta.size,req.user.id]
    )).rows[0];
    await hist(req.params.id,req.user.id,'FILE_UPLOADED',{file_id:x.id,kind:x.kind,name:x.original_name,mime_type:x.mime_type,size_bytes:x.size_bytes});
    return r.code(201).send({data:x});
  }catch(error){
    await fs.unlink(target).catch(()=>{});
    throw error;
  }
});

app.get('/api/v1/files/:id',async(req,r)=>{
  if(!await auth(req,r))return;
  const f=(await q('SELECT f.*,r.engineer_id FROM request_files f JOIN requests r ON r.id=f.request_id WHERE f.id=$1',[req.params.id])).rows[0];
  if(!f)return fail(r,'NOT_FOUND','Файл не найден',404);
  let b,meta;
  try{
    b=await fs.readFile(storagePath(f.stored_name));
    meta=inspectUpload({buffer:b,declaredMime:'application/octet-stream',originalName:f.original_name});
  }catch(error){
    if(error?.code==='ENOENT')return fail(r,'FILE_MISSING','Файл отсутствует в хранилище',410);
    return sendSecurityError(r,Object.assign(error,{code:error.code?.startsWith('FILE_')?error.code:'UNSAFE_STORED_FILE'}));
  }
  r.header('Content-Type',meta.mime)
    .header('Content-Disposition',contentDispositionAttachment(meta.originalName))
    .header('X-Content-Type-Options','nosniff')
    .header('Cache-Control','private, no-store')
    .header('Content-Security-Policy',"default-src 'none'; sandbox");
  return r.send(b);
});

app.delete('/api/v1/files/:id',async(req,r)=>{
  if(!await auth(req,r))return;
  if(!['OWNER','SUPERVISOR','MANAGER'].includes(req.user.role))return fail(r,'FORBIDDEN','Удаление вложений доступно только владельцу, управляющему или менеджеру',403);
  const f=(await q('DELETE FROM request_files WHERE id=$1 RETURNING *',[req.params.id])).rows[0];
  if(!f)return fail(r,'NOT_FOUND','Файл не найден',404);
  try{await fs.unlink(storagePath(f.stored_name));}catch(error){if(error?.code!=='ENOENT')req.log.warn(error,'failed to delete stored attachment');}
  await hist(f.request_id,req.user.id,'FILE_DELETED',{file_id:f.id,name:f.original_name});
  return{data:{ok:true}};
});

app.get('/api/v1/requests/:id/signatures',async(req,r)=>{
  if(!await requestAccess(req,r,req.params.id))return;
  return{data:(await q('SELECT id,request_id,signer_type,signer_name,signed_by,created_at FROM request_signatures WHERE request_id=$1 ORDER BY created_at DESC',[req.params.id])).rows};
});

app.post('/api/v1/requests/:id/signatures',async(req,r)=>{
  if(!await requestAccess(req,r,req.params.id))return;
  const b=req.body||{};
  if(!['CLIENT','ENGINEER'].includes(b.signer_type))return fail(r,'VALIDATION','Некорректный тип подписи');
  let decoded,meta;
  try{
    decoded=decodeDataUrl(b.signature_data,{maxEncodedChars:3*1024*1024});
    meta=inspectUpload({buffer:decoded.buffer,declaredMime:decoded.declaredMime,originalName:'signature',maxBytes:2*1024*1024});
    if(!['image/jpeg','image/png','image/webp'].includes(meta.mime))throw fileSecurityError('UNSUPPORTED_SIGNATURE_TYPE','Подпись должна быть PNG, JPEG или WebP');
  }catch(error){return sendSecurityError(r,error);}
  const signatureData=`data:${meta.mime};base64,${decoded.buffer.toString('base64')}`;
  const signerName=String(b.signer_name||'').replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,160)||null;
  const x=(await q(
    'INSERT INTO request_signatures(request_id,signer_type,signer_name,signature_data,signed_by) VALUES($1,$2,$3,$4,$5) RETURNING id,request_id,signer_type,signer_name,created_at',
    [req.params.id,b.signer_type,signerName,signatureData,req.user.id]
  )).rows[0];
  await hist(req.params.id,req.user.id,'SIGNATURE_ADDED',{signer_type:b.signer_type,signer_name:signerName});
  return r.code(201).send({data:x});
});

app.get('/api/v1/requests/:id/document-data',async(req,r)=>{
  if(!await requestAccess(req,r,req.params.id))return;
  const x=(await q(`SELECT r.*,c.name customer_name,c.phone,c.address,e.category,e.brand,e.model,e.serial_number,eng.name engineer_name FROM requests r JOIN customers c ON c.id=r.customer_id LEFT JOIN equipment e ON e.id=r.equipment_id LEFT JOIN users eng ON eng.id=r.engineer_id WHERE r.id=$1`,[req.params.id])).rows[0];
  const [w,p,s]=await Promise.all([
    q('SELECT * FROM request_works WHERE request_id=$1 ORDER BY id',[req.params.id]),
    q("SELECT * FROM parts WHERE request_id=$1 AND status<>'CANCELLED' ORDER BY id",[req.params.id]),
    q('SELECT signer_type,signer_name,signature_data,created_at FROM request_signatures WHERE request_id=$1 ORDER BY created_at DESC',[req.params.id])
  ]);
  return{data:{...x,works:w.rows,parts:p.rows,signatures:s.rows}};
});

app.post('/api/v1/requests/:id/documents',async(req,r)=>{
  if(!await requestAccess(req,r,req.params.id))return;
  const type=req.body?.document_type;
  if(!['WORK_ORDER','DEFECT_ACT','COMPLETION_ACT','WARRANTY'].includes(type))return fail(r,'VALIDATION','Некорректный тип документа');
  const no=`${type}-${req.params.id}-${Date.now().toString().slice(-8)}`;
  const x=(await q('INSERT INTO generated_documents(request_id,document_type,document_number,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',[req.params.id,type,no,req.user.id])).rows[0];
  await hist(req.params.id,req.user.id,'DOCUMENT_GENERATED',{document_type:type,document_number:no});
  return r.code(201).send({data:x});
});

app.listen({port:Number(process.env.PORT||8086),host:'0.0.0.0'});
