const PWA_DISMISS_KEY='profi24:pwa-install-dismissed';
const isStandalone=window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone===true;
const isIOS=/iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
let deferredPrompt=null;
let banner=null;

function dismissed(){
  try{return sessionStorage.getItem(PWA_DISMISS_KEY)==='1'}catch{return false}
}

function markDismissed(){
  try{sessionStorage.setItem(PWA_DISMISS_KEY,'1')}catch{}
}

function removeBanner(){
  banner?.remove();
  banner=null;
}

function createBanner(mode){
  if(isStandalone || dismissed() || banner) return;
  const wrap=document.createElement('aside');
  wrap.className='p24-pwa-install';
  wrap.setAttribute('role','status');
  wrap.setAttribute('aria-live','polite');

  const copy=document.createElement('div');
  copy.className='p24-pwa-install__copy';
  const title=document.createElement('strong');
  title.textContent='PROFI24 CRM';
  const text=document.createElement('span');
  text.textContent=mode==='ios'
    ? 'Чтобы установить на iPhone: нажмите «Поделиться» → «На экран Домой».'
    : 'Установите CRM как приложение — она будет открываться отдельным окном.';
  copy.append(title,text);

  const actions=document.createElement('div');
  actions.className='p24-pwa-install__actions';

  if(mode==='native'){
    const install=document.createElement('button');
    install.type='button';
    install.className='p24-pwa-install__primary';
    install.textContent='Установить';
    install.addEventListener('click',async()=>{
      if(!deferredPrompt) return;
      install.disabled=true;
      try{
        await deferredPrompt.prompt();
        const choice=await deferredPrompt.userChoice;
        if(choice?.outcome==='accepted') removeBanner();
      }finally{
        deferredPrompt=null;
        install.disabled=false;
      }
    });
    actions.append(install);
  }

  const close=document.createElement('button');
  close.type='button';
  close.className='p24-pwa-install__close';
  close.setAttribute('aria-label','Скрыть предложение установки');
  close.textContent='×';
  close.addEventListener('click',()=>{
    markDismissed();
    removeBanner();
  });
  actions.append(close);

  wrap.append(copy,actions);
  document.body.append(wrap);
  banner=wrap;
}

if('serviceWorker' in navigator){
  window.addEventListener('load',()=>{
    navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch((error)=>{
      console.warn('PROFI24 PWA service worker registration failed',error);
    });
  },{once:true});
}

window.addEventListener('beforeinstallprompt',(event)=>{
  event.preventDefault();
  deferredPrompt=event;
  createBanner('native');
});

window.addEventListener('appinstalled',()=>{
  deferredPrompt=null;
  removeBanner();
});

if(isIOS && !isStandalone){
  window.addEventListener('load',()=>setTimeout(()=>createBanner('ios'),700),{once:true});
}

window.Profi24PWA={
  isStandalone:()=>window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone===true,
  canInstall:()=>Boolean(deferredPrompt),
  showInstall:()=>deferredPrompt ? createBanner('native') : (isIOS ? createBanner('ios') : undefined)
};
