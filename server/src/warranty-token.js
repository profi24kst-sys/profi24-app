import crypto from 'node:crypto';

const placeholder=/change-me|change-this|replace-with|example|changeme|qwerty|password/i;
const tokenSecret=()=>{
 const configured=String(process.env.WARRANTY_TOKEN_SECRET||'').trim();
 if(configured){
  if(process.env.NODE_ENV==='production'&&placeholder.test(configured))throw new Error('WARRANTY_TOKEN_SECRET must be a non-placeholder production secret');
  return configured;
 }
 if(process.env.NODE_ENV==='production')throw new Error('WARRANTY_TOKEN_SECRET is required in production');
 return 'dev-warranty-secret-change-me';
};
const signature=id=>crypto.createHmac('sha256',tokenSecret()).update(`warranty:${id}`).digest('base64url');

export function warrantyPublicToken(value){
 const id=Number(value);
 if(!Number.isSafeInteger(id)||id<1)throw new Error('Invalid warranty id');
 return `v2.${id}.${signature(id)}`;
}

export function warrantyIdFromPublicToken(raw){
 const match=String(raw||'').match(/^v2\.([1-9]\d*)\.([A-Za-z0-9_-]{43})$/);
 if(!match)return null;
 const id=Number(match[1]);if(!Number.isSafeInteger(id)||id<1)return null;
 const expected=Buffer.from(signature(id)),actual=Buffer.from(match[2]);
 if(expected.length!==actual.length||!crypto.timingSafeEqual(expected,actual))return null;
 return id;
}
