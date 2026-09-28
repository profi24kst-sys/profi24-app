export const MAX_UPLOAD_BYTES=10*1024*1024;
const COMPRESS_FROM_BYTES=2*1024*1024;
const MAX_DIMENSION=2200;

const supportedImage=file=>/^image\/(jpeg|png|webp)$/i.test(file?.type||'');

function canvasBlob(canvas,type,quality){
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Не удалось сжать изображение')),type,quality));
}

export async function prepareImageUpload(file){
  if(!file)throw new Error('Файл не выбран');
  if(file.size<=COMPRESS_FROM_BYTES)return file;
  if(!supportedImage(file)){
    if(file.size>MAX_UPLOAD_BYTES)throw new Error('Максимальный размер файла 10 МБ');
    return file;
  }

  let bitmap;
  try{bitmap=await createImageBitmap(file)}catch{
    if(file.size>MAX_UPLOAD_BYTES)throw new Error('Фото больше 10 МБ и не может быть автоматически сжато этим браузером');
    return file;
  }

  const scale=Math.min(1,MAX_DIMENSION/Math.max(bitmap.width,bitmap.height));
  const width=Math.max(1,Math.round(bitmap.width*scale)),height=Math.max(1,Math.round(bitmap.height*scale));
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d',{alpha:false});ctx.drawImage(bitmap,0,0,width,height);bitmap.close?.();

  let blob=await canvasBlob(canvas,'image/webp',.82).catch(()=>null);
  let ext='.webp',type='image/webp';
  if(!blob){blob=await canvasBlob(canvas,'image/jpeg',.82);ext='.jpg';type='image/jpeg';}
  if(blob.size>=file.size&&file.size<=MAX_UPLOAD_BYTES)return file;
  if(blob.size>MAX_UPLOAD_BYTES)throw new Error('После сжатия фото всё ещё больше 10 МБ');

  const base=String(file.name||'photo').replace(/\.[^.]+$/,'')||'photo';
  return new File([blob],base+ext,{type,lastModified:file.lastModified||Date.now()});
}

export function fileToDataUrl(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error('Не удалось прочитать файл'));
    reader.onload=()=>resolve(reader.result);
    reader.readAsDataURL(file);
  });
}
