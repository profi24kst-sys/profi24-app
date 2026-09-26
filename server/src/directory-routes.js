import {authenticate} from './access.js';
import {xlsxBuffer} from './xlsx-export.js';

const EXPORT_ROLES=new Set(['OWNER','SUPERVISOR','ACCOUNTANT','MANAGER']);
const ALL_ROLES=new Set(['OWNER','SUPERVISOR','ACCOUNTANT','MANAGER','ENGINEER','TRAINEE']);
const ORDER_TABS=new Set(['ACTIVE','NEW','PART','PAY','OVERDUE','CLOSED','ALL']);
const XLSX_TYPE='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_EXPORT=10000;

function fail(reply,code,message,status=422){
  return reply.code(status).send({data:null,error:{code,message}});
}

export function parseDirectoryQuery(query={},kind='orders'){
  const page=query.page==null?1:Number(query.page);
  const limit=query.limit==null?25:Number(query.limit);
  if(!Number.isSafeInteger(page)||page<1||page>10000)return{error:'Номер страницы должен быть от 1 до 10000'};
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)return{error:'Размер страницы должен быть от 1 до 100'};
  const search=String(query.search??'').trim();
  if(search.length>120)return{error:'Поисковая строка: максимум 120 символов'};
  const status=String(query.status||'ACTIVE').toUpperCase();
  if(kind==='orders'&&!ORDER_TABS.has(status))return{error:'Неизвестный фильтр заказов'};
  const focusId=query.focus_id==null?null:Number(query.focus_id);
  if(focusId!=null&&(!Number.isSafeInteger(focusId)||focusId<1))return{error:'Некорректный номер клиента'};
  const month=query.month==null?'':String(query.month);
  if(month&&!/^20\d\d-(0[1-9]|1[0-2])$/.test(month))return{error:'Месяц укажите в формате ГГГГ-ММ'};
  return{value:{page,limit,search,status,month,focusId,offset:(page-1)*limit}};
}

function escapeLike(value){
  return '%'+value.replace(/[\\%_]/g,'\\$&')+'%';
}
function parameter(params,value){
  params.push(value);return '$'+params.length;
}
function monthPredicate(params,alias,month){
  if(!month)return'';
  const p=parameter(params,month);
  // Construct TIMESTAMP WITHOUT TIME ZONE local midnight before AT TIME ZONE.
  // A DATE operand invokes the wrong overload; direct timestamp bounds retain index-friendly predicates.
  const localStart="(("+p+"::text || '-01')::timestamp)";
  const first='('+localStart+" AT TIME ZONE 'Asia/Qostanay')";
  const next='(('+localStart+" + INTERVAL '1 month') AT TIME ZONE 'Asia/Qostanay')";
  return ' AND '+alias+'.created_at >= '+first+' AND '+alias+'.created_at < '+next;
}

function visibleRequest(params,role,userId,alias){
  if(['OWNER','SUPERVISOR','ACCOUNTANT'].includes(role))return 'TRUE';
  const user=parameter(params,userId);
  if(role==='MANAGER'){
    return 'EXISTS (SELECT 1 FROM user_branches ub WHERE ub.user_id='+user+' AND ub.branch_id='+alias+'.branch_id)';
  }
  if(role==='ENGINEER'){
    return '('+alias+'.engineer_id='+user+' OR EXISTS (SELECT 1 FROM request_participants rp WHERE rp.request_id='+alias+'.id AND rp.user_id='+user+" AND rp.participant_role='ENGINEER' AND rp.removed_at IS NULL))";
  }
  if(role==='TRAINEE'){
    return 'EXISTS (SELECT 1 FROM request_participants rp '+
      'JOIN user_mentors um ON um.trainee_id=rp.user_id AND um.mentor_id=rp.mentor_id '+
      "JOIN users mentor ON mentor.id=um.mentor_id AND mentor.role='ENGINEER' AND mentor.active=true "+
      'WHERE rp.request_id='+alias+'.id AND rp.user_id='+user+" AND rp.participant_role='TRAINEE' AND rp.removed_at IS NULL AND "+
      alias+'.engineer_id=um.mentor_id)';
  }
  return 'FALSE';
}

function ordersQuery(role,userId,filters,{withStatus=true}={}){
  const params=[],where=['r.deleted_at IS NULL',visibleRequest(params,role,userId,'r')];
  if(filters.search){
    const p=parameter(params,escapeLike(filters.search));
    where.push('(r.number ILIKE '+p+" ESCAPE '\\' OR c.name ILIKE "+p+" ESCAPE '\\' OR c.phone ILIKE "+p+" ESCAPE '\\' OR "+
      "COALESCE(e.brand,'') ILIKE "+p+" ESCAPE '\\' OR COALESCE(e.model,'') ILIKE "+p+" ESCAPE '\\' OR "+
      "COALESCE(r.complaint,'') ILIKE "+p+" ESCAPE '\\' OR COALESCE(eng.name,'') ILIKE "+p+" ESCAPE '\\')");
  }
  const month=monthPredicate(params,'r',filters.month);
  if(month)where.push(month.slice(5));
  const baseWhere=where.join(' AND ');
  if(withStatus){
    if(filters.status==='ACTIVE')where.push("r.status NOT IN ('CLOSED','CANCELLED')");
    if(filters.status==='NEW')where.push("r.status='NEW'");
    if(filters.status==='PART')where.push("r.status='WAITING_PART'");
    if(filters.status==='PAY')where.push("r.status='PAYMENT_REQUIRED'");
    if(filters.status==='CLOSED')where.push("r.status='CLOSED'");
    if(filters.status==='OVERDUE')where.push("r.sla_deadline<now() AND r.status NOT IN ('CLOSED','CANCELLED')");
  }
  const from=' FROM requests r JOIN customers c ON c.id=r.customer_id '+
    'LEFT JOIN equipment e ON e.id=r.equipment_id LEFT JOIN users eng ON eng.id=r.engineer_id '+
    'LEFT JOIN branches b ON b.id=r.branch_id';
  return{params,from,where:where.join(' AND '),baseWhere};
}

function customersQuery(role,userId,filters){
  const params=[],accessible=visibleRequest(params,role,userId,'r');
  let joinFilter='r.deleted_at IS NULL AND '+accessible;
  joinFilter+=monthPredicate(params,'r',filters.month);
  const where=['c.deleted_at IS NULL'];
  if(role==='MANAGER'||role==='ENGINEER'||role==='TRAINEE'||filters.month){
    where.push('EXISTS (SELECT 1 FROM requests r WHERE r.customer_id=c.id AND '+joinFilter+')');
  }
  if(filters.focusId)where.push('c.id='+parameter(params,filters.focusId));
  if(filters.search){
    const p=parameter(params,escapeLike(filters.search));
    where.push('(c.name ILIKE '+p+" ESCAPE '\\' OR c.phone ILIKE "+p+" ESCAPE '\\' OR "+
      "COALESCE(c.phone_norm,'') ILIKE "+p+" ESCAPE '\\' OR COALESCE(c.email,'') ILIKE "+p+" ESCAPE '\\')");
  }
  return{params,joinFilter,where:where.join(' AND ')};
}

const ORDER_SELECT='SELECT r.id,r.number,r.status,r.priority,r.created_at,r.closed_at,r.scheduled_at,r.sla_deadline,'+
  'r.total,r.paid,r.direct_cost,r.source,r.complaint,r.branch_id,c.name customer_name,c.phone,'+
  'e.category,e.brand,e.model,eng.name engineer_name,b.code branch_code';
const ORDER_SORT=" ORDER BY CASE WHEN r.status NOT IN ('CLOSED','CANCELLED') THEN 0 ELSE 1 END,r.created_at DESC,r.id DESC";
const CUSTOMER_SELECT='SELECT c.id,c.name,c.phone,c.email,c.address,c.created_at,'+
  'count(r.id)::int request_count,COALESCE(sum(r.paid),0)::numeric lifetime_paid';

function safeOrders(rows,role){
  if(role!=='ENGINEER'&&role!=='TRAINEE')return rows;
  return rows.map(({direct_cost,...row})=>row);
}
function safeCustomers(rows,role){
  if(role!=='ENGINEER'&&role!=='TRAINEE')return rows;
  return rows.map(({lifetime_paid,...row})=>row);
}
function dateTime(value){
  return value?new Date(value).toLocaleString('ru-RU',{timeZone:'Asia/Qostanay',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'';
}
const STATUS={
  NEW:'Новая',ASSIGNED:'Назначена',ACCEPTED:'Принята',DIAGNOSTICS:'Диагностика',
  APPROVAL_REQUIRED:'Согласование',WAITING_PART:'Ожидание детали',REPAIR:'Ремонт',
  TESTING:'Тестирование',PAYMENT_REQUIRED:'К оплате',CLOSED:'Закрыта',CANCELLED:'Отменена'
};
function amount(value){return Number(value)||0;}
const ORDER_COLUMNS=[
  {header:'Номер заказа',width:24},{header:'Дата создания (Костанай)',width:23},
  {header:'Клиент',width:32},{header:'Телефон',width:20},{header:'Техника',width:36},
  {header:'Неисправность',width:65},{header:'Статус',width:21},{header:'Приоритет',width:16},
  {header:'Инженер',width:28},{header:'Дата выезда (Костанай)',width:23},
  {header:'Начислено, ₸',width:19,type:'number'},{header:'Оплачено, ₸',width:19,type:'number'},
  {header:'Долг, ₸',width:19,type:'number'},{header:'Себестоимость, ₸',width:21,type:'number'},
  {header:'Валовая прибыль, ₸',width:24,type:'number'},{header:'Филиал',width:16}
];
const CUSTOMER_COLUMNS=[
  {header:'Клиент',width:34},{header:'Телефон',width:22},{header:'Email',width:40},
  {header:'Адрес',width:55},{header:'Количество заказов',width:21,type:'number'},
  {header:'Оплачено, ₸',width:22,type:'number'},{header:'Добавлен (Костанай)',width:24}
];

function xlsxReply(reply,kind,columns,rows){
  const buffer=xlsxBuffer({sheetName:kind==='orders'?'Заказы':'Клиенты',columns,rows});
  const filename='PROFI24-'+kind+'-'+new Date().toISOString().slice(0,10)+'.xlsx';
  return reply.header('Content-Type',XLSX_TYPE)
    .header('Content-Disposition','attachment; filename="'+filename+'"')
    .header('Cache-Control','private, no-store')
    .header('X-Content-Type-Options','nosniff').send(buffer);
}

export function registerDirectoryRoutes(app,pool){
  const q=(sql,params=[])=>pool.query(sql,params);
  const auth=async(req,reply)=>{await authenticate(req,reply,pool);};

  app.get('/api/v1/directory/orders',{preHandler:auth},async(req,reply)=>{
    if(!ALL_ROLES.has(req.user.role))return fail(reply,'FORBIDDEN','Недостаточно прав',403);
    const parsed=parseDirectoryQuery(req.query,'orders');
    if(parsed.error)return fail(reply,'VALIDATION',parsed.error);
    const filters=parsed.value,sql=ordersQuery(req.user.role,req.user.id,filters);
    const countSql='SELECT count(*)::int total,'+
      "count(*) FILTER(WHERE r.status NOT IN ('CLOSED','CANCELLED'))::int active,"+
      "count(*) FILTER(WHERE r.status='NEW')::int new,"+
      "count(*) FILTER(WHERE r.status='WAITING_PART')::int part,"+
      "count(*) FILTER(WHERE r.status='PAYMENT_REQUIRED')::int pay,"+
      "count(*) FILTER(WHERE r.status='CLOSED')::int closed,"+
      "count(*) FILTER(WHERE r.sla_deadline<now() AND r.status NOT IN ('CLOSED','CANCELLED'))::int overdue"+
      sql.from+' WHERE '+sql.baseWhere;
    const [countsResult,totalResult]=await Promise.all([
      q(countSql,sql.params),q('SELECT count(*)::int total'+sql.from+' WHERE '+sql.where,sql.params)
    ]);
    const counts=countsResult.rows[0],total=totalResult.rows[0].total;
    const p=[...sql.params],limit=parameter(p,filters.limit),offset=parameter(p,filters.offset);
    const rows=(await q(ORDER_SELECT+sql.from+' WHERE '+sql.where+ORDER_SORT+' LIMIT '+limit+' OFFSET '+offset,p)).rows;
    return{data:safeOrders(rows,req.user.role),meta:{page:filters.page,limit:filters.limit,total,pages:Math.ceil(total/filters.limit),counts}};
  });

  app.get('/api/v1/directory/customers',{preHandler:auth},async(req,reply)=>{
    if(!ALL_ROLES.has(req.user.role))return fail(reply,'FORBIDDEN','Недостаточно прав',403);
    const parsed=parseDirectoryQuery(req.query,'customers');
    if(parsed.error)return fail(reply,'VALIDATION',parsed.error);
    const filters=parsed.value,sql=customersQuery(req.user.role,req.user.id,filters);
    const total=(await q('SELECT count(*)::int total FROM customers c WHERE '+sql.where,sql.params)).rows[0].total;
    const params=[...sql.params],limit=parameter(params,filters.limit),offset=parameter(params,filters.offset);
    const rows=(await q(CUSTOMER_SELECT+' FROM customers c LEFT JOIN requests r ON r.customer_id=c.id AND '+
      sql.joinFilter+' WHERE '+sql.where+' GROUP BY c.id ORDER BY c.created_at DESC,c.id DESC LIMIT '+limit+' OFFSET '+offset,params)).rows;
    return{data:safeCustomers(rows,req.user.role),meta:{page:filters.page,limit:filters.limit,total,pages:Math.ceil(total/filters.limit)}};
  });

  // Server-side equipment lookup: scope every row to the caller's accessible orders.
  // Owner, supervisor and accountant can inspect equipment without an order.
  app.get('/api/v1/directory/equipment',{preHandler:auth},async(req,reply)=>{
    if(!ALL_ROLES.has(req.user.role))return fail(reply,'FORBIDDEN','Недостаточно прав',403);
    const parsed=parseDirectoryQuery(req.query,'equipment');
    if(parsed.error)return fail(reply,'VALIDATION',parsed.error);
    const filters=parsed.value,params=[],where=['e.deleted_at IS NULL','c.deleted_at IS NULL'];
    if(!['OWNER','SUPERVISOR','ACCOUNTANT'].includes(req.user.role)){
      where.push('EXISTS (SELECT 1 FROM requests r WHERE r.equipment_id=e.id AND r.deleted_at IS NULL AND '+visibleRequest(params,req.user.role,req.user.id,'r')+')');
    }
    if(req.query.customer_id!=null){
      const customerId=Number(req.query.customer_id);
      if(!Number.isSafeInteger(customerId)||customerId<1)return fail(reply,'VALIDATION','Некорректный номер клиента');
      where.push('e.customer_id='+parameter(params,customerId));
    }
    if(filters.search){
      const p=parameter(params,escapeLike(filters.search));
      where.push('(e.category ILIKE '+p+" ESCAPE '\\' OR COALESCE(e.brand,'') ILIKE "+p+" ESCAPE '\\' OR "+
        "COALESCE(e.model,'') ILIKE "+p+" ESCAPE '\\' OR COALESCE(e.serial_number,'') ILIKE "+p+" ESCAPE '\\' OR "+
        "c.name ILIKE "+p+" ESCAPE '\\')");
    }
    const from=' FROM equipment e JOIN customers c ON c.id=e.customer_id',condition=where.join(' AND ');
    const total=(await q('SELECT count(*)::int total'+from+' WHERE '+condition,params)).rows[0].total;
    const p=[...params],limit=parameter(p,filters.limit),offset=parameter(p,filters.offset);
    const rows=(await q('SELECT e.id,e.customer_id,e.category,e.brand,e.model,e.serial_number,c.name customer_name'+
      from+' WHERE '+condition+' ORDER BY e.created_at DESC,e.id DESC LIMIT '+limit+' OFFSET '+offset,p)).rows;
    return{data:rows,meta:{page:filters.page,limit:filters.limit,total,pages:Math.ceil(total/filters.limit)}};
  });

  app.get('/api/v1/directory/orders/export',{preHandler:auth},async(req,reply)=>{
    if(!EXPORT_ROLES.has(req.user.role))return fail(reply,'FORBIDDEN','Экспорт доступен руководству и бухгалтерии',403);
    const parsed=parseDirectoryQuery(req.query,'orders');
    if(parsed.error)return fail(reply,'VALIDATION',parsed.error);
    const sql=ordersQuery(req.user.role,req.user.id,parsed.value);
    const rows=(await q(ORDER_SELECT+sql.from+' WHERE '+sql.where+ORDER_SORT+' LIMIT '+(MAX_EXPORT+1),sql.params)).rows;
    if(rows.length>MAX_EXPORT)return fail(reply,'EXPORT_LIMIT','Слишком много строк: выберите месяц или уточните фильтры',422);
    return xlsxReply(reply,'orders',ORDER_COLUMNS,rows.map(r=>[
      r.number,dateTime(r.created_at),r.customer_name,r.phone,[r.category,r.brand,r.model].filter(Boolean).join(' '),
      r.complaint,STATUS[r.status]||r.status,r.priority,r.engineer_name||'',dateTime(r.scheduled_at),
      amount(r.total),amount(r.paid),Math.max(0,amount(r.total)-amount(r.paid)),
      amount(r.direct_cost),amount(r.total)-amount(r.direct_cost),r.branch_code||''
    ]));
  });

  app.get('/api/v1/directory/customers/export',{preHandler:auth},async(req,reply)=>{
    if(!EXPORT_ROLES.has(req.user.role))return fail(reply,'FORBIDDEN','Экспорт доступен руководству и бухгалтерии',403);
    const parsed=parseDirectoryQuery(req.query,'customers');
    if(parsed.error)return fail(reply,'VALIDATION',parsed.error);
    const sql=customersQuery(req.user.role,req.user.id,parsed.value);
    const rows=(await q(CUSTOMER_SELECT+' FROM customers c LEFT JOIN requests r ON r.customer_id=c.id AND '+
      sql.joinFilter+' WHERE '+sql.where+' GROUP BY c.id ORDER BY c.created_at DESC,c.id DESC LIMIT '+(MAX_EXPORT+1),sql.params)).rows;
    if(rows.length>MAX_EXPORT)return fail(reply,'EXPORT_LIMIT','Слишком много строк: выберите месяц или уточните фильтры',422);
    return xlsxReply(reply,'customers',CUSTOMER_COLUMNS,rows.map(c=>[
      c.name,c.phone,c.email||'',c.address||'',c.request_count,amount(c.lifetime_paid),dateTime(c.created_at)
    ]));
  });
}
