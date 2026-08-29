// PROFI24 session role synchronizer.
// Standalone addon React roots read localStorage.user only when they render.
// After login or role/account switch, reload once so every addon evaluates the same current role.
(function(){
  let lastRaw=localStorage.getItem('user')||'';
  function parse(raw){try{return raw?JSON.parse(raw):null}catch{return null}}
  let last=parse(lastRaw);
  let reloading=false;
  setInterval(()=>{
    if(reloading)return;
    const raw=localStorage.getItem('user')||'';
    if(raw===lastRaw)return;
    const prev=last;
    const next=parse(raw);
    lastRaw=raw;
    last=next;
    // Logout may stay on the login screen without a page reload.
    if(!next)return;
    // Login from an anonymous session, or switch to another account/role:
    // reload once so all independently mounted addon roots get the correct role.
    const changed=!prev||String(prev.id??prev.email??'')!==String(next.id??next.email??'')||prev.role!==next.role;
    if(changed){
      reloading=true;
      setTimeout(()=>location.reload(),80);
    }
  },250);
})();
