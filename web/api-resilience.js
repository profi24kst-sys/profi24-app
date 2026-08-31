// PROFI24 frontend resilience layer.
// Prevents one non-critical module failure from blanking the entire Orders screen.
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
window.fetch=async function(input,init){
  const response=await nativeFetch(input,init);
  if(response.status<500)return response;
  const url=typeof input==='string'?input:(input?.url||'');
  // Requests are critical: never hide an error from the orders API itself.
  if(/\/api\/v1\/requests(?:\/|\?|$)/.test(url))return response;
  const match=fallbacks.find(([re])=>re.test(url));
  if(!match)return response;
  console.error('[PROFI24] Non-critical API failed; using safe fallback',url,response.status);
  return new Response(JSON.stringify(match[1]),{
    status:200,
    headers:{'Content-Type':'application/json','X-Profi24-Fallback':'1'}
  });
};
