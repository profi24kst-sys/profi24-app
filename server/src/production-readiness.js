import pg from 'pg';

export const DEFAULT_REQUIRED_ROLES=['OWNER','ACCOUNTANT','MANAGER','ENGINEER'];

function parseRoles(value){
  return String(value||DEFAULT_REQUIRED_ROLES.join(','))
    .split(',').map(x=>x.trim().toUpperCase()).filter(Boolean);
}

export async function assessProductionReadiness(pool,{env=process.env}={}){
  const blockers=[];
  const warnings=[];
  const requiredRoles=parseRoles(env.GO_LIVE_REQUIRED_ROLES);
  const [branchesResult,usersResult,accountsResult]=await Promise.all([
    pool.query(`SELECT b.id,b.code,b.name,
      count(DISTINCT u.id) FILTER(WHERE u.active=true)::int active_users,
      count(DISTINCT u.id) FILTER(WHERE u.active=true AND u.role='MANAGER')::int managers,
      count(DISTINCT u.id) FILTER(WHERE u.active=true AND u.role='ENGINEER')::int engineers
      FROM branches b LEFT JOIN user_branches ub ON ub.branch_id=b.id
      LEFT JOIN users u ON u.id=ub.user_id WHERE b.active=true
      GROUP BY b.id,b.code,b.name ORDER BY b.id`),
    pool.query(`SELECT role,count(*)::int count FROM users WHERE active=true GROUP BY role`),
    pool.query(`SELECT branch_id,type,count(*)::int count FROM finance_accounts
      WHERE is_active=true GROUP BY branch_id,type`)
  ]);
  const branches=branchesResult.rows;
  const roles=Object.fromEntries(usersResult.rows.map(x=>[x.role,Number(x.count)]));
  const accounts=new Map(accountsResult.rows.map(x=>[`${x.branch_id}:${x.type}`,Number(x.count)]));

  if(!branches.length)blockers.push('Нет активного филиала');
  for(const role of requiredRoles)if(!roles[role])blockers.push(`Нет активного сотрудника с ролью ${role}`);
  for(const branch of branches){
    if(!Number(branch.managers))blockers.push(`Филиал ${branch.code}: не назначен активный менеджер`);
    if(!Number(branch.engineers))blockers.push(`Филиал ${branch.code}: не назначен активный инженер`);
    if(!accounts.get(`${branch.id}:CASH`))blockers.push(`Филиал ${branch.code}: нет активной кассы CASH`);
    if(!accounts.get(`${branch.id}:BANK`)&&!accounts.get(`${branch.id}:CARD`))blockers.push(`Филиал ${branch.code}: нет активного счёта BANK/CARD`);
  }
  const orphaned=(await pool.query(`SELECT count(*)::int count FROM users u WHERE u.active=true AND
    (u.primary_branch_id IS NULL OR NOT EXISTS(SELECT 1 FROM user_branches ub WHERE ub.user_id=u.id AND ub.branch_id=u.primary_branch_id))`)).rows[0];
  if(Number(orphaned.count))blockers.push(`У ${orphaned.count} активных сотрудников не настроен основной филиал`);

  if(!env.WHATSAPP_TOKEN||!env.WHATSAPP_PHONE_NUMBER_ID)blockers.push('Не настроена отправка WhatsApp');
  if(!env.WEBSITE_INTAKE_SECRET)warnings.push('Не настроен приём заявок с сайта');
  if(!env.TELEGRAM_BOT_TOKEN)warnings.push('Не настроены Telegram-уведомления инженерам');

  return {ok:blockers.length===0,blockers,warnings,summary:{active_branches:branches.length,active_users:Object.values(roles).reduce((a,b)=>a+b,0),required_roles:requiredRoles}};
}

async function main(){
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
  try{
    const result=await assessProductionReadiness(pool);
    for(const warning of result.warnings)console.warn(`production_readiness_warning: ${warning}`);
    if(!result.ok){
      for(const blocker of result.blockers)console.error(`production_readiness_error: ${blocker}`);
      process.exitCode=4;
      return;
    }
    console.log(`production_readiness_ok active_branches=${result.summary.active_branches} active_users=${result.summary.active_users}`);
  }finally{await pool.end();}
}

if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href)await main();
