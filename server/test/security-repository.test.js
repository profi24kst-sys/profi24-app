import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
const root=new URL('../../',import.meta.url);
const read=path=>readFileSync(new URL(path,root),'utf8');

test('legacy insecure server entrypoint cannot ship in working source or Docker API image',()=>{
  assert.equal(existsSync(new URL('server/src/index.js',root)),false,
    'Legacy three-role entrypoint must not remain next to the production API');
  const pkg=JSON.parse(read('server/package.json'));
  for(const [name,command] of Object.entries(pkg.scripts)){
    assert.doesNotMatch(command,/(?:node|nodemon)\s+(?:\.\/)?src\/index\.js(?:\s|$)/,
      'Active npm script '+name+' must not execute legacy entrypoint');
  }
  const dockerfile=read('server/Dockerfile');
  assert.match(dockerfile,/COPY --chown=node:node src \.\/src/);
  assert.match(pkg.scripts.start,/src\/index2\.js/);
});

test('secret-bearing environment variants and private keys are excluded from Git and Docker build contexts',()=>{
  const git=read('.gitignore'),server=read('server/.dockerignore'),web=read('web/.dockerignore');
  assert.match(git,/\*\*\/\.env\*/);
  assert.match(git,/!\*\*\/\.env\.example/);
  for(const [label,content] of [['server',server],['web',web]]){
    assert.match(content,/^\.env\*$/m,label+' build context must ignore private .env files');
    assert.match(content,/^\*\*\/\*\.pem$/m);
    assert.match(content,/^\*\*\/\*\.key$/m);
  }
  assert.ok(existsSync(new URL('.env.example',root)),'documented safe .env.example must remain');
});


test('shared frontend HTML escaping is used for dynamic workflow and order-action markup',async()=>{
  const {escapeHtml}=await import('../../web/html-safety.js');
  assert.equal(escapeHtml('&<>"\''),'&amp;&lt;&gt;&quot;&#39;');
  for(const file of ['web/order-hc-actions.js','web/workflow-addon.jsx','web/closed-order-edit.js']){
    const source=read(file);
    assert.match(source,/from '\.\/html-safety\.js'/,file+' must use the shared HTML safety helper');
  }
  const workflow=read('web/workflow-addon.jsx');
  assert.match(workflow,/esc\(e\.user_name\|\|'Система'\)/);
  assert.match(workflow,/esc\(x\.next\.label\)/);
});


test('owner correction editor escapes database-provided names before innerHTML interpolation',()=>{
  const source=read('web/closed-order-edit.js');
  assert.match(source,/esc\(w\.name\|\|'Работа'\)/);
  assert.match(source,/esc\(p\.name\|\|'Запчасть'\)/);
  assert.match(source,/esc\(p\.created_by_name\)/);
  assert.match(source,/esc\(f\.value\?\?''\)/);
});


test('image uploads use the shared 10 MB client limit and compression helper',async()=>{
  const {MAX_UPLOAD_BYTES}=await import('../../web/image-upload.js');
  assert.equal(MAX_UPLOAD_BYTES,10*1024*1024);
  for(const file of ['web/documents-addon.jsx','web/order360-photo-before.js','web/engineer-mobile.jsx']){
    const source=read(file);
    assert.match(source,/prepareImageUpload/,file+' must prepare images before upload');
    assert.match(source,/MAX_UPLOAD_BYTES/,file+' must enforce the shared 10 MB client limit');
  }
  const ui=read('web/upload-security-ui.js');
  assert.match(ui,/до 10 МБ/);
  assert.doesNotMatch(ui,/до 8 МБ/);
});


test('owner staff UI exposes inherited and per-user permission modes',()=>{
  const ui=read('web/app3.jsx');
  assert.match(ui,/function PermissionEditor/);
  assert.match(ui,/available_permissions/);
  assert.match(ui,/По роли/);
  assert.match(ui,/Индивидуально разрешено/);
  assert.match(ui,/Индивидуально запрещено/);
  assert.match(ui,/PUT/);
  assert.match(ui,/\/users\/'\+employee\.id\+'\/permissions/);
});
