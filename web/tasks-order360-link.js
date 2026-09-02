// Open linked Order 360 directly from the Tasks page.
(function(){
  const ORDER_RE=/\bKST-\d{4}-\d{7}\b/i;
  function isTasksPage(){return [...document.querySelectorAll('main h1,main header h1')].some(x=>x.textContent.trim()==='Задачи')}
  function visualRows(){return [...document.querySelectorAll('main .simpleRow,main .simple,main .taskRow,main .trow,main [class*="row"],main [class*="Row"]')].filter(el=>ORDER_RE.test(el.textContent||''))}
  function smallestRow(target){let el=target?.nodeType===3?target.parentElement:target;let best=null;while(el&&el!==document.body){if(el.matches?.('button,a,input,select,textarea,label'))return null;const txt=el.textContent||'';if(ORDER_RE.test(txt)){const r=el.getBoundingClientRect?.();if(r&&r.width>300&&r.height>=28&&r.height<180)best=el}if(el.matches?.('main,.shell,.simpleTable,section'))break;el=el.parentElement}return best}
  function open(number){if(!number)return;const fire=()=>window.dispatchEvent(new CustomEvent('profi24:open-order360',{detail:{number}}));fire();setTimeout(fire,80);setTimeout(fire,250)}
  function bind(row){if(row.dataset.order360TaskLink)return;const n=(row.textContent||'').match(ORDER_RE)?.[0]?.toUpperCase();if(!n)return;row.dataset.order360TaskLink='1';row.dataset.orderNumber=n;row.title='Открыть заказ '+n;row.style.cursor='pointer';row.addEventListener('click',e=>{if(e.target.closest?.('button,a,input,select,textarea,label'))return;e.preventDefault();e.stopPropagation();open(n)},true)}
  function mark(){if(!isTasksPage())return;visualRows().forEach(bind);document.querySelectorAll('main *').forEach(el=>{if(!ORDER_RE.test(el.textContent||''))return;const row=smallestRow(el);if(row)bind(row)})}
  document.addEventListener('pointerup',e=>{if(!isTasksPage()||e.target.closest?.('button,a,input,select,textarea,label'))return;const row=smallestRow(e.target);const n=(row?.textContent||'').match(ORDER_RE)?.[0]?.toUpperCase();if(n){e.preventDefault();e.stopPropagation();open(n)}},true);
  let t;new MutationObserver(()=>{clearTimeout(t);t=setTimeout(mark,80)}).observe(document.body,{childList:true,subtree:true});setInterval(mark,1200);setTimeout(mark,250);
})();