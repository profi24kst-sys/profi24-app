import {test} from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {createInitialOwner} from '../src/bootstrap-owner.js';

async function fixture(){
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  const pool={query,connect:async()=>({query,release(){}})};
  await migrateCore(pool);
  return {db,pool,query};
}

test('первый собственник создаётся штатно без ручного SQL',async()=>{
  const {db,pool,query}=await fixture();
  try{
    const owner=await createInitialOwner(pool,{name:'Александр',email:'owner@example.com',password:'StrongPass123!'});
    assert.equal(owner.role,'OWNER');
    assert.equal(owner.active,true);
    const stored=(await query('SELECT * FROM users WHERE id=$1',[owner.id])).rows[0];
    assert.equal(stored.email,'owner@example.com');
    assert.equal(await bcrypt.compare('StrongPass123!',stored.password_hash),true);
  }finally{await db.close();}
});

test('повторная первичная настройка не создаёт второго собственника',async()=>{
  const {db,pool}=await fixture();
  try{
    await createInitialOwner(pool,{name:'Первый',email:'first@example.com',password:'StrongPass123!'});
    await assert.rejects(
      createInitialOwner(pool,{name:'Второй',email:'second@example.com',password:'AnotherPass123!'}),
      error=>error.code==='OWNER_ALREADY_EXISTS'&&error.statusCode===409
    );
  }finally{await db.close();}
});

test('слабый пароль и некорректный email отклоняются до записи',async()=>{
  const {db,pool}=await fixture();
  try{
    await assert.rejects(createInitialOwner(pool,{name:'Owner',email:'bad-email',password:'StrongPass123!'}),error=>error.code==='VALIDATION');
    await assert.rejects(createInitialOwner(pool,{name:'Owner',email:'owner@example.com',password:'short'}),error=>error.code==='VALIDATION');
  }finally{await db.close();}
});
