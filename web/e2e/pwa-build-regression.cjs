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
const svgIconPath=path.join(dist,'icons','profi24.svg');
const icon192Path=path.join(dist,'icons','profi24-192.png');
const icon512Path=path.join(dist,'icons','profi24-512.png');

for(const file of [indexPath,manifestPath,swPath,installJsPath,installCssPath,svgIconPath,icon192Path,icon512Path]){
  if(!fs.existsSync(file)) fail(`missing build artifact ${path.relative(dist,file)}`);
}

const html=fs.readFileSync(indexPath,'utf8');
for(const marker of ['rel="manifest"','href="/manifest.webmanifest"','src="/pwa-install.js"','href="/pwa-install.css"','name="theme-color"','href="/icons/profi24-192.png"']){
  if(!html.includes(marker)) fail(`index.html missing ${marker}`);
}

let manifest;
try{manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'))}catch(error){fail(`manifest is not valid JSON: ${error.message}`)}
if(manifest.name!=='PROFI24 CRM') fail('unexpected manifest name');
if(manifest.start_url!=='/' || manifest.scope!=='/') fail('manifest must install the main CRM scope');
if(manifest.display!=='standalone') fail('manifest display must be standalone');
if(!manifest.theme_color || !manifest.background_color) fail('manifest colors are required');
if(!Array.isArray(manifest.icons) || manifest.icons.length<2) fail('manifest must provide install icons');
const bySize=new Map(manifest.icons.map((icon)=>[icon.sizes,icon]));
for(const size of ['192x192','512x512']){
  const icon=bySize.get(size);
  if(!icon) fail(`manifest missing ${size} icon`);
  if(icon.type!=='image/png') fail(`${size} icon must be PNG`);
}

const sw=fs.readFileSync(swPath,'utf8');
if(!sw.includes("addEventListener('fetch'")) fail('service worker must handle fetch so it can control the CRM scope');
if(sw.includes('caches.open(')) fail('service worker must not persist authenticated CRM responses');

const installJs=fs.readFileSync(installJsPath,'utf8');
if(!installJs.includes("serviceWorker.register('/sw.js'")) fail('install helper must register the service worker');
if(!installJs.includes('beforeinstallprompt')) fail('install helper must support the browser install prompt');
if(!installJs.includes('appinstalled')) fail('install helper must handle successful installation');

console.log('PWA_BUILD_REGRESSION: ok');
