import {test} from 'node:test';
import assert from 'node:assert/strict';
import {contentDispositionAttachment,decodeDataUrl,detectSafeFileType,inspectUpload} from '../src/file-security.js';
import {canMutateOrder} from '../src/rbac.js';

const jpeg=Buffer.from([0xff,0xd8,0xff,0xe0,0,0,0,0]);
const png=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]);
const webp=Buffer.from('RIFF0000WEBPxxxx','ascii');
const pdf=Buffer.from('%PDF-1.7\n1 0 obj\n','ascii');
const heic=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypheic','ascii'),Buffer.alloc(16)]);

function dataUrl(mime,buf){return `data:${mime};base64,${buf.toString('base64')}`;}

test('file security detects only approved binary signatures',()=>{
  assert.equal(detectSafeFileType(jpeg)?.mime,'image/jpeg');
  assert.equal(detectSafeFileType(png)?.mime,'image/png');
  assert.equal(detectSafeFileType(webp)?.mime,'image/webp');
  assert.equal(detectSafeFileType(pdf)?.mime,'application/pdf');
  assert.equal(detectSafeFileType(heic)?.mime,'image/heic');
  assert.equal(detectSafeFileType(Buffer.from('<html><script>alert(1)</script></html>'))?.mime,undefined);
  assert.equal(detectSafeFileType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))?.mime,undefined);
});

test('file security rejects MIME and extension spoofing',()=>{
  assert.throws(()=>inspectUpload({buffer:jpeg,declaredMime:'text/html',originalName:'photo.jpg'}),e=>e.code==='FILE_TYPE_MISMATCH');
  assert.throws(()=>inspectUpload({buffer:jpeg,declaredMime:'image/jpeg',originalName:'payload.html'}),e=>e.code==='FILE_EXTENSION_MISMATCH');
  assert.throws(()=>inspectUpload({buffer:Buffer.from('<svg></svg>'),declaredMime:'image/svg+xml',originalName:'x.svg'}),e=>e.code==='UNSUPPORTED_FILE_TYPE');
  assert.throws(()=>inspectUpload({buffer:Buffer.from('console.log(1)'),declaredMime:'text/javascript',originalName:'x.js'}),e=>e.code==='UNSUPPORTED_FILE_TYPE');
});

test('generic browser MIME is accepted only when bytes are safe',()=>{
  const jpg=inspectUpload({buffer:jpeg,declaredMime:'application/octet-stream',originalName:'camera.jpg'});
  assert.equal(jpg.mime,'image/jpeg');
  assert.equal(jpg.extension,'.jpg');
  const p=inspectUpload({buffer:pdf,declaredMime:'application/octet-stream',originalName:'invoice.pdf'});
  assert.equal(p.mime,'application/pdf');
});

test('data URL decoder rejects malformed input and preserves verified payload',()=>{
  assert.deepEqual(decodeDataUrl(dataUrl('image/png',png)).buffer,png);
  assert.throws(()=>decodeDataUrl('data:text/html;base64,%%%%'),e=>e.code==='INVALID_FILE_ENCODING');
  assert.throws(()=>decodeDataUrl('data:image/png,not-base64'),e=>e.code==='INVALID_FILE_ENCODING');
});

test('download disposition removes header-control characters',()=>{
  const header=contentDispositionAttachment('evil\r\nX-Test: yes.pdf');
  assert.equal(header.includes('\r'),false);
  assert.equal(header.includes('\n'),false);
  assert.match(header,/^attachment;/);
});

test('trainee files are append-only',()=>{
  assert.equal(canMutateOrder('TRAINEE',{service:'documents',route:'/api/v1/requests/:id/files',method:'POST'}),true);
  assert.equal(canMutateOrder('TRAINEE',{service:'documents',route:'/api/v1/files/:id',method:'DELETE'}),false);
  assert.equal(canMutateOrder('TRAINEE',{service:'documents',route:'/api/v1/requests/:id/signatures',method:'POST'}),false);
});
