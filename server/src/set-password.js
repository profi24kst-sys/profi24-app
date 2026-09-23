import bcrypt from 'bcryptjs';
import pg from 'pg';
import {passwordPolicyError} from './access.js';
import {revokeUserRefreshSessions} from './auth-session.js';

const [email,password]=process.argv.slice(2);
const policyError=passwordPolicyError(password);
if(!email||policyError){
  console.error(policyError||'Usage: node src/set-password.js <email> <password>');
  process.exit(1);
}
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
try{
  const hash=await bcrypt.hash(password,12);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const result=await client.query('UPDATE users SET password_hash=$1 WHERE lower(email)=lower($2) RETURNING id,email',[hash,email]);
    if(!result.rowCount){
      await client.query('ROLLBACK');
      console.error('User not found');
      process.exitCode=2;
    }else{
      await revokeUserRefreshSessions(client,result.rows[0].id);
      await client.query('COMMIT');
      console.log(`Password updated for ${result.rows[0].email}; active browser sessions revoked`);
    }
  }catch(error){
    try{await client.query('ROLLBACK')}catch{}
    throw error;
  }finally{client.release();}
}finally{await pool.end();}
