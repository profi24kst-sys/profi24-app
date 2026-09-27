import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
const root=new URL('../../',import.meta.url);
const read=path=>readFileSync(new URL(path,root),'utf8');

test('legacy insecure server entrypoint cannot ship in working source or Docker API image',()=>{
  assert.equal(existsSync(new URL('server/src/index.js',root)),false,
    'Legacy three-role entrypoint must not remain next to the production API');
  const pkg=JSON.parse(read('server/package.json'));
  for(const [name,command] of Object.entries(pkg.scripts)){
    assert.doesNotMatch(command,/(?:node|nodemon)\\s+(?:\\.\\/)?src\\/index\\.js(?:\\s|$)/,
      'Active npm script '+name+' must not execute legacy entrypoint');
  }
  const dockerfile=read('server/Dockerfile');
  assert.match(dockerfile,/COPY --chown=node:node src \.\/src/);
  assert.match(pkg.scripts.start,/src\/index2\.js/);
});

test('secret-bearing environment variants and private keys are excluded from Git and Docker build contexts',()=>{
  const git=read('.gitignore'),server=read('server/.dockerignore'),web=read('web/.dockerignore');
  assert.match(git,/\*\*\/\.env\*/);
  assert.match(git,/!\*\*\/\.env\.example/);
  for(const [label,content] of [['server',server],['web',web]]){
    assert.match(content,/^\.env\*$/m,label+' build context must ignore private .env files');
    assert.match(content,/^\*\*\/\*\.pem$/m);
    assert.match(content,/^\*\*\/\*\.key$/m);
  }
  assert.ok(existsSync(new URL('.env.example',root)),'documented safe .env.example must remain');
});
