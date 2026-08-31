// PROFI24 frontend resilience layer.
// Critical order/auth APIs are never hidden. Optional dashboard modules degrade independently.
const nativeFetch=window.fetch.bind(window);
const fallbacks=[
  [/\/api\/v1\/customers(?:\?|$)/,{data:[]}],
  [/\/api\/v1\/equipment(?:\?|$)/,{data:[]}],
  [/\/api\/v1\/users(?:\?|$)/,{data:[]}],
  [/\/api\/v1\/tasks(?:\?|$)/,{data:[]}],
  [/\/api\/v1\/complaints(?:\?|$)/,{data:[]}],
  [/\/api\/v1\/dashboard\/finance(?:\?|$)/,{data:{totals:{}}}],
  [/\/api\/v1\/dashboard(?:\?|$)/,{data:{}}]
];
function target(input){return typeof input==='string'?input:(input?.url||'')}
function fallbackFor(url){return fallbacks.find(([re])=>re.test(url))?.[1]}
function synthetic(data,reason){return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json','X-Profi24-Fallback':'1','X-Profi24-Fallback-Reason':reason}})}
window.fetch=async function(input,init){
  const url=target(input),method=String(init?.method||'GET').toUpperCase();
  const critical=/\/api\/v1\/(?:requests|auth|me)(?:\/|\?|$)/.test(url)||url.includes('/owner-api/');
  const fb=method==='GET'&&!critical?fallbackFor(url):null;
  try{
    const response=await nativeFetch(input,init);
    if(!fb||response.status<429||response.status===401||response.status===403||response.status===404)return response;
    console.warn('[PROFI24] Optional API unavailable; fallback used',url,response.status);
    return synthetic(fb,'http-'+response.status);
  }catch(error){
    if(!fb)throw error;
    console.warn('[PROFI24] Optional API network failure; fallback used',url,error);
    return synthetic(fb,'network');
  }
};
