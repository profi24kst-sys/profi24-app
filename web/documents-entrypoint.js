const BUTTON_ID='profi24-documents-entrypoint';

function removeButton(){document.getElementById(BUTTON_ID)?.remove()}
function normalizeDocumentsUi(){document.querySelectorAll('.docsHint').forEach(node=>{node.style.display='none'})}

function openDocuments(order360){
  const id=Number(order360.dataset.currentRequestId||0);
  const number=order360.querySelector('.o360Hero small')?.textContent?.trim();
  if((!Number.isSafeInteger(id)||id<1)&&!number)return;
  window.dispatchEvent(new CustomEvent('profi24:close-overlays'));
  window.dispatchEvent(new CustomEvent('profi24:open-documents',{detail:{id:Number.isSafeInteger(id)&&id>0?id:undefined,number}}));
}

function render(){
  normalizeDocumentsUi();
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
