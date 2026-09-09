import React,{useEffect,useMemo,useState}from'react';
import{createRoot}from'react-dom/client';
import{AlertTriangle,BarChart3,Boxes,Clock3,Filter,Layers3,MoveRight,Package,RefreshCw,Search,TrendingUp,WalletCards,X}from'lucide-react';
import'./warehouse-stock-analytics.css';

const BASE='/analytics-api/v1';
const token=()=>localStorage.token;
const user=()=>{try{return JSON.parse(localStorage.user||'null')}catch{return null}};
async function api(path){const r=await fetch(BASE+path,{headers:{Authorization:`Bearer ${token()}`}}),j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error?.message||'Ошибка аналитики склада');return j.data}
const money=n=>new Intl.NumberFormat('ru-KZ',{maximumFractionDigits:0}).format(Number(n||0))+' ₸';
const qty=n=>new Intl.NumberFormat('ru-KZ',{maximumFractionDigits:2}).format(Number(n||0));
const num=(n,d=1)=>Number.isFinite(Number(n))?Number(n).toFixed(d):'—';
const actions={KEEP:'Норма',TRANSFER:'Переместить',PROTECT_SERVICE:'Срочно пополнить',REVIEW_WRITE_OFF:'Проверить списание',LIQUIDATE:'Вывести неликвид',STOP_BUY:'Не закупать',REDUCE_STOCK:'Снизить запас',REPLENISH:'Пополнить'};

function App(){
 const u=user(),rbac=window.Profi24RBAC,P=rbac?.P||{},view=Boolean(P.WAREHOUSE_VIEW&&rbac?.can(P.WAREHOUSE_VIEW,u?.role));
 const[open,setOpen]=useState(false),[data,setData]=useState(null),[err,setErr]=useState(''),[loading,setLoading]=useState(false),[search,setSearch]=useState(''),[abc,setAbc]=useState('ALL'),[xyz,setXyz]=useState('ALL'),[action,setAction]=useState('ALL'),[branch,setBranch]=useState('ALL'),[tab,setTab]=useState('all');
 async function load(){if(!view)return;try{setLoading(true);setErr('');setData(await api('/warehouse-stock'))}catch(e){setErr(e.message)}finally{setLoading(false)}}
 useEffect(()=>{if(open)load()},[open,view]);
 useEffect(()=>{if(!view||!window.Profi24UI)return;return window.Profi24UI.registerNav({id:'warehouse-stock-analytics',label:'Аналитика склада',group:'stock',permission:P.WAREHOUSE_VIEW,badge:data?.summary?.no_consumption_180||null,onClick:()=>setOpen(true)})},[u?.id,u?.role,view,data?.summary?.no_consumption_180]);
 const branches=useMemo(()=>[...new Map((data?.rows||[]).map(x=>[String(x.branch_id),{id:String(x.branch_id),name:x.branch_name}])).values()], [data]);
 const rows=useMemo(()=>{let r=[...(data?.rows||[])],s=search.trim().toLowerCase();if(s)r=r.filter(x=>[x.name,x.sku,x.oem_code,x.supplier,x.branch_name].some(v=>String(v||'').toLowerCase().includes(s)));if(abc!=='ALL')r=r.filter(x=>x.abc===abc);if(xyz!=='ALL')r=r.filter(x=>x.xyz===xyz);if(action!=='ALL')r=r.filter(x=>x.recommendation_code===action);if(branch!=='ALL')r=r.filter(x=>String(x.branch_id)===branch);if(tab==='dead')r=r.filter(x=>x.days_no_consumption>=90&&x.quantity>0);if(tab==='transfer')r=r.filter(x=>x.transfer_opportunity);return r},[data,search,abc,xyz,action,branch,tab]);
 if(!view||!open)return null;
 const s=data?.summary||{};
 return <div className="wsaScreen">
   <div className="wsaTop"><div><h1><BarChart3/>Аналитика склада и неликвид</h1><p>ABC/XYZ, оборачиваемость, замороженные деньги и межфилиальные возможности</p></div><div className="wsaActions"><button onClick={load} disabled={loading}><RefreshCw className={loading?'spin':''}/>{loading?'Обновляем':'Обновить'}</button><button className="icon" onClick={()=>setOpen(false)}><X/></button></div></div>
   {err&&<div className="wsaError"><AlertTriangle/>{err}</div>}
   {data&&<>
    <div className="wsaMetrics">
      <Metric icon={<WalletCards/>} label="Деньги в запасе" value={money(s.stock_value)} sub={`${s.positions||0} позиций`}/>
      <Metric icon={<Layers3/>} label="Избыточный запас" value={money(s.excess_value)} sub={s.stock_value?`${num(s.excess_value/s.stock_value*100,1)}% стоимости склада`:'—'} hot={s.excess_value>0}/>
      <Metric icon={<Clock3/>} label="Неликвид 180+" value={money(s.dead_stock_value)} sub={`${s.no_consumption_180||0} позиций без расхода`} hot={s.dead_stock_value>0}/>
      <Metric icon={<TrendingUp/>} label="Оборачиваемость" value={`${num(s.turnover_365,2)}×`} sub={s.days_inventory?`${num(s.days_inventory,0)} дней запаса`:'нет расхода'}/>
      <Metric icon={<MoveRight/>} label="Можно переместить" value={String(s.transfer_opportunities||0)} sub="между филиалами" hot={s.transfer_opportunities>0}/>
      <Metric icon={<Boxes/>} label="Без расхода 365+" value={String(s.no_consumption_365||0)} sub={s.estimated_reconstruction_items?`${s.estimated_reconstruction_items} поз. с оценочной историей`:'история восстановлена'}/>
    </div>
    <div className="wsaMatrix"><div><b>ABC</b><span>A — {data.abc?.A||0}</span><span>B — {data.abc?.B||0}</span><span>C — {data.abc?.C||0}</span></div><div><b>XYZ</b><span>X — {data.xyz?.X||0}</span><span>Y — {data.xyz?.Y||0}</span><span>Z — {data.xyz?.Z||0}</span></div><small>{data.methodology?.abc}. {data.methodology?.xyz}.</small></div>
    <div className="wsaTabs"><button className={tab==='all'?'on':''} onClick={()=>setTab('all')}><Package/>Все позиции <b>{data.rows.length}</b></button><button className={tab==='dead'?'on':''} onClick={()=>setTab('dead')}><Clock3/>Без расхода 90+ <b>{data.rows.filter(x=>x.days_no_consumption>=90&&x.quantity>0).length}</b></button><button className={tab==='transfer'?'on':''} onClick={()=>setTab('transfer')}><MoveRight/>Перемещения <b>{s.transfer_opportunities||0}</b></button></div>
    <div className="wsaFilters"><label className="search"><Search/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Поиск по детали, SKU, OEM, поставщику…"/></label><Select icon={<Filter/>} value={branch} set={setBranch} options={[['ALL','Все филиалы'],...branches.map(x=>[x.id,x.name])]}/><Select value={abc} set={setAbc} options={[['ALL','ABC: все'],['A','A — ключевые'],['B','B — средние'],['C','C — низкий вклад']]}/><Select value={xyz} set={setXyz} options={[['ALL','XYZ: все'],['X','X — стабильный'],['Y','Y — средний'],['Z','Z — нерегулярный']]}/><Select value={action} set={setAction} options={[['ALL','Все рекомендации'],...Object.entries(actions).map(([k,v])=>[k,v])]}/></div>
    <div className="wsaCard"><div className="wsaCardTop"><div><h2>{tab==='dead'?'Неликвид и медленные позиции':tab==='transfer'?'Межфилиальные перемещения':'Складские позиции'}</h2><p>Показано {rows.length} из {data.rows.length}</p></div><span className="wsaGenerated">Расчёт: {new Date(data.generated_at).toLocaleString('ru-RU')}</span></div><div className="wsaTable"><div className="wsaHead"><span>Позиция / филиал</span><span>ABC · XYZ</span><span>Остаток / стоимость</span><span>Расход 365</span><span>Оборачиваемость</span><span>Без расхода</span><span>Избыток</span><span>Рекомендация</span></div>{rows.map(x=><StockRow key={x.id} x={x}/>)}</div>{!rows.length&&<div className="wsaEmpty"><Package/><b>По выбранным фильтрам ничего нет</b><span>Измените фильтр или обновите расчёт.</span></div>}</div>
   </>}
 </div>
}
function Metric({icon,label,value,sub,hot}){return <div className={'wsaMetric '+(hot?'hot':'')}><span>{icon}</span><div><small>{label}</small><b>{value}</b><em>{sub}</em></div></div>}
function Select({icon,value,set,options}){return <label className="wsaSelect">{icon}<select value={value} onChange={e=>set(e.target.value)}>{options.map(([v,l])=><option value={v} key={v}>{l}</option>)}</select></label>}
function StockRow({x}){return <div className={'wsaRow '+x.recommendation_code}><div><b>{x.name}</b><small>{[x.sku,x.oem_code].filter(Boolean).join(' · ')||'без артикула'} · {x.branch_name}</small></div><div className="classes"><strong className={'abc '+x.abc}>{x.abc}</strong><strong className={'xyz '+x.xyz}>{x.xyz}</strong><small>{x.xyz_cv==null?'нет стабильного расхода':`CV ${num(x.xyz_cv,2)}`}</small></div><div><b>{qty(x.quantity)} шт.</b><small>{money(x.stock_value)} · свободно {qty(x.free_quantity)}</small></div><div><b>{qty(x.usage_qty_365)} шт.</b><small>{money(x.usage_value_365)}</small></div><div><b>{x.turnover_365?`${num(x.turnover_365,2)}×`:'—'}</b><small>{x.days_inventory?`${num(x.days_inventory,0)} дн. запаса`:'нет расчёта'}</small></div><div><b>{x.days_no_consumption} дн.</b><small>движение {x.days_no_movement} дн. назад</small></div><div><b>{qty(x.excess_quantity)} шт.</b><small>{money(x.excess_value)}</small></div><div><span className={'action '+x.recommendation_code}>{actions[x.recommendation_code]||x.recommendation_code}</span><small>{x.transfer_opportunity?`→ ${x.transfer_opportunity.branch_name}: ${qty(x.transfer_opportunity.quantity)} шт.`:x.recommendation}</small></div></div>}

const root=document.createElement('div');document.body.appendChild(root);createRoot(root).render(<App/>);
