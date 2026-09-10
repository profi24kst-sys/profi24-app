import bcrypt from 'bcryptjs';
import pg from 'pg';
import {pathToFileURL} from 'node:url';
import {migrateCore} from './migrate.js';
import {passwordPolicyError} from './access.js';

export const UAT_ACCOUNTS=[
 {key:'owner',name:'UAT Собственник',email:'uat.owner@local.test',role:'OWNER'},
 {key:'supervisor',name:'UAT Управляющий',email:'uat.supervisor@local.test',role:'SUPERVISOR'},
 {key:'accountant',name:'UAT Бухгалтер',email:'uat.accountant@local.test',role:'ACCOUNTANT'},
 {key:'manager',name:'UAT Менеджер',email:'uat.manager@local.test',role:'MANAGER'},
 {key:'engineer',name:'UAT Инженер',email:'uat.engineer@local.test',role:'ENGINEER'},
 {key:'trainee',name:'UAT Стажёр',email:'uat.trainee@local.test',role:'TRAINEE'}
];

export function assertLocalUatEnvironment(env=process.env){
 if(String(env.LOCAL_UAT||'')!=='1')throw Object.assign(new Error('LOCAL_UAT=1 обязателен для тестового bootstrap'),{code:'UAT_GUARD'});
 if(String(env.NODE_ENV||'').toLowerCase()==='production')throw Object.assign(new Error('UAT bootstrap запрещён при NODE_ENV=production'),{code:'UAT_PRODUCTION_GUARD'});
}

export async function ensureLocalUatAccounts(pool,{password,env=process.env}={}){
 assertLocalUatEnvironment(env);
 const policy=passwordPolicyError(password);if(policy)throw Object.assign(new Error(policy),{code:'PASSWORD_POLICY'});
 await migrateCore(pool);
 const branch=(await pool.query("SELECT id,code,name FROM branches WHERE code='KST' AND active=true LIMIT 1")).rows[0];
 if(!branch)throw new Error('Активный филиал KST не найден после миграции');
 const foreignOwner=(await pool.query("SELECT id,email FROM users WHERE role='OWNER' AND active=true AND lower(email)<>$1 ORDER BY id LIMIT 1",['uat.owner@local.test'])).rows[0];
 if(foreignOwner)throw Object.assign(new Error(`В базе уже есть другой активный OWNER: ${foreignOwner.email}. Для изолированного UAT используйте ops/start-local-uat.ps1 -ResetData.`),{code:'UAT_OWNER_CONFLICT'});
 const hash=await bcrypt.hash(password,12),created=[];
 for(const spec of UAT_ACCOUNTS){
  const existing=(await pool.query('SELECT id,email FROM users WHERE lower(email)=lower($1) ORDER BY id LIMIT 1',[spec.email])).rows[0];
  let row;
  if(existing){
   row=(await pool.query('UPDATE users SET name=$1,email=$2,password_hash=$3,role=$4,active=true,primary_branch_id=$5 WHERE id=$6 RETURNING id,name,email,role,primary_branch_id',[spec.name,spec.email,hash,spec.role,branch.id,existing.id])).rows[0];
  }else{
   row=(await pool.query('INSERT INTO users(name,email,password_hash,role,active,primary_branch_id) VALUES($1,$2,$3,$4,true,$5) RETURNING id,name,email,role,primary_branch_id',[spec.name,spec.email,hash,spec.role,branch.id])).rows[0];
  }
  created.push({...row,key:spec.key});
 }
 const engineer=created.find(x=>x.key==='engineer'),trainee=created.find(x=>x.key==='trainee'),owner=created.find(x=>x.key==='owner');
 await pool.query(`INSERT INTO user_mentors(trainee_id,mentor_id,assigned_by,assigned_at,updated_at) VALUES($1,$2,$3,now(),now()) ON CONFLICT(trainee_id) DO UPDATE SET mentor_id=EXCLUDED.mentor_id,assigned_by=EXCLUDED.assigned_by,updated_at=now()`,[trainee.id,engineer.id,owner.id]);
 return{branch,accounts:created.map(({key,...x})=>x),mentor:{trainee_id:trainee.id,mentor_id:engineer.id}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const password=process.argv[2];
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
 try{
  const result=await ensureLocalUatAccounts(pool,{password});
  console.log(`local_uat_accounts_ok branch=${result.branch.code} accounts=${result.accounts.length} mentor=${result.mentor.trainee_id}->${result.mentor.mentor_id}`);
  for(const x of result.accounts)console.log(`${x.role}\t${x.email}`);
 }catch(e){console.error(`local_uat_bootstrap_error code=${e.code||'ERROR'} message=${e.message}`);process.exitCode=1}finally{await pool.end()}
}
