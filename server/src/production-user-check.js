import bcrypt from 'bcryptjs';
import pg from 'pg';
import {migrateCore} from './migrate.js';

const weakPasswords=['profi24','password','password1','qwerty','qwerty123','1234567890','admin12345','welcome123'];
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
try{
  await migrateCore(pool);
  const users=(await pool.query('SELECT id,email,role,password_hash FROM users WHERE active=true ORDER BY id')).rows;
  const owners=users.filter(x=>x.role==='OWNER');
  if(!owners.length){
    console.error('production_user_check_error: no active OWNER. Create the first owner with npm run bootstrap-owner.');
    process.exitCode=2;
  }else{
    const insecure=[];
    for(const user of users){
      for(const candidate of weakPasswords){
        if(await bcrypt.compare(candidate,user.password_hash)){
          insecure.push(`${user.email}:${candidate}`);
          break;
        }
      }
    }
    if(insecure.length){
      console.error(`production_user_check_error: weak legacy credentials detected for ${insecure.map(x=>x.split(':')[0]).join(', ')}`);
      console.error('Reset these passwords with npm run set-password before production startup.');
      process.exitCode=3;
    }else{
      console.log(`production_user_check_ok active_users=${users.length} active_owners=${owners.length}`);
    }
  }
}finally{
  await pool.end();
}
