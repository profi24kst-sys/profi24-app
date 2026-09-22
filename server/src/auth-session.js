import crypto from 'node:crypto';

const DEFAULT_ACCESS_TTL_SECONDS=15*60;
const DEFAULT_REFRESH_TTL_DAYS=7;

function boundedInt(value,{min,max,fallback}){
  const parsed=Number(value);
  if(!Number.isFinite(parsed))return fallback;
  return Math.max(min,Math.min(max,Math.trunc(parsed)));
}

export function clampAccessTtlSeconds(value){
  return boundedInt(value,{min:60,max:15*60,fallback:DEFAULT_ACCESS_TTL_SECONDS});
}

export function clampRefreshTtlDays(value){
  return boundedInt(value,{min:1,max:30,fallback:DEFAULT_REFRESH_TTL_DAYS});
}

export function accessTtlSeconds(env=process.env){
  return clampAccessTtlSeconds(env.AUTH_ACCESS_TTL_SECONDS);
}

export function refreshTtlDays(env=process.env){
  return clampRefreshTtlDays(env.AUTH_REFRESH_TTL_DAYS);
}

export function refreshCookieName(env=process.env){
  const candidate=String(env.AUTH_REFRESH_COOKIE_NAME||'profi24_refresh').trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(candidate)?candidate:'profi24_refresh';
}

export function createRefreshToken(){
  return crypto.randomBytes(32).toString('base64url');
}

export function hashRefreshToken(token){
  return crypto.createHash('sha256').update(String(token||''),'utf8').digest('hex');
}

export function parseCookieHeader(header=''){
  const out={};
  for(const part of String(header||'').split(';')){
    const idx=part.indexOf('=');
    if(idx<=0)continue;
    const key=part.slice(0,idx).trim();
    if(!key)continue;
    const raw=part.slice(idx+1).trim();
    try{out[key]=decodeURIComponent(raw)}catch{out[key]=raw}
  }
  return out;
}

export function readRefreshToken(header,env=process.env){
  return parseCookieHeader(header)[refreshCookieName(env)]||'';
}

export function secureCookieForRequest(req,env=process.env){
  const explicit=String(env.AUTH_COOKIE_SECURE||'').trim().toLowerCase();
  if(explicit==='true'||explicit==='1'||explicit==='yes')return true;
  if(explicit==='false'||explicit==='0'||explicit==='no')return false;
  const forwarded=String(req?.headers?.['x-forwarded-proto']||'').split(',')[0].trim().toLowerCase();
  return forwarded==='https'||String(req?.protocol||'').toLowerCase()==='https';
}

export function buildRefreshCookie(token,{env=process.env,secure=false,maxAgeSeconds,clear=false}={}){
  const name=refreshCookieName(env);
  const maxAge=clear?0:boundedInt(maxAgeSeconds,{min:1,max:30*86400,fallback:refreshTtlDays(env)*86400});
  const parts=[
    `${name}=${clear?'':encodeURIComponent(String(token||''))}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAge}`
  ];
  if(clear)parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  if(secure)parts.push('Secure');
  return parts.join('; ');
}
