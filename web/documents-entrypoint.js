const BUTTON_ID='profi24-documents-entrypoint';

function removeButton(){document.getElementById(BUTTON_ID)?.remove()}

function openDocuments(order360){
  const number=order360.querySelector('.o360Hero small')?.textContent?.trim();
  if(!number)return;
  const bridge=document.createElement('div');
  bridge.className='ordertitle';
  bridge.hidden=true;
  const title=document.createElement('h2');
  title.textContent=number;
  bridge.appendChild(title);
  document.body.appendChild(bridge);
  bridge.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,view:window}));
  bridge.remove();
  window.dispatchEvent(new CustomEvent('profi24:close-overlays'));
}

function render(){
  const order360=document.querySelector('.o360[data-current-request-id]');
  if(!order360){removeButton();return}
  const quick=order360.querySelector('.o360Quick');
  if(!quick){removeButton();return}
  if(document.getElementById(BUTTON_ID))return;
  const button=document.createElement('button');
  button.id=BUTTON_ID;
  button.type='button';
  button.setAttribute('aria-label','Документы заказа');
  button.textContent='Документы';
  Object.assign(button.style,{display:'flex',alignItems:'center',gap:'6px',border:'0',color:'#27364d',background:'#f2f4f7',padding:'8px 10px',borderRadius:'9px',font:'inherit',cursor:'pointer'});
  button.addEventListener('click',()=>openDocuments(order360));
  quick.appendChild(button);
}

const observer=new MutationObserver(render);
observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-current-request-id']});
window.addEventListener('profi24:o360-current',render);
window.addEventListener('profi24:request-updated',render);
render();
