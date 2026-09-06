import bcrypt from 'bcryptjs';
import pg from 'pg';
import {passwordPolicyError} from './access.js';

const [email,password]=process.argv.slice(2);
const policyError=passwordPolicyError(password);
if(!email||policyError){
  console.error(policyError||'Usage: node src/set-password.js <email> <password>');
  process.exit(1);
}
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
try{
  const hash=await bcrypt.hash(password,12);
  const result=await pool.query('UPDATE users SET password_hash=$1 WHERE lower(email)=lower($2) RETURNING id,email',[hash,email]);
  if(!result.rowCount){console.error('User not found');process.exitCode=2}else console.log(`Password updated for ${result.rows[0].email}`);
}finally{await pool.end();}
