// PROFI24 Order360: explicit PHOTO_BEFORE evidence upload.
(function(){
  const ACCEPT='.jpg,.jpeg,.png,.webp,.heic,.heif,.hif';
  const allowedRoles=new Set(['OWNER','SUPERVISOR','MANAGER','ENGINEER','TRAINEE']);
  const user=()=>{try{return JSON.parse(localStorage.getItem('user')||'null')}catch{return null}};
  const token=()=>localStorage.getItem('token')||'';
  function toData(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('Не удалось прочитать файл'));reader.onload=()=>resolve(reader.result);reader.readAsDataURL(file)})}
  async function upload(input){
    const file=input.files?.[0],root=input.closest('.o360');
    const requestId=Number(root?.dataset.currentRequestId||0);
    if(!file||!requestId)return;
    if(file.size>8*1024*1024){input.value='';alert('Файл больше 8 МБ');return;}
    const label=input.closest('[data-o360-photo-before]');
    try{
      label?.classList.add('busy');
      const data=await toData(file);
      const response=await fetch(`/documents-api/v1/requests/${requestId}/files`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token()}`},body:JSON.stringify({name:file.name,kind:'PHOTO_BEFORE',data})});
      const json=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(json.error?.message||`Ошибка ${response.status}`);
      window.dispatchEvent(new CustomEvent('profi24:request-updated',{detail:{id:requestId}}));
    }catch(error){alert(error.message||'Не удалось загрузить фото')}finally{if(label)label.classList.remove('busy');input.value=''}
  }
  function mount(){
    if(!allowedRoles.has(String(user()?.role||'').toUpperCase()))return;
    document.querySelectorAll('.o360PhotoActions').forEach(host=>{
      if(host.querySelector('[data-o360-photo-before]'))return;
      const label=document.createElement('label');
      label.setAttribute('data-o360-photo-before','');
      label.className='o360Upload';
      label.innerHTML=`<span>Фото до ремонта</span><input hidden type="file" accept="${ACCEPT}">`;
      const input=label.querySelector('input');
      input.addEventListener('change',()=>upload(input));
      host.insertBefore(label,host.firstChild);
    });
  }
  let timer;
  new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(mount,80)}).observe(document.body,{childList:true,subtree:true});
  setTimeout(mount,400);
})();
