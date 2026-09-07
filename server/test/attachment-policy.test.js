import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {ATTACHMENT_KINDS,isAttachmentKind} from '../src/attachment-policy.js';

const webFiles=[
  new URL('../../web/documents-addon.jsx',import.meta.url),
  new URL('../../web/engineer-mobile.jsx',import.meta.url),
  new URL('../../web/order-files.js',import.meta.url)
];

async function source(url){return fs.readFile(url,'utf8')}

function extractKinds(text){
  const out=new Set();
  for(const re of [
    /upload\([^)]*?['"]([A-Z][A-Z_]+)['"]\)/g,
    /<option\s+value=\\?['"]([A-Z][A-Z_]+)\\?['"]/g,
    /<option\s+value=['"]([A-Z][A-Z_]+)['"]/g
  ]){
    let match;while((match=re.exec(text)))out.add(match[1]);
  }
  return [...out];
}

test('attachment business kinds include before/after evidence',()=>{
  for(const kind of ['DEFECT_PHOTO','PHOTO_BEFORE','NAMEPLATE','PHOTO_AFTER','RECEIPT','OTHER'])assert.equal(isAttachmentKind(kind),true,kind);
  assert.equal(new Set(ATTACHMENT_KINDS).size,ATTACHMENT_KINDS.length,'attachment kinds must be unique');
});

test('frontend attachment kinds are accepted by documents service',async()=>{
  const discovered=new Set();
  for(const file of webFiles){for(const kind of extractKinds(await source(file)))discovered.add(kind)}
  for(const kind of discovered)assert.equal(isAttachmentKind(kind),true,`frontend uses unsupported attachment kind ${kind}`);
  for(const expected of ['PHOTO_BEFORE','PHOTO_AFTER','NAMEPLATE'])assert.equal(discovered.has(expected),true,`frontend evidence path missing ${expected}`);
});

test('frontend file pickers do not advertise executable or unsupported office formats',async()=>{
  const texts=await Promise.all(webFiles.map(source));
  const merged=texts.join('\n').toLowerCase();
  for(const ext of ['.doc','.docx','.xls','.xlsx','.svg','.html','.htm','.js','.txt']){
    assert.equal(merged.includes(`accept=\"image/*,.pdf,${ext}`),false,`unsafe picker pattern contains ${ext}`);
  }
  assert.equal(merged.includes('.doc,.docx'),false);
  assert.equal(merged.includes('.xls,.xlsx'),false);
});
