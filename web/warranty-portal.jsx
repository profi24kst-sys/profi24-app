import React,{useEffect,useState}from'react';
import{createRoot}from'react-dom/client';
import'./warranty-portal.css';

const money=v=>`${Number(v||0).toLocaleString('ru-RU')} ₸`;
const date=v=>v?new Date(v).toLocaleDateString('ru-RU'):'—';

function App(){
  const token=location.pathname.match(/^\/warranty\/([a-f0-9]+)/)?.[1];
  const[data,setData]=useState(null);
  const[err,setErr]=useState('');
  useEffect(()=>{
    if(!token)return;
    fetch(`/warranty-api/public/warranty/${token}`)
      .then(r=>r.json())
      .then(j=>j.data?setData(j.data):setErr(j.error?.message||'Ошибка'))
      .catch(()=>setErr('Не удалось загрузить гарантийный талон'));
  },[token]);
  if(!token)return null;
  if(err)return <main className="wp"><div className="wpCard"><h2>PROFI24KST</h2><p className="bad">{err}</p></div></main>;
  if(!data)return <main className="wp"><div className="wpCard">Загрузка…</div></main>;
  return <main className="wp"><div className="wpCard">
    <div className="brand">PROFI<span>24</span>KST</div>
    <small>Электронный гарантийный талон</small>
    <h1>{data.number}</h1>
    <div className="grid">
      <div><span>Клиент</span><b>{data.customer_name||'—'}</b></div>
      <div><span>Телефон</span><b>{data.phone||'—'}</b></div>
      <div><span>Техника</span><b>{[data.category,data.brand,data.model].filter(Boolean).join(' ')||'—'}</b></div>
      <div><span>Серийный номер</span><b>{data.serial_number||'—'}</b></div>
      <div><span>Исполнитель</span><b>{data.engineer_name||'—'}</b></div>
      <div><span>Оплачено</span><b>{money(data.paid)}</b></div>
    </div>
    <section><label>Работы</label>{data.works?.length?data.works.map((w,i)=><div className="row" key={i}><span>{w.name} × {w.qty}</span><b>{money(Number(w.qty)*Number(w.unit_price))}</b></div>):<p>Работы не указаны</p>}</section>
    {data.parts?.length>0&&<section><label>Запчасти</label>{data.parts.map((p,i)=><div className="row" key={i}><span>{p.name} × {p.qty}</span><b>{money(Number(p.qty)*Number(p.sale_price))}</b></div>)}</section>}
    <div className="total"><span>Сумма заказа</span><b>{money(data.total)}</b></div>
    <div className="warranty"><strong>Гарантия {data.warranty_days} дней</strong><span>Действует до {date(data.warranty_until)}</span></div>
    <p className="legal">Гарантия распространяется на выполненные работы и установленные сервисным центром детали в пределах условий заказа. Сохраняйте эту ссылку как электронный гарантийный талон.</p>
  </div></main>;
}

const root=document.getElementById('root');
if(location.pathname.startsWith('/warranty/'))createRoot(root).render(<App/>);
