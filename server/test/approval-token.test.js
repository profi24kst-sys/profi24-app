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
  assert.throws(()=>approvalPublicToken(0));
 }finally{if(old===undefined)delete process.env.APPROVAL_TOKEN_SECRET;else process.env.APPROVAL_TOKEN_SECRET=old}
});
