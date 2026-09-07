// Keep the order attachment picker aligned with the server-side allowlist.
(function(){
  const SAFE_ACCEPT='image/jpeg,image/png,image/webp,image/heic,image/heif,.pdf';
  function apply(){
    document.querySelectorAll('input[data-file-input]').forEach(input=>{
      if(input.dataset.secureUploadPolicy==='1')return;
      input.accept=SAFE_ACCEPT;
      input.dataset.secureUploadPolicy='1';
    });
    document.querySelectorAll('.orderFilesHead small').forEach(node=>{
      if(/до\s*8\s*МБ/i.test(node.textContent||''))node.textContent='JPEG, PNG, WebP, HEIC/HEIF или PDF · до 8 МБ';
    });
  }
  apply();
  let timer;
  new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(apply,80)}).observe(document.documentElement,{childList:true,subtree:true});
})();
