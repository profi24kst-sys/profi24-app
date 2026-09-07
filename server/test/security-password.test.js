import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {installOrderAccess,passwordPolicyError} from '../src/access.js';

test('password policy rejects weak defaults and accepts a real temporary password',()=>{
  assert.ok(passwordPolicyError(''));
  assert.ok(passwordPolicyError('profi24'));
  assert.ok(passwordPolicyError('abcdefghij'));
  assert.ok(passwordPolicyError('1234567890'));
  assert.equal(passwordPolicyError('TempKst2026X'),null);
});

test('shared index2 security hook blocks weak user passwords before legacy routes',async()=>{
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  const pool={query,connect:async()=>({query,release(){}})};
  await migrateCore(pool);
  await query("INSERT INTO users(name,email,password_hash,role,active) VALUES('Security Owner','security-owner@test.invalid','unused','OWNER',true)");

  const app=Fastify({logger:false});
  await app.register(jwt,{secret:'test-security-jwt-value-12345678901234567890'});
  installOrderAccess(app,pool,'index2');
  app.post('/api/v1/users',async()=>({data:{ok:true}}));
  app.post('/api/v1/users/:id/password',async()=>({data:{ok:true}}));
  await app.ready();
  const token=app.jwt.sign({id:1,role:'OWNER'});
  const call=(url,payload)=>app.inject({method:'POST',url,payload,headers:{authorization:'Bearer '+token}});

  const missing=await call('/api/v1/users',{name:'Engineer',email:'e@test.invalid',role:'ENGINEER'});
  assert.equal(missing.statusCode,422);assert.equal(missing.json().error.code,'WEAK_PASSWORD');
  const legacy=await call('/api/v1/users',{name:'Engineer',email:'e@test.invalid',role:'ENGINEER',password:'profi24'});
  assert.equal(legacy.statusCode,422);assert.equal(legacy.json().error.code,'WEAK_PASSWORD');
  const shortReset=await call('/api/v1/users/2/password',{password:'Abc123'});
  assert.equal(shortReset.statusCode,422);assert.equal(shortReset.json().error.code,'WEAK_PASSWORD');
  const strong=await call('/api/v1/users',{name:'Engineer',email:'e@test.invalid',role:'ENGINEER',password:'TempKst2026X'});
  assert.equal(strong.statusCode,200,strong.body);
  const strongReset=await call('/api/v1/users/2/password',{password:'NewPass2026Kst'});
  assert.equal(strongReset.statusCode,200,strongReset.body);

  await app.close();await db.close();
});
