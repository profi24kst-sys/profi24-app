// Prevent stale data from a previous order from being displayed while another order is loading.
(function(){
  let lastId='';
  function selectedId(){return document.querySelector('.o360List button.on')?.dataset?.id||''}
  function clearStale(){
    const id=selectedId();
    if(!id||id===lastId)return;
    lastId=id;
    // Clear request-specific async blocks immediately. They will repopulate from the new request only.
    document.querySelectorAll('.o360Event').forEach(x=>x.remove());
    document.querySelectorAll('[data-o360-workflow-events]>*').forEach(x=>x.remove());
    document.querySelectorAll('.o360Approval .o360Approved,.o360Files a,.o360ExpenseRow').forEach(x=>x.remove());
    window.dispatchEvent(new CustomEvent('profi24:order360-switched',{detail:{id}}));
  }
  document.addEventListener('pointerdown',e=>{
    const b=e.target.closest?.('.o360List button[data-id]');
    if(!b)return;
    const id=b.dataset.id||'';
    if(id&&id!==lastId){
      lastId='';
      queueMicrotask(clearStale);
      setTimeout(clearStale,0);
    }
  },true);
  let t;
  new MutationObserver(()=>{clearTimeout(t);t=setTimeout(clearStale,30)}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
  setTimeout(clearStale,300);
})();