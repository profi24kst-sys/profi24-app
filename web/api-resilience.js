// PROFI24 frontend resilience and short-lived session renewal layer.
// Critical order/auth APIs are never hidden. Optional dashboard modules degrade independently.
const nativeFetch=window.fetch.bind(window);
const AUTH_REFRESH='/auth-api/v1/auth/refresh';
let refreshPromise=null;
const fallbacks=[
  [/\/api\/v1\/customers(?:\?|$)/,{data:[]}],
  [/\/api\/v1\/equipment(?:\?|$)/,{data:[]}],
  [/\/api\/v1\/users(?:\?|$)/,{data:[]}],
  [/\/api\/v1\/tasks(?:\?|$)/,{data:[]}],
  [/\/api\/v1\/dashboard\/finance(?:\?|$)/,{data:{totals:{}}}],
  [/\/api\/v1\/dashboard(?:\?|$)/,{data:{}}]
];
function target(input){return typeof input==='string'?input:(input?.url||'')}
function pathOf(input){try{return new URL(target(input),location.origin).pathname}catch{return target(input)}}
function fallbackFor(url){return fallbacks.find(([re])=>re.test(url))?.[1]}
function synthetic(data,reason){return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json','X-Profi24-Fallback':'1','X-Profi24-Fallback-Reason':reason}})}
function isRequestList(url,method){return method==='GET'&&/\/api\/v1\/requests(?:\?.*)?$/.test(url)}
function isAuthLifecycle(url){return /^\/(?:api\/v1\/auth\/login|auth-api\/v1\/auth\/(?:refresh|logout))$/.test(pathOf(url))}
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
function rememberSession(data){
  if(!data?.access_token)throw new Error('Refresh response has no access token');
  localStorage.setItem('token',data.access_token);
  if(data.user)localStorage.setItem('user',JSON.stringify(data.user));
  return data.access_token;
}
function expireLocalSession(){
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  window.dispatchEvent(new CustomEvent('profi24:session-expired'));
}
async function refreshSession(){
  if(refreshPromise)return refreshPromise;
  refreshPromise=(async()=>{
    const response=await nativeFetch(AUTH_REFRESH,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}});
    let json={};try{json=await response.json()}catch{}
    if(!response.ok)throw new Error(json.error?.message||'Сессия истекла');
    return rememberSession(json.data);
  })().finally(()=>{refreshPromise=null});
  return refreshPromise;
}
function withAccessToken(input,init,token){
  const sourceHeaders=init?.headers||(typeof Request!=='undefined'&&input instanceof Request?input.headers:undefined);
  const headers=new Headers(sourceHeaders||{});
  headers.set('Authorization',`Bearer ${token}`);
  return {...(init||{}),headers,credentials:init?.credentials||'same-origin'};
}
async function fetchWithSession(input,init,method){
  const retryInput=typeof Request!=='undefined'&&input instanceof Request?input.clone():input;
  let response=await idempotentFetch(input,init,method);
  if(response.status!==401||isAuthLifecycle(input)||!localStorage.getItem('user'))return response;
  try{
    const token=await refreshSession();
    response=await idempotentFetch(retryInput,withAccessToken(retryInput,init,token),method);
  }catch(error){
    console.warn('[PROFI24] Session refresh failed',error);
    expireLocalSession();
  }
  return response;
}
async function stripDeleted(response){if(!response.ok)return response;try{const j=await response.clone().json();if(!Array.isArray(j?.data))return response;const data=j.data.filter(x=>!x?.deleted_at);if(data.length===j.data.length)return response;const h=new Headers(response.headers);h.set('Content-Type','application/json');h.set('X-Profi24-Deleted-Filtered',String(j.data.length-data.length));return new Response(JSON.stringify({...j,data}),{status:response.status,statusText:response.statusText,headers:h})}catch{return response}}
window.fetch=async function(input,init){
  const url=target(input),method=String(init?.method||'GET').toUpperCase();
  const critical=/\/api\/v1\/(?:requests|auth|me|complaints)(?:\/|\?|$)/.test(url)||url.includes('/owner-api/');
  const fb=method==='GET'&&!critical?fallbackFor(url):null;
  try{
    let response=await fetchWithSession(input,init,method);
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
