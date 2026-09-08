// Keep one complaints entry for office roles while preserving the legacy read-only entry for technical roles.
const currentRole=()=>{try{return JSON.parse(localStorage.getItem('user')||'null')?.role||null}catch{return null}};
const superseded=()=>['OWNER','SUPERVISOR','ACCOUNTANT','MANAGER'].includes(currentRole());

function legacyButtons(){
  const nav=document.querySelector('.shell>aside nav')||document.querySelector('aside nav');
  if(!nav)return [];
  return [...nav.querySelectorAll(':scope > button:not([data-core-nav-id])')].filter(button=>{
    const label=(button.querySelector('span')?.textContent||button.textContent||'').trim();
    return /^Рекламации(?:\s|$)/.test(label);
  });
}
function syncLegacyComplaintsNav(){
  for(const button of legacyButtons()){
    if(superseded()){
      button.dataset.complaintsLegacy='1';
      button.hidden=true;
      button.setAttribute('aria-hidden','true');
      button.style.setProperty('display','none','important');
    }else if(button.dataset.complaintsLegacy==='1'){
      delete button.dataset.complaintsLegacy;
      button.hidden=false;
      button.removeAttribute('aria-hidden');
      button.style.removeProperty('display');
    }
  }
}

const observer=new MutationObserver(syncLegacyComplaintsNav);
observer.observe(document.documentElement,{childList:true,subtree:true});
for(const event of ['profi24:core-ui-ready','profi24:rbac-ready','profi24:ui-refresh'])window.addEventListener(event,syncLegacyComplaintsNav);
window.addEventListener('storage',e=>{if(e.key==='user')syncLegacyComplaintsNav()});
setInterval(syncLegacyComplaintsNav,250);
queueMicrotask(syncLegacyComplaintsNav);
