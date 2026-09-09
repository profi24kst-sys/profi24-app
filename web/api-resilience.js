// PROFI24 frontend resilience layer.
// Critical order/auth APIs are never hidden. Optional dashboard modules degrade independently.
const nativeFetch=window.fetch.bind(window);
const fallbacks=[
  [/\/api\/v1\/customers(?:\?|$)/,{data:[]}],
  [/\/api\/v1\/equipment(?:\?|$)/,{data:[]}],
  [/\/api\/v1\/users(?:\?|$)/,{data:[]}],
  [/\/api\/v1\/tasks(?:\?|$)/,{data:[]}],
  [/\/api\/v1\/dashboard\/finance(?:\?|$)/,{data:{totals:{}}}],
  [/\/api\/v1\/dashboard(?:\?|$)/,{data:{}}]
];
function target(input){return typeof input==='string'?input:(input?.url||'')}
function fallbackFor(url){return fallbacks.find(([re])=>re.test(url))?.[1]}
function synthetic(data,reason){return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json','X-Profi24-Fallback':'1','X-Profi24-Fallback-Reason':reason}})}
function isRequestList(url,method){return method==='GET'&&/\/api\/v1\/requests(?:\?.*)?$/.test(url)}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
function retryAfterMs(response,attempt){
  const raw=response.headers.get('Retry-After');let base=null;
  if(raw){const seconds=Number(raw);if(Number.isFinite(seconds))base=Math.min(5000,Math.max(100,Math.ceil(seconds*1000)));else{const at=Date.parse(raw);if(Number.isFinite(at))base=Math.min(5000,Math.max(100,at-Date.now()))}}
  if(base==null)base=Math.min(4000,500*(attempt+1));
  return base+Math.floor(Math.random()*250);
}
async function idempotentFetch(input,init,method){
  let response=await nativeFetch(input,init);
  if(!['GET','HEAD'].includes(method)||response.status!==429)return response;
  for(let attempt=0;attempt<5&&response.status===429;attempt++){
    const wait=retryAfterMs(response,attempt);
    console.warn('[PROFI24] Rate limited read; retrying',target(input),wait);
    await sleep(wait);
    response=await nativeFetch(input,init);
  }
  return response;
}
async function stripDeleted(response){if(!response.ok)return response;try{const j=await response.clone().json();if(!Array.isArray(j?.data))return response;const data=j.data.filter(x=>!x?.deleted_at);if(data.length===j.data.length)return response;const h=new Headers(response.headers);h.set('Content-Type','application/json');h.set('X-Profi24-Deleted-Filtered',String(j.data.length-data.length));return new Response(JSON.stringify({...j,data}),{status:response.status,statusText:response.statusText,headers:h})}catch{return response}}
window.fetch=async function(input,init){
  const url=target(input),method=String(init?.method||'GET').toUpperCase();
  const critical=/\/api\/v1\/(?:requests|auth|me|complaints)(?:\/|\?|$)/.test(url)||url.includes('/owner-api/');
  const fb=method==='GET'&&!critical?fallbackFor(url):null;
  try{
    let response=await idempotentFetch(input,init,method);
    if(isRequestList(url,method))response=await stripDeleted(response);
    if(!fb||response.status<429||response.status===401||response.status===403||response.status===404)return response;
    console.warn('[PROFI24] Optional API unavailable; fallback used',url,response.status);
    return synthetic(fb,'http-'+response.status);
  }catch(error){
    if(!fb)throw error;
    console.warn('[PROFI24] Optional API network failure; fallback used',url,error);
    return synthetic(fb,'network');
  }
};
