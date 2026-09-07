import bcrypt from 'bcryptjs';
import pg from 'pg';
import {pathToFileURL} from 'node:url';
import {migrateCore} from './migrate.js';

function setupError(code,message,statusCode=422){
  return Object.assign(new Error(message),{code,statusCode});
}

export async function createInitialOwner(pool,{name,email,password}){
  name=String(name||'').trim();
  email=String(email||'').trim().toLowerCase();
  password=String(password||'');
  if(!name)throw setupError('VALIDATION','Укажите имя собственника');
  if(!/^\S+@\S+\.\S+$/.test(email))throw setupError('VALIDATION','Укажите корректный email');
  if(password.length<10)throw setupError('VALIDATION','Пароль должен содержать минимум 10 символов');

  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const owner=(await client.query("SELECT id,email FROM users WHERE role='OWNER' LIMIT 1")).rows[0];
    if(owner)throw setupError('OWNER_ALREADY_EXISTS',`Первый собственник уже настроен: ${owner.email}`,409);
    const emailUser=(await client.query('SELECT id,role FROM users WHERE lower(email)=lower($1) LIMIT 1',[email])).rows[0];
    if(emailUser)throw setupError('EMAIL_ALREADY_EXISTS','Пользователь с таким email уже существует',409);
    const hash=await bcrypt.hash(password,12);
    const created=(await client.query("INSERT INTO users(name,email,password_hash,role,active) VALUES($1,$2,$3,'OWNER',true) RETURNING id,name,email,role,active,created_at",[name,email,hash])).rows[0];
    await client.query('COMMIT');
    return created;
  }catch(error){
    try{await client.query('ROLLBACK')}catch{}
    throw error;
  }finally{
    client.release();
  }
}

async function main(){
  const [email,password,...nameParts]=process.argv.slice(2);
  const name=nameParts.join(' ').trim()||'Собственник';
  if(!email||!password){
    console.error('Использование: npm run setup:owner -- owner@example.com "strong-password" "Имя собственника"');
    process.exitCode=1;
    return;
  }
  if(!process.env.DATABASE_URL){
    console.error('DATABASE_URL не задан');
    process.exitCode=1;
    return;
  }
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
  try{
    await migrateCore(pool);
    const owner=await createInitialOwner(pool,{name,email,password});
    console.log(`Первый собственник создан: ${owner.email}`);
  }catch(error){
    console.error(`${error.code||'SETUP_ERROR'}: ${error.message}`);
    process.exitCode=2;
  }finally{
    await pool.end();
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
