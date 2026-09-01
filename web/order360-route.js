// Open Order 360 directly from the orders table without rendering the legacy order card first.
(function(){
  function numberFromRow(row){const text=row?.innerText||row?.textContent||'';return text.match(/KST-\d{4}-\d+/i)?.[0]||''}
  function onClick(e){const row=e.target.closest?.('.trow');if(!row)return;const number=numberFromRow(row);if(!number)return;e.preventDefault();e.stopPropagation();e.stopImmediatePropagation?.();window.dispatchEvent(new CustomEvent('profi24:open-order360',{detail:{number}}))}
  document.addEventListener('click',onClick,true);
})();