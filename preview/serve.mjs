import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const PORT=Number(process.env.PORT||10000);
const CORE_PORT=18080,AUTH_PORT=18109;
const children=[];
let backendState='Awaiting a database connection';

function runNode(file,port){
  const child=spawn(process.execPath,[file],{
    cwd:path.join(ROOT,'server'),
    env:{...process.env,PORT:String(port),DB_POOL_MAX:'3'},
    stdio:'inherit'
  });
  children.push(child);
  child.on('exit',(code,signal)=>{
    console.error('preview_child_exit',file,code,signal);
    backendState='Core service unavailable; check deployment logs';
  });
}
if(process.env.DATABASE_URL){
  const seedEmail=process.env.DEMO_OWNER_EMAIL||'preview-owner@profi24.invalid';
  const seedPassword=process.env.DEMO_OWNER_PASSWORD||'';
  if(seedPassword){
    const seed=spawnSync(process.execPath,['src/bootstrap-owner.js',seedEmail,seedPassword,'Демо-собственник'],{
      cwd:path.join(ROOT,'server'),env:{...process.env,DB_POOL_MAX:'3'},
      stdio:'inherit',timeout:180000
    });
    if(seed.status!==0&&seed.status!==3){
      console.error('preview_seed_failed',seed.status,seed.error?.message||'');
      backendState='Database or initial owner setup failed';
    }else{
      runNode('src/index2.js',CORE_PORT);
      runNode('src/auth.js',AUTH_PORT);
      backendState='Starting CRM core services';
    }
  }else{
    backendState='Set DEMO_OWNER_PASSWORD in private Render environment';
  }
}

const publicDir=path.join(ROOT,'preview');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
const apiReply=(res,status,error)=>{
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify({data:null,error:{code:'PREVIEW_NOT_READY',message:error}}));
};
async function proxy(req,res,target,rewrite){
  try{
    const original=new URL(req.url,'https://preview.invalid');
    const dest='http://127.0.0.1:'+target+(rewrite||original.pathname)+original.search;
    const parts=[];
    let size=0;
    for await(const part of req){
      size+=part.length;
      if(size>2*1024*1024){apiReply(res,413,'Preview request too large');return}
      parts.push(part);
    }
    const headers={};
    for(const key of ['authorization','content-type','accept','cookie','idempotency-key','user-agent']){
      if(req.headers[key])headers[key]=req.headers[key];
    }
    headers['x-forwarded-proto']='https';
    const upstream=await fetch(dest,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(parts),signal:AbortSignal.timeout(30000)});
    const responseHeaders={'Cache-Control':'no-store'};
    for(const key of ['content-type','set-cookie','content-disposition']){
      const val=upstream.headers.get(key);
      if(val)responseHeaders[key]=val;
    }
    res.writeHead(upstream.status,responseHeaders);
    const bytes=Buffer.from(await upstream.arrayBuffer());
    res.end(req.method==='HEAD'?undefined:bytes);
  }catch(error){
    console.error('preview_proxy_error',error?.message||error);
    apiReply(res,503,backendState);
  }
}
http.createServer(async(req,res)=>{
  const pathname=new URL(req.url,'https://preview.invalid').pathname;
  if(pathname==='/preview-health'){
    const health={preview:'ok',backend:backendState};
    let ready=false;
    try{
      const [a,b]=await Promise.all([fetch('http://127.0.0.1:'+CORE_PORT+'/health',{signal:AbortSignal.timeout(1500)}),fetch('http://127.0.0.1:'+AUTH_PORT+'/health',{signal:AbortSignal.timeout(1500)})]);
      ready=a.ok&&b.ok;
    }catch{}
    res.writeHead(ready?200:503,{'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end(JSON.stringify({...health,ready}));return;
  }
  if(pathname==='/health')return proxy(req,res,CORE_PORT,'/health');
  if(pathname==='/auth-health')return proxy(req,res,AUTH_PORT,'/health');
  if(pathname==='/api/v1/auth/login')return proxy(req,res,AUTH_PORT,pathname);
  if(pathname.startsWith('/auth-api/'))return proxy(req,res,AUTH_PORT,'/api/'+pathname.slice('/auth-api/'.length));
  if(pathname.startsWith('/api/'))return proxy(req,res,CORE_PORT,pathname);
  let name=pathname==='/app.js'?'app.js':'index.html';
  try{
    const file=await readFile(path.join(publicDir,name));
    res.writeHead(200,{
      'Content-Type':mime[path.extname(name)],
      'Cache-Control':name==='index.html'?'no-cache':'public, max-age=300',
      'X-Content-Type-Options':'nosniff',
      'X-Frame-Options':'DENY',
      'Referrer-Policy':'no-referrer',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    });
    res.end(file);
  }catch{res.writeHead(404);res.end('Not found')}
}).listen(PORT,'0.0.0.0',()=>console.log('profi24_preview_gateway_listening',PORT));

function terminate(){
  for(const child of children)try{child.kill('SIGTERM')}catch{}
  process.exit(0);
}
process.on('SIGTERM',terminate);
process.on('SIGINT',terminate);
