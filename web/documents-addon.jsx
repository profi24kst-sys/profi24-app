import React,{useEffect,useRef,useState}from'react';
import{createRoot}from'react-dom/client';
import{Camera,PenLine,Upload,X,Trash2,Printer}from'lucide-react';
import'./warehouse.css';

const B='/documents-api/v1';
const SAFE_IMAGE_ACCEPT='.jpg,.jpeg,.png,.webp,.heic,.heif,.hif';
const SAFE_FILE_ACCEPT=`${SAFE_IMAGE_ACCEPT},.pdf`;
const token=()=>localStorage.token||'';
const currentUser=()=>{try{return JSON.parse(localStorage.user||'null')}catch{return null}};
const role=()=>currentUser()?.role||'';
const canUpload=()=>['OWNER','SUPERVISOR','MANAGER','ENGINEER','TRAINEE'].includes(role());
const canDelete=()=>['OWNER','SUPERVISOR','MANAGER'].includes(role());
const canSign=()=>['OWNER','SUPERVISOR','MANAGER','ENGINEER'].includes(role());
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>c==='&'?'&amp;':c==='<'?'&lt;':c==='>'?'&gt;':c==='"'?'&quot;':'&#39;');
const money=n=>new Intl.NumberFormat('ru-KZ').format(Number(n||0))+' ₸';

async function api(path,options={}){
  const response=await fetch(B+path,{...options,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token()}`,...(options.headers||{})}});
  const json=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(json.error?.message||`Ошибка ${response.status}`);
  return json.data;
}

async function openProtectedFile(id){
  const response=await fetch(`${B}/files/${id}`,{headers:{Authorization:`Bearer ${token()}`}});
  if(!response.ok){
    const json=await response.json().catch(()=>({}));
    throw new Error(json.error?.message||'Не удалось открыть файл');
  }
  const blob=await response.blob();
  const url=URL.createObjectURL(blob);
  window.open(url,'_blank','noopener');
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}

function App(){
  const[orderId,setOrderId]=useState(null),[files,setFiles]=useState([]),[signs,setSigns]=useState([]),[open,setOpen]=useState(false),[err,setErr]=useState('');
  useEffect(()=>{
    const click=e=>{
      const title=e.target.closest?.('.ordertitle');if(!title)return;
      const number=title.querySelector('h2')?.textContent;if(!number)return;
      fetch('/api/v1/requests',{headers:{Authorization:`Bearer ${token()}`}}).then(r=>r.json()).then(j=>{
        const order=j.data?.find(v=>v.number===number);if(order){setOrderId(order.id);setOpen(true)}
      }).catch(()=>{});
    };
    document.addEventListener('dblclick',click);
    return()=>document.removeEventListener('dblclick',click);
  },[]);

  async function load(){
    if(!orderId)return;
    try{
      setErr('');
      const[fileRows,signatureRows]=await Promise.all([api(`/requests/${orderId}/files`),api(`/requests/${orderId}/signatures`)]);
      setFiles(fileRows||[]);setSigns(signatureRows||[]);
    }catch(error){setErr(error.message)}
  }
  useEffect(()=>{if(open)load()},[open,orderId]);
  if(!open)return <div className="docsHint">Дважды нажмите на шапку заказа — фото и документы</div>;

  async function upload(event,kind){
    const file=event.target.files?.[0];if(!file)return;
    const reader=new FileReader();
    reader.onerror=()=>setErr('Не удалось прочитать файл');
    reader.onload=async()=>{
      try{
        setErr('');
        await api(`/requests/${orderId}/files`,{method:'POST',body:JSON.stringify({name:file.name,kind,data:reader.result})});
        await load();
      }catch(error){setErr(error.message)}finally{event.target.value=''}
    };
    reader.readAsDataURL(file);
  }

  async function printDocument(type){
    try{
      setErr('');
      const data=await api(`/requests/${orderId}/document-data`);
      const meta=await api(`/requests/${orderId}/documents`,{method:'POST',body:JSON.stringify({document_type:type})});
      const names={WORK_ORDER:'Заказ-наряд',DEFECT_ACT:'Дефектный акт',COMPLETION_ACT:'Акт выполненных работ',WARRANTY:'Гарантийный талон'};
      const popup=window.open('','_blank');if(!popup)throw new Error('Браузер заблокировал окно документа');
      const sig=t=>data.signatures?.find(x=>x.signer_type===t)?.signature_data;
      popup.document.write(`<html><head><title>${esc(names[type])}</title><style>body{font-family:Arial;padding:32px;color:#111;max-width:900px;margin:auto}h1{font-size:22px}table{width:100%;border-collapse:collapse;margin:18px 0}td,th{border:1px solid #aaa;padding:7px}.r{display:flex;justify-content:space-between;border-bottom:1px solid #ddd;padding:7px}.sign{display:flex;justify-content:space-between;margin-top:50px}.sign img{max-width:180px;max-height:70px}</style></head><body><h1>PROFI24 — ${esc(names[type])}</h1><p>Документ № ${esc(meta.document_number)}</p><div class=r><span>Заказ</span><b>${esc(data.number)}</b></div><div class=r><span>Клиент</span><b>${esc(data.customer_name)}</b></div><div class=r><span>Телефон</span><b>${esc(data.phone)}</b></div><div class=r><span>Адрес</span><b>${esc(data.address||'—')}</b></div><div class=r><span>Техника</span><b>${esc([data.category,data.brand,data.model,data.serial_number].filter(Boolean).join(' '))}</b></div><p><b>Заявленная неисправность:</b> ${esc(data.complaint)}</p><p><b>Диагностика:</b> ${esc(data.diagnosis||'—')}</p><table><tr><th>Работа</th><th>Кол.</th><th>Цена</th><th>Сумма</th></tr>${(data.works||[]).map(x=>`<tr><td>${esc(x.name)}</td><td>${esc(x.qty)}</td><td>${money(x.unit_price)}</td><td>${money(x.qty*x.unit_price)}</td></tr>`).join('')}</table><table><tr><th>Запчасть</th><th>Кол.</th><th>Цена</th></tr>${(data.parts||[]).map(x=>`<tr><td>${esc(x.name)}</td><td>${esc(x.qty)}</td><td>${money(x.sale_price)}</td></tr>`).join('')}</table><h3>Итого: ${money(data.total)}</h3>${type==='WARRANTY'?`<p>Гарантия до: <b>${esc(data.warranty_until||'не указана')}</b></p>`:''}<div class=sign><div>Инженер: ${esc(data.engineer_name||'—')}<br>${sig('ENGINEER')?`<img src="${sig('ENGINEER')}">`:'________________'}</div><div>Клиент: ${esc(data.customer_name)}<br>${sig('CLIENT')?`<img src="${sig('CLIENT')}">`:'________________'}</div></div></body></html>`);
      popup.document.close();popup.print();
    }catch(error){setErr(error.message)}
  }

  return <div className="warehouseScreen"><div className="whTop"><div><h1>Фото и документы заказа</h1><p>Заказ ID {orderId}</p></div><button onClick={()=>setOpen(false)}><X/></button></div>{err&&<div className="whError">{err}</div>}{canUpload()&&<div className="whTopActions"><Label text="Фото до" accept={SAFE_IMAGE_ACCEPT} icon={<Camera/>} on={e=>upload(e,'PHOTO_BEFORE')}/><Label text="Фото после" accept={SAFE_IMAGE_ACCEPT} icon={<Camera/>} on={e=>upload(e,'PHOTO_AFTER')}/><Label text="Шильдик" accept={SAFE_IMAGE_ACCEPT} icon={<Camera/>} on={e=>upload(e,'NAMEPLATE')}/><Label text="Файл" accept={SAFE_FILE_ACCEPT} icon={<Upload/>} on={e=>upload(e,'OTHER')}/>{canSign()&&<button className="whPrimary" onClick={()=>setOpen('sign')}><PenLine/>Подписи</button>}</div>}<div className="whGrid2"><div className="whTable"><div className="whTop"><h2>Вложения</h2></div>{files.map(file=><div className="whRow" key={file.id}><div><b>{file.original_name}</b><small>{file.kind} · {Math.round(file.size_bytes/1024)} КБ</small></div><span></span><button onClick={()=>openProtectedFile(file.id).catch(error=>setErr(error.message))}>Открыть</button><span></span>{canDelete()?<button onClick={async()=>{try{await api('/files/'+file.id,{method:'DELETE'});await load()}catch(error){setErr(error.message)}}}><Trash2 size={16}/></button>:<span/>}</div>)}</div><div className="whTable"><div className="whTop"><h2>Документы</h2></div>{[['WORK_ORDER','Заказ-наряд'],['DEFECT_ACT','Дефектный акт'],['COMPLETION_ACT','АВР'],['WARRANTY','Гарантийный талон']].map(([type,name])=><div className="whRow" key={type}><div><b>{name}</b><small>Формируется из данных заказа</small></div><span></span><button className="whPrimary" onClick={()=>printDocument(type)}><Printer size={16}/>Печать / PDF</button><span></span><span></span></div>)}</div></div>{open==='sign'&&canSign()&&<Signature orderId={orderId} close={()=>{setOpen(true);load()}}/>}</div>;
}

function Label({text,icon,on,accept}){return <label className="whPrimary">{icon}{text}<input hidden type="file" accept={accept} onChange={on}/></label>}

function Signature({orderId,close}){
  const ref=useRef(),[type,setType]=useState('CLIENT'),[name,setName]=useState(''),[err,setErr]=useState(''),drawing=useRef(false);
  useEffect(()=>{
    const canvas=ref.current,ctx=canvas.getContext('2d');ctx.lineWidth=2;ctx.lineCap='round';
    const pos=e=>{const r=canvas.getBoundingClientRect(),p=e.touches?.[0]||e;return[(p.clientX-r.left)*canvas.width/r.width,(p.clientY-r.top)*canvas.height/r.height]};
    const down=e=>{drawing.current=true;const[x,y]=pos(e);ctx.beginPath();ctx.moveTo(x,y)};
    const move=e=>{if(!drawing.current)return;e.preventDefault();const[x,y]=pos(e);ctx.lineTo(x,y);ctx.stroke()};
    const up=()=>drawing.current=false;
    canvas.addEventListener('mousedown',down);canvas.addEventListener('mousemove',move);window.addEventListener('mouseup',up);canvas.addEventListener('touchstart',down);canvas.addEventListener('touchmove',move,{passive:false});canvas.addEventListener('touchend',up);
    return()=>{canvas.removeEventListener('mousedown',down);canvas.removeEventListener('mousemove',move);window.removeEventListener('mouseup',up);canvas.removeEventListener('touchstart',down);canvas.removeEventListener('touchmove',move);canvas.removeEventListener('touchend',up)};
  },[]);
  async function save(){try{setErr('');await api(`/requests/${orderId}/signatures`,{method:'POST',body:JSON.stringify({signer_type:type,signer_name:name,signature_data:ref.current.toDataURL('image/png')})});close()}catch(error){setErr(error.message)}}
  return <div className="whOverlay"><div className="whModal"><div className="whModalHead"><h2>Подпись</h2><button onClick={close}><X/></button></div><div className="whForm">{err&&<div className="whError">{err}</div>}<label>Кто подписывает<select value={type} onChange={e=>setType(e.target.value)}><option value="CLIENT">Клиент</option><option value="ENGINEER">Инженер</option></select></label><label>ФИО<input value={name} onChange={e=>setName(e.target.value)}/></label><canvas ref={ref} width="700" height="220" style={{width:'100%',border:'1px solid #ccd3dd',borderRadius:8,touchAction:'none'}}/><div className="whButtons"><button onClick={()=>ref.current.getContext('2d').clearRect(0,0,ref.current.width,ref.current.height)}>Очистить</button><button className="whPrimary" onClick={save}>Сохранить подпись</button></div></div></div></div>;
}

const root=document.createElement('div');document.body.appendChild(root);createRoot(root).render(<App/>);
