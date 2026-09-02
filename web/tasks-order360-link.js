// Open linked Order 360 directly from the Tasks page.
(function(){
  const ORDER_RE=/\bKST-\d{4}-\d{7}\b/i;
  function isTasksPage(){return [...document.querySelectorAll('h1')].some(x=>x.textContent.trim()==='Задачи')}
  function findNumberElement(root=document){
    return [...root.querySelectorAll('main *')].filter(el=>el.children.length===0&&ORDER_RE.test((el.textContent||'').trim()));
  }
  function rowFor(numberEl){
    let p=numberEl.parentElement;
    while(p&&p!==document.body){
      const txt=p.textContent||'';
      const n=(txt.match(ORDER_RE)||[]).length;
      const kids=p.children?.length||0;
      if(n===1&&kids>=3&&kids<=8&&p.getBoundingClientRect().width>600)return p;
      if(p.matches?.('main,.simpleTable,.shell'))break;
      p=p.parentElement;
    }
    return numberEl.parentElement;
  }
  function open(number){window.dispatchEvent(new CustomEvent('profi24:open-order360',{detail:{number}}))}
  function bind(){
    if(!isTasksPage())return;
    findNumberElement().forEach(el=>{
      const number=(el.textContent||'').match(ORDER_RE)?.[0]?.toUpperCase();
      if(!number)return;
      const row=rowFor(el);if(!row)return;
      row.dataset.order360Number=number;
      row.style.cursor='pointer';
      row.title='Открыть заказ '+number;
      if(!row.dataset.order360Bound){
        row.dataset.order360Bound='1';
        row.addEventListener('click',e=>{
          if(e.target.closest('button,input,select,textarea,a,label'))return;
          const n=row.dataset.order360Number;if(!n)return;
          e.preventDefault();e.stopPropagation();open(n);
        });
      }
      if(!el.dataset.order360Bound){
        el.dataset.order360Bound='1';
        el.style.cursor='pointer';
        el.style.textDecoration='underline';
        el.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();open(number)});
      }
    });
  }
  let t;new MutationObserver(()=>{clearTimeout(t);t=setTimeout(bind,80)}).observe(document.body,{childList:true,subtree:true});
  window.addEventListener('load',()=>setTimeout(bind,100));
  setInterval(bind,1000);setTimeout(bind,200);
})();