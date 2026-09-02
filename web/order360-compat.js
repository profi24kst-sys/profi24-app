// Safe compatibility bridge for legacy Order 360 addons.
// Keeps a hidden technical current-order marker outside React-owned DOM and refreshes React after external writes.
(function(){
  let marker=null,lastId='';
  function state(){
    const root=document.querySelector('.o360');
    const id=String(window.Profi24O360State?.id||root?.dataset?.currentRequestId||'');
    const number=document.querySelector('.o360Hero small')?.textContent?.trim()||'';
    return{root,id,number};
  }
  function ensure(){
    if(marker&&document.body.contains(marker))return marker;
    marker=document.createElement('div');
    marker.className='o360List o360CompatList';
    marker.setAttribute('aria-hidden','true');
    marker.style.cssText='position:fixed!important;left:-10000px!important;top:-10000px!important;width:1px!important;height:1px!important;overflow:hidden!important;opacity:0!important;pointer-events:none!important;padding:0!important;border:0!important';
    marker.innerHTML='<button type="button" class="on"><b></b></button>';
    document.body.appendChild(marker);
    return marker;
  }
  function sync(){
    const s=state();
    if(!s.root){marker?.remove();marker=null;lastId='';return}
    if(!s.id)return;
    const m=ensure(),b=m.querySelector('button');
    b.dataset.id=s.id;b.querySelector('b').textContent=s.number;lastId=s.id;
  }
  function refreshReact(id){
    const s=state();
    if(!s.root||!s.id)return;
    if(id&&String(id)!==String(s.id))return;
    sync();
    setTimeout(()=>{
      const top=s.root.querySelector('.o360Top');
      const refresh=top?.querySelector('button');
      refresh?.click();
    },60);
  }
  window.addEventListener('profi24:o360-current',sync);
  window.addEventListener('profi24:open-order360',()=>setTimeout(sync,30));
  window.addEventListener('profi24:request-updated',e=>refreshReact(e.detail?.id||''));
  let t;new MutationObserver(()=>{clearTimeout(t);t=setTimeout(sync,80)}).observe(document.body,{childList:true,subtree:true});
  setInterval(()=>{if(document.querySelector('.o360'))sync()},1500);
  setTimeout(sync,300);
})();