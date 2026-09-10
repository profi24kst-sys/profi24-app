const CRM_PWA_PREFIX='profi24-crm-pwa-';

self.addEventListener('install',()=>{
  self.skipWaiting();
});

self.addEventListener('activate',(event)=>{
  event.waitUntil((async()=>{
    const names=await caches.keys();
    await Promise.all(names.filter((name)=>name.startsWith(CRM_PWA_PREFIX)).map((name)=>caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch',(event)=>{
  const request=event.request;
  const url=new URL(request.url);
  if(request.method!=='GET' || url.origin!==self.location.origin) return;

  // CRM contains customer and financial data. Keep requests network-backed and
  // deliberately avoid Cache Storage so authenticated responses are not persisted.
  event.respondWith(fetch(request));
});
