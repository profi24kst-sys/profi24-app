import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {ATTACHMENT_KINDS,isAttachmentKind,normalizeAttachmentKind} from '../src/attachment-policy.js';

const webFiles=[
  new URL('../../web/documents-addon.jsx',import.meta.url),
  new URL('../../web/engineer-mobile.jsx',import.meta.url),
  new URL('../../web/order-files.js',import.meta.url)
];

async function source(url){return fs.readFile(url,'utf8')}

function extractKinds(text){
  const out=new Set();
  let match;
  const upload=/upload\([^)]*?['"]([A-Z][A-Z_]+)['"]\)/g;
  while((match=upload.exec(text)))out.add(match[1]);

  // The direct order-files widget passes kind.value into uploadFiles, so its
  // attachment kinds live in the dedicated data-kind select. Do not scan
  // unrelated selects (for example CLIENT/ENGINEER signature type options).
  const kindSelect=/<select[^>]*\bdata-kind\b[^>]*>([\s\S]*?)<\/select>/g;
  while((match=kindSelect.exec(text))){
    const block=match[1];
    const option=/<option\s+value=\\?['"]([A-Z][A-Z_]+)\\?['"]/g;
    let item;while((item=option.exec(block)))out.add(item[1]);
  }
  return [...out];
}

test('attachment business kinds include before/after evidence',()=>{
  for(const kind of ['DEFECT_PHOTO','PHOTO_BEFORE','NAMEPLATE','PHOTO_AFTER','RECEIPT','OTHER'])assert.equal(isAttachmentKind(kind),true,kind);
  assert.equal(new Set(ATTACHMENT_KINDS).size,ATTACHMENT_KINDS.length,'attachment kinds must be unique');
});

test('legacy Order360 attachment aliases normalize to canonical kinds',()=>{
  assert.equal(normalizeAttachmentKind('DEFECT'),'DEFECT_PHOTO');
  assert.equal(normalizeAttachmentKind('AFTER'),'PHOTO_AFTER');
  assert.equal(normalizeAttachmentKind('photo_before'),'PHOTO_BEFORE');
  assert.equal(isAttachmentKind('DEFECT'),true);
  assert.equal(isAttachmentKind('AFTER'),true);
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
