import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

function run(env={}){
  return spawnSync('sh',['docker-entrypoint.sh','sh','-c','exit 0'],{
    cwd:new URL('..',import.meta.url),
    env:{...process.env,...env},
    encoding:'utf8'
  });
}

test('production runtime guard rejects missing JWT secret',()=>{
  const r=run({NODE_ENV:'production',DATABASE_URL:'postgresql://u:p@db:5432/x',JWT_SECRET:'',CORS_ORIGIN:'https://crm.example.kz'});
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/JWT_SECRET is required/);
});

test('production runtime guard rejects placeholder JWT secret',()=>{
  const r=run({NODE_ENV:'production',DATABASE_URL:'postgresql://u:p@db:5432/x',JWT_SECRET:'replace-with-a-long-random-secret-at-least-32-characters',CORS_ORIGIN:'https://crm.example.kz'});
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/placeholder|predictable/);
});

test('production runtime guard accepts hardened runtime env',()=>{
  const r=run({NODE_ENV:'production',DATABASE_URL:'postgresql://u:p@db:5432/x',JWT_SECRET:'2f9fefb0cf8f49ea8e72e2e2dbf33bb2e8e5f29a5bb6468fa5353e0d6c1f98bf',CORS_ORIGIN:'https://crm.example.kz'});
  assert.equal(r.status,0,r.stderr);
});

test('development runtime may use local example values',()=>{
  const r=run({NODE_ENV:'development',DATABASE_URL:'',JWT_SECRET:'dev-secret-change-me',CORS_ORIGIN:'http://localhost:5173'});
  assert.equal(r.status,0,r.stderr);
});
