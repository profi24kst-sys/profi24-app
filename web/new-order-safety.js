// Keep each new order clean: customer history must not silently become order data.
(function(){
  let lastModal=null, customerSelect=null, equipmentSelect=null;
  const text=e=>(e?.textContent||'').replace(/\s+/g,' ').trim();
  function modal(){return [...document.querySelectorAll('.modal,.modalbox,.newOrder,.overlay>div,[role="dialog"]')].find(x=>/нов(ый|ая)\s+(заказ|заявк)/i.test(text(x)))||[...document.querySelectorAll('body>div div')].find(x=>/нов(ый|ая)\s+(заказ|заявк)/i.test(text(x))&&x.querySelectorAll('input,select,textarea').length>=3)}
  function labelled(root,re){for(const l of root.querySelectorAll('label')){if(re.test(text(l))){const c=l.querySelector('select,input,textarea');if(c)return c}}return null}
  function detect(root){
    customerSelect=labelled(root,/клиент/i);
    equipmentSelect=labelled(root,/техник|оборудован|устройств/i);
    if(!customerSelect){const sels=[...root.querySelectorAll('select')];customerSelect=sels.find(s=>[...s.options].some(o=>/клиент|выберите клиента/i.test(o.textContent)))||sels[0]||null}
    if(!equipmentSelect){const sels=[...root.querySelectorAll('select')].filter(s=>s!==customerSelect);equipmentSelect=sels.find(s=>[...s.options].some(o=>/техник|оборудован|устройств|s\/n|серийн/i.test(o.textContent)))||sels[0]||null}
  }
  function resetControl(c){if(!c)return;c.value='';c.dispatchEvent(new Event('input',{bubbles:true}));c.dispatchEvent(new Event('change',{bubbles:true}))}
  function clearOrderSpecific(root){
    resetControl(equipmentSelect);
    for(const l of root.querySelectorAll('label')){
      if(/неисправ|причин.{0,8}обращ|жалоб|комментар|описан.{0,8}проблем/i.test(text(l))){const c=l.querySelector('input,textarea');if(c)resetControl(c)}
    }
    root.dataset.equipmentExplicit='0';
  }
  function bind(root){if(root===lastModal)return;lastModal=root;detect(root);root.dataset.equipmentExplicit='0';
    customerSelect?.addEventListener('change',()=>{detect(root);clearOrderSpecific(root)},true);
    equipmentSelect?.addEventListener('change',e=>{if(e.isTrusted||equipmentSelect.value)root.dataset.equipmentExplicit=equipmentSelect.value?'1':'0'},true)
  }
  const nativeFetch=window.fetch.bind(window);
  window.fetch=async function(input,init){
    const url=typeof input==='string'?input:(input?.url||''),method=String(init?.method||'GET').toUpperCase();
    if(method==='POST'&&/\/api\/v1\/requests(?:\?|$)/.test(url)&&typeof init?.body==='string'){
      try{const b=JSON.parse(init.body),m=modal();if(m&&m.dataset.equipmentExplicit!=='1'&&b.equipment_id){delete b.equipment_id;init={...init,body:JSON.stringify(b)}}}catch{}
    }
    return nativeFetch(input,init)
  };
  let t;new MutationObserver(()=>{clearTimeout(t);t=setTimeout(()=>{const m=modal();if(m)bind(m)},80)}).observe(document.body,{childList:true,subtree:true});setInterval(()=>{const m=modal();if(m)bind(m)},1200);
})();