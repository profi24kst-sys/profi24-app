const MAX_FILE_BYTES=10*1024*1024;

const TYPE_DEFS=Object.freeze([
  {mime:'image/jpeg',ext:'.jpg',extensions:new Set(['.jpg','.jpeg']),declared:new Set(['image/jpeg','image/jpg'])},
  {mime:'image/png',ext:'.png',extensions:new Set(['.png']),declared:new Set(['image/png'])},
  {mime:'image/webp',ext:'.webp',extensions:new Set(['.webp']),declared:new Set(['image/webp'])},
  {mime:'image/heic',ext:'.heic',extensions:new Set(['.heic','.heif','.hif']),declared:new Set(['image/heic','image/heif','image/heic-sequence','image/heif-sequence'])},
  {mime:'application/pdf',ext:'.pdf',extensions:new Set(['.pdf']),declared:new Set(['application/pdf'])}
]);

const GENERIC_MIME=new Set(['','application/octet-stream','binary/octet-stream']);
const HEIF_BRANDS=new Set(['heic','heix','hevc','hevx','heim','heis','heif','mif1','msf1']);

export function fileSecurityError(code,message,statusCode=422){return Object.assign(new Error(message),{code,statusCode});}

function hasPrefix(buf,bytes){if(buf.length<bytes.length)return false;return bytes.every((v,i)=>buf[i]===v);}
function ascii(buf,start,end){return buf.subarray(start,end).toString('ascii');}

export function detectSafeFileType(buf){
  if(!Buffer.isBuffer(buf)||!buf.length)return null;
  if(buf.length>=3&&hasPrefix(buf,[0xff,0xd8,0xff]))return TYPE_DEFS[0];
  if(buf.length>=8&&hasPrefix(buf,[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))return TYPE_DEFS[1];
  if(buf.length>=12&&ascii(buf,0,4)==='RIFF'&&ascii(buf,8,12)==='WEBP')return TYPE_DEFS[2];
  if(buf.length>=12&&ascii(buf,4,8)==='ftyp'){
    for(let p=8;p+4<=Math.min(buf.length,64);p+=4){if(HEIF_BRANDS.has(ascii(buf,p,p+4)))return TYPE_DEFS[3];}
  }
  if(buf.length>=5&&ascii(buf,0,5)==='%PDF-')return TYPE_DEFS[4];
  return null;
}

export function sanitizeOriginalName(value,fallback='file'){
  const raw=String(value??'').replace(/\\/g,'/').split('/').pop()||fallback;
  const clean=raw.replace(/[\u0000-\u001f\u007f]/g,'').trim().replace(/\s+/g,' ');
  return (clean||fallback).slice(0,180);
}

function extensionOf(name){const m=String(name).toLowerCase().match(/(\.[a-z0-9]{1,8})$/);return m?.[1]||'';}

export function inspectUpload({buffer,declaredMime='',originalName='',maxBytes=MAX_FILE_BYTES}={}){
  if(!Buffer.isBuffer(buffer)||buffer.length===0)throw fileSecurityError('EMPTY_FILE','Файл пустой или повреждён');
  if(buffer.length>maxBytes)throw fileSecurityError('FILE_TOO_LARGE',`Максимальный размер файла ${Math.floor(maxBytes/1024/1024)} МБ`);
  const detected=detectSafeFileType(buffer);
  if(!detected)throw fileSecurityError('UNSUPPORTED_FILE_TYPE','Разрешены только JPEG, PNG, WebP, HEIC/HEIF и PDF');
  const declared=String(declaredMime||'').split(';')[0].trim().toLowerCase();
  if(!GENERIC_MIME.has(declared)&&!detected.declared.has(declared)){
    throw fileSecurityError('FILE_TYPE_MISMATCH','Заявленный тип файла не совпадает с его содержимым');
  }
  const safeName=sanitizeOriginalName(originalName,`file${detected.ext}`);
  const ext=extensionOf(safeName);
  if(ext&&!detected.extensions.has(ext)){
    throw fileSecurityError('FILE_EXTENSION_MISMATCH','Расширение файла не совпадает с его содержимым');
  }
  return {mime:detected.mime,extension:detected.ext,originalName:ext?safeName:`${safeName}${detected.ext}`,size:buffer.length};
}

export function decodeDataUrl(value,{maxEncodedChars=14*1024*1024}={}){
  const raw=String(value||'');
  if(raw.length>maxEncodedChars)throw fileSecurityError('FILE_TOO_LARGE','Файл превышает допустимый размер');
  const match=raw.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/);
  if(!match||match[2].length%4!==0)throw fileSecurityError('INVALID_FILE_ENCODING','Некорректный формат файла');
  let buffer;
  try{buffer=Buffer.from(match[2],'base64');}catch{throw fileSecurityError('INVALID_FILE_ENCODING','Некорректный base64 файла');}
  if(!buffer.length)throw fileSecurityError('EMPTY_FILE','Файл пустой или повреждён');
  return {declaredMime:match[1].toLowerCase(),buffer};
}

export function safeDownloadName(value,extension=''){
  const name=sanitizeOriginalName(value,`file${extension}`);
  return extension&& !name.toLowerCase().endsWith(extension.toLowerCase())?`${name}${extension}`:name;
}

export function contentDispositionAttachment(name){
  const safe=sanitizeOriginalName(name,'file').replace(/["\\]/g,'_');
  const asciiName=safe.replace(/[^\x20-\x7e]/g,'_');
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

export const SAFE_UPLOAD_MIMES=Object.freeze(TYPE_DEFS.map(x=>x.mime));
export {MAX_FILE_BYTES};
