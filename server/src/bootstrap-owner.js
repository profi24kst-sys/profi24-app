import bcrypt from 'bcryptjs';
import pg from 'pg';
import {migrateCore} from './migrate.js';
import {passwordPolicyError} from './access.js';

const [emailArg,password,nameArg]=process.argv.slice(2);
const email=String(emailArg||'').trim().toLowerCase();
const name=String(nameArg||'Собственник').trim();
const policyError=passwordPolicyError(password);
if(!email||!email.includes('@')||name.length<2||policyError){
  console.error(policyError||'Usage: node src/bootstrap-owner.js <email> <strong-password> [name]');
  process.exit(1);
}

const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
try{
  await migrateCore(pool);
  const existingOwner=(await pool.query("SELECT id,email FROM users WHERE role='OWNER' AND active=true ORDER BY id LIMIT 1")).rows[0];
  if(existingOwner){
    console.error(`Active OWNER already exists: ${existingOwner.email}. Bootstrap is only for the first owner.`);
    process.exitCode=3;
  }else{
    const existingEmail=(await pool.query('SELECT id,role,active FROM users WHERE lower(email)=lower($1)',[email])).rows[0];
    if(existingEmail){
      console.error('This email already exists. Use normal account administration instead of bootstrap.');
      process.exitCode=4;
    }else{
      const hash=await bcrypt.hash(password,12);
      const branch=(await pool.query("SELECT id FROM branches WHERE code='KST' AND active=true LIMIT 1")).rows[0];
      if(!branch)throw new Error('Active KST branch not found after migration');
      const owner=(await pool.query("INSERT INTO users(name,email,password_hash,role,active,primary_branch_id) VALUES($1,$2,$3,'OWNER',true,$4) RETURNING id,name,email,role,primary_branch_id",[name,email,hash,branch.id])).rows[0];
      console.log(`bootstrap_owner_ok id=${owner.id} email=${owner.email} branch_id=${owner.primary_branch_id}`);
    }
  }
}finally{
  await pool.end();
}
