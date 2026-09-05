import fs from 'fs';
import path from 'path';
import {spawnSync} from 'child_process';
import {fileURLToPath} from 'url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const files=fs.readdirSync(dir,{recursive:true}).filter(x=>x.endsWith('.js')&&x!=='check-all.js').sort();
let failed=false;
for(const file of files){const full=path.join(dir,file);const r=spawnSync(process.execPath,['--check',full],{stdio:'inherit'});if(r.status!==0)failed=true}
if(failed)process.exit(1);
console.log(`Syntax OK: ${files.length} backend files`);
