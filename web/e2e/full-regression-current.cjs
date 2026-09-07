const fs=require('fs');
const path=require('path');
const {spawnSync}=require('child_process');

const sourcePath=path.join(__dirname,'full-regression.cjs');
const tempPath=path.join(__dirname,'.full-regression-current.tmp.cjs');
let source=fs.readFileSync(sourcePath,'utf8');

const pattern=/    \/\/ Exact browser workflow from the reported bug:[\s\S]*?    \/\/ Completion must open for OWNER with finance controls available\./;
const replacement=`    // Current Order360 workflow: upload PHOTO_BEFORE through the visible evidence action.
    await owner.goto(BASE,{waitUntil:'domcontentloaded'});await owner.waitForTimeout(500);
    await openOrder(owner,order.number);
    const beforeInput=owner.locator('[data-o360-photo-before] input[type="file"]').first();
    await beforeInput.waitFor({state:'attached',timeout:8000});
    await beforeInput.setInputFiles({name:'browser-before.png',mimeType:'image/png',buffer:png});
    let beforeUploaded=false;
    for(let i=0;i<30;i++){
      const filesNow=await api(owner,\`/documents-api/v1/requests/\${order.id}/files\`);
      if(filesNow.status===200&&filesNow.data?.some(file=>file.original_name==='browser-before.png'&&file.kind==='PHOTO_BEFORE')){beforeUploaded=true;break;}
      await owner.waitForTimeout(200);
    }
    if(!beforeUploaded)fail('Order360 PHOTO_BEFORE upload did not persist with the canonical attachment kind');

    // Completion must open for OWNER with finance controls available.`;

if(!pattern.test(source)){
  console.error('Current regression adapter could not locate the legacy attachment workflow block.');
  process.exit(1);
}
source=source.replace(pattern,replacement);
fs.writeFileSync(tempPath,source);
const result=spawnSync(process.execPath,[tempPath],{stdio:'inherit',env:process.env});
try{fs.unlinkSync(tempPath)}catch{}
if(result.error)throw result.error;
process.exit(result.status??1);
