const BASE=String(process.env.BASE_URL||'http://127.0.0.1:5173').replace(/\/+$/,'');
const EMAIL=process.env.PERF_EMAIL||'performance-owner@test.invalid';
const PASSWORD=process.env.PERF_PASSWORD||'PerformanceOwner2026Kst9';
const P95_BUDGET_MS=Number(process.env.PERF_P95_BUDGET_MS||2000);
const MAX_BUDGET_MS=Number(process.env.PERF_MAX_BUDGET_MS||3000);
const EXPECTED_ACTIVE=Number(process.env.PERF_EXPECTED_ACTIVE||500);

function fail(message){throw new Error(`PERFORMANCE_ACCEPTANCE: ${message}`)}
function percentile(values,p){
  if(!values.length)return 0;
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.max(0,Math.ceil(sorted.length*p)-1))];
}
function fmt(n){return Math.round(n*10)/10}

async function login(){
  const r=await fetch(`${BASE}/api/v1/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:EMAIL,password:PASSWORD})});
  const text=await r.text();let json={};try{json=JSON.parse(text)}catch{}
  if(!r.ok||!json.data?.access_token)fail(`login failed HTTP ${r.status}: ${text.slice(0,300)}`);
  return json.data.access_token;
}

async function request(token,path){
  const started=performance.now();
  let status=0,text='';
  try{
    const r=await fetch(`${BASE}${path}`,{headers:{Authorization:`Bearer ${token}`}});
    status=r.status;text=await r.text();
    return{ok:r.ok,status,ms:performance.now()-started,text};
  }catch(error){
    return{ok:false,status,ms:performance.now()-started,text:String(error?.message||error)};
  }
}

async function runPhase(token,{name,total,concurrency,path,budget=P95_BUDGET_MS,maxBudget=MAX_BUDGET_MS,validate}){
  let cursor=0;
  const results=[];
  const workers=Array.from({length:Math.min(concurrency,total)},async()=>{
    while(true){
      const i=cursor++;
      if(i>=total)return;
      const target=typeof path==='function'?path(i):path;
      const result=await request(token,target);
      if(result.ok&&validate){
        try{validate(result,i)}catch(error){result.ok=false;result.text=String(error?.message||error)}
      }
      results.push(result);
    }
  });
  await Promise.all(workers);
  const durations=results.map(x=>x.ms),errors=results.filter(x=>!x.ok);
  const p50=percentile(durations,.50),p95=percentile(durations,.95),p99=percentile(durations,.99),max=Math.max(...durations,0);
  console.log(`performance_phase=${name} total=${results.length} concurrency=${concurrency} errors=${errors.length} p50_ms=${fmt(p50)} p95_ms=${fmt(p95)} p99_ms=${fmt(p99)} max_ms=${fmt(max)}`);
  if(errors.length){
    const sample=errors.slice(0,3).map(x=>`HTTP ${x.status}: ${x.text.slice(0,180)}`).join(' | ');
    fail(`${name} produced ${errors.length}/${results.length} errors: ${sample}`);
  }
  if(p95>budget)fail(`${name} p95 ${fmt(p95)}ms exceeds ${budget}ms budget`);
  if(max>maxBudget)fail(`${name} max ${fmt(max)}ms exceeds ${maxBudget}ms guardrail`);
  return{p50,p95,p99,max,total:results.length};
}

const token=await login();

for(const path of ['/api/v1/me','/api/v1/dashboard','/api/v1/requests']){
  const r=await request(token,path);
  if(!r.ok)fail(`warmup ${path} HTTP ${r.status}: ${r.text.slice(0,200)}`);
}

const listProbe=await request(token,'/api/v1/requests');
if(!listProbe.ok)fail(`request-list probe HTTP ${listProbe.status}`);
let orders;
try{orders=JSON.parse(listProbe.text).data}catch{fail('request-list probe returned invalid JSON')}
if(!Array.isArray(orders))fail('request-list probe did not return data array');
const active=orders.filter(x=>!['CLOSED','CANCELLED'].includes(x.status));
if(active.length<EXPECTED_ACTIVE)fail(`expected at least ${EXPECTED_ACTIVE} active requests, got ${active.length}`);
const orderIds=active.slice(0,EXPECTED_ACTIVE).map(x=>Number(x.id)).filter(Number.isSafeInteger);
if(orderIds.length<EXPECTED_ACTIVE)fail(`only ${orderIds.length} valid request ids available`);
console.log(`performance_dataset=ok active_requests=${active.length} expected=${EXPECTED_ACTIVE} initial_list_ms=${fmt(listProbe.ms)}`);

// Keep the measured burst below the existing 300 requests/minute per-IP guard.
// The specification target is 500 simultaneously active service requests, not bypassing abuse protection.
await runPhase(token,{
  name:'orders_list_500_active',
  total:30,
  concurrency:10,
  path:'/api/v1/requests',
  validate:r=>{const j=JSON.parse(r.text);if(!Array.isArray(j.data)||j.data.length<EXPECTED_ACTIVE)throw new Error('orders list is incomplete')}
});

await runPhase(token,{
  name:'dashboard_parallel',
  total:80,
  concurrency:40,
  path:'/api/v1/dashboard',
  validate:r=>{const j=JSON.parse(r.text);if(Number(j.data?.active)<EXPECTED_ACTIVE)throw new Error(`dashboard active=${j.data?.active}`)}
});

await runPhase(token,{
  name:'order_detail_parallel',
  total:120,
  concurrency:25,
  path:i=>`/api/v1/requests/${orderIds[i%orderIds.length]}`,
  validate:r=>{const j=JSON.parse(r.text);if(!j.data?.id)throw new Error('order detail missing id')}
});

await runPhase(token,{
  name:'session_parallel',
  total:40,
  concurrency:20,
  path:'/api/v1/me',
  budget:Math.min(P95_BUDGET_MS,1500),
  validate:r=>{const j=JSON.parse(r.text);if(!j.data?.id)throw new Error('session missing user')}
});

console.log(`PERFORMANCE_ACCEPTANCE: ok active_requests=${active.length} p95_budget_ms=${P95_BUDGET_MS} max_guardrail_ms=${MAX_BUDGET_MS}`);
