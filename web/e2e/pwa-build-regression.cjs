const fs=require('fs');
const path=require('path');

function fail(message){
  console.error(`PWA_BUILD_REGRESSION: ${message}`);
  process.exit(1);
}

const dist=path.resolve(__dirname,'..','dist');
const indexPath=path.join(dist,'index.html');
const manifestPath=path.join(dist,'manifest.webmanifest');
const swPath=path.join(dist,'sw.js');
const installJsPath=path.join(dist,'pwa-install.js');
const installCssPath=path.join(dist,'pwa-install.css');
const iconPath=path.join(dist,'icons','profi24.svg');

for(const file of [indexPath,manifestPath,swPath,installJsPath,installCssPath,iconPath]){
  if(!fs.existsSync(file)) fail(`missing build artifact ${path.relative(dist,file)}`);
}

const html=fs.readFileSync(indexPath,'utf8');
for(const marker of ['rel="manifest"','href="/manifest.webmanifest"','src="/pwa-install.js"','href="/pwa-install.css"','name="theme-color"']){
  if(!html.includes(marker)) fail(`index.html missing ${marker}`);
}

let manifest;
try{manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'))}catch(error){fail(`manifest is not valid JSON: ${error.message}`)}
if(manifest.name!=='PROFI24 CRM') fail('unexpected manifest name');
if(manifest.start_url!=='/' || manifest.scope!=='/') fail('manifest must install the main CRM scope');
if(manifest.display!=='standalone') fail('manifest display must be standalone');
if(!manifest.theme_color || !manifest.background_color) fail('manifest colors are required');
if(!Array.isArray(manifest.icons) || manifest.icons.length<2) fail('manifest must provide install icons');
const sizes=new Set(manifest.icons.map((icon)=>icon.sizes));
if(!sizes.has('192x192') || !sizes.has('512x512')) fail('manifest must provide 192x192 and 512x512 icons');

const sw=fs.readFileSync(swPath,'utf8');
if(!sw.includes("addEventListener('fetch'")) fail('service worker must handle fetch so it can control the CRM scope');
if(sw.includes('caches.open(')) fail('service worker must not persist authenticated CRM responses');

const installJs=fs.readFileSync(installJsPath,'utf8');
if(!installJs.includes("serviceWorker.register('/sw.js'")) fail('install helper must register the service worker');
if(!installJs.includes('beforeinstallprompt')) fail('install helper must support the browser install prompt');
if(!installJs.includes('appinstalled')) fail('install helper must handle successful installation');

console.log('PWA_BUILD_REGRESSION: ok');
