// Open linked Order 360 directly from the Tasks page.
(function(){
  const ORDER_RE=/\bKST-\d{4}-\d{7}\b/i;
  function isTasksPage(){
    const h=[...document.querySelectorAll('main h1, main header h1')].find(x=>x.textContent.trim()==='Задачи');
    return !!h;
  }
  function taskRowFrom(target){
    let el=target;
    while(el&&el!==document.body){
      if(el.matches?.('button,a,input,select,textarea,label')) return null;
      const txt=el.textContent||'';
      if(ORDER_RE.test(txt)){
        const parent=el.parentElement;
        if(!parent||!ORDER_RE.test(parent.textContent||'')) return el;
        // Prefer the widest row-like ancestor but stop before main/page containers.
        let row=el;
        let p=parent;
        for(let i=0;i<5&&p;i++,p=p.parentElement){
          if(p.matches?.('main,section.simpleTable,.simpleTable,.shell')) break;
          if(ORDER_RE.test(p.textContent||'')) row=p;
        }
        return row;
      }
      el=el.parentElement;
    }
    return null;
  }
  function numberFrom(row){return (row?.textContent||'').match(ORDER_RE)?.[0]?.toUpperCase()||''}
  function mark(){
    if(!isTasksPage()) return;
    document.querySelectorAll('main *').forEach(el=>{
      if(el.children.length>8) return;
      const n=(el.textContent||'').match(ORDER_RE)?.[0];
      if(!n) return;
      const row=taskRowFrom(el);
      if(row&&!row.dataset.order360TaskLink){
        row.dataset.order360TaskLink='1';
        row.title='Открыть заказ '+n;
        row.style.cursor='pointer';
      }
    });
  }
  document.addEventListener('pointerdown',e=>{
    if(!isTasksPage()) return;
    if(e.target.closest?.('button,a,input,select,textarea,label')) return;
    const row=taskRowFrom(e.target);
    const number=numberFrom(row);
    if(!row||!number) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    window.dispatchEvent(new CustomEvent('profi24:open-order360',{detail:{number}}));
  },true);
  let t;
  new MutationObserver(()=>{clearTimeout(t);t=setTimeout(mark,120)}).observe(document.body,{childList:true,subtree:true});
  setInterval(mark,2000);
  setTimeout(mark,400);
})();