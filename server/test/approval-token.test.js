import test from 'node:test';
import assert from 'node:assert/strict';
import {approvalPublicToken,approvalIdFromPublicToken} from '../src/approval-token.js';

test('approval public token is deterministic, signed and rejects tampering',()=>{
 const old=process.env.APPROVAL_TOKEN_SECRET;process.env.APPROVAL_TOKEN_SECRET='approval-test-secret';
 try{
  const token=approvalPublicToken(42);
  assert.match(token,/^v2\.42\.[A-Za-z0-9_-]{43}$/);
  assert.equal(approvalPublicToken(42),token);
  assert.equal(approvalIdFromPublicToken(token),42);
  assert.equal(approvalIdFromPublicToken(token.replace('v2.42.','v2.43.')),null);
  assert.equal(approvalIdFromPublicToken(token.slice(0,-1)+(token.endsWith('A')?'B':'A')),null);
  assert.equal(approvalIdFromPublicToken('legacy-plaintext-token'),null);
  const jwt=process.env.JWT_SECRET;
  process.env.JWT_SECRET='rotated-auth-secret-one';
  const stable=approvalPublicToken(42);
  process.env.JWT_SECRET='rotated-auth-secret-two';
  assert.equal(approvalPublicToken(42),stable);
  assert.equal(approvalIdFromPublicToken(stable),42);
  process.env.APPROVAL_TOKEN_SECRET='different-approval-secret-value';
  assert.equal(approvalIdFromPublicToken(stable),null);
  process.env.APPROVAL_TOKEN_SECRET='approval-test-secret';
  if(jwt===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=jwt;
  assert.throws(()=>approvalPublicToken(0));
 }finally{if(old===undefined)delete process.env.APPROVAL_TOKEN_SECRET;else process.env.APPROVAL_TOKEN_SECRET=old}
});


test('approval token refuses missing or placeholder secret in production',()=>{
 const oldSecret=process.env.APPROVAL_TOKEN_SECRET,oldNodeEnv=process.env.NODE_ENV;
 try{
  process.env.NODE_ENV='production';
  delete process.env.APPROVAL_TOKEN_SECRET;
  assert.throws(()=>approvalPublicToken(1),/APPROVAL_TOKEN_SECRET is required/);
  process.env.APPROVAL_TOKEN_SECRET='change-me-approval-token-secret';
  assert.throws(()=>approvalPublicToken(1),/non-placeholder production secret/);
  process.env.APPROVAL_TOKEN_SECRET='0123456789abcdef0123456789abcdef';
  const token=approvalPublicToken(1);
  assert.equal(approvalIdFromPublicToken(token),1);
 }finally{
  if(oldSecret===undefined)delete process.env.APPROVAL_TOKEN_SECRET;else process.env.APPROVAL_TOKEN_SECRET=oldSecret;
  if(oldNodeEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=oldNodeEnv;
 }
});
