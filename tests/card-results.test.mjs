import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {CardStore} from '../src/card-store.mjs';
import {cardCommand} from '../src/card-command.mjs';
import {createDatabase,writeStorageMarker,appendStream} from '../src/storage.mjs';
import {importStorage,exportStorage,storageCommand} from '../src/storage-migration.mjs';

for(const backend of ['jsonl','sqlite']) {
 function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-card-results-'));
  const home=path.join(root,'state'),repoPath=path.join(root,'repo');
  fs.mkdirSync(home);fs.mkdirSync(repoPath);
  if(backend==='sqlite'){createDatabase(home);writeStorageMarker(home,'sqlite');}
  const cards=new CardStore(home),card=cards.create({repo:'test',id:'execution',repoPath,body:'# 지시 원문'});
  return {root,home,repoPath,cards,card};
 }
 test(`${backend}: 중앙 결과 등록·지문·재호출, 저장소 이동 뒤에도 근거 보존`,()=>{
  const f=fixture(),{cards,card,home}=f;
  assert.equal(card.resultPath,path.join(home,'cards','test','execution','result.md'));
  assert.equal(fs.statSync(card.evidenceDir).mode&0o777,0o700);
  assert.equal(fs.existsSync(card.resultPath),false);
  fs.writeFileSync(card.resultPath,'검증 결과 원문');
  fs.writeFileSync(path.join(card.evidenceDir,'test.log'),'시험 통과');
  const report=revision=>cardCommand(['report',card.key],{revision,outcome:'implemented'},{home,by:'worker'});
  const saved=report(card.revision);
  assert.equal(saved.status,card.status,'결과 저장은 상태나 DONE을 바꾸지 않는다');
  assert.equal(saved.body,card.body);
  assert.equal(saved.result.sha256,createHash('sha256').update('검증 결과 원문').digest('hex'));
  assert.equal(saved.result.bytes,Buffer.byteLength('검증 결과 원문'));
  assert.equal(saved.result.path,card.resultPath);assert.equal(saved.result.by,'worker');
  assert.deepEqual(saved.history.slice(0,-1),card.history);
  assert.equal(report(saved.revision).revision,saved.revision);
  assert.throws(()=>report(card.revision),/변경됨/);
  assert.deepEqual(fs.readdirSync(f.repoPath),[]);
  fs.renameSync(f.repoPath,path.join(f.root,'moved-repo'));
  assert.equal(fs.readFileSync(cards.get(card.key).result.path,'utf8'),'검증 결과 원문');
  assert.equal(fs.readFileSync(path.join(cards.get(card.key).evidenceDir,'test.log'),'utf8'),'시험 통과');
  fs.appendFileSync(card.resultPath,'다른 결과');
  assert.throws(()=>report(saved.revision),/이미 등록한 결과/);
  assert.equal(cards.get(card.key).revision,saved.revision);
 });
 test(`${backend}: 빈 결과·외부 경로·다른 실행 결과 거절, 실행별 결과 분리`,()=>{
  const {home,repoPath,cards,card}=fixture();
  const report=options=>cards.report(card.key,{revision:1,outcome:'ok',...options});
  assert.throws(()=>report({}),/ENOENT/);
  fs.writeFileSync(card.resultPath,'');assert.throws(()=>report({}),/빈 결과/);
  const next=cards.create({repo:'test',id:'review',repoPath,body:'# 독립검수'});
  fs.writeFileSync(next.resultPath,'검수 원문');
  assert.throws(()=>report({resultFile:next.resultPath}),/resultPath/);
  fs.renameSync(card.resultPath,path.join(home,'empty-result'));
  fs.symlinkSync(next.resultPath,card.resultPath);
  assert.throws(()=>report({}),/일반 파일/);
  assert.equal(cards.get(card.key).revision,1);
  assert.equal(fs.readFileSync(next.resultPath,'utf8'),'검수 원문');
 });
 test(`${backend}: 기존 카드 조회는 무변경, 지정 결과 경로와 링크 보존`,()=>{
  const {home,repoPath,cards,card}=fixture(),key='test/legacy';
  const {artifactLayout,...old}=card.history[0];
  const dir=cards.dir(key);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'card.md'),'# 옛 지시');
  appendStream(home,`cards/${key}/events.jsonl`,{...old,key,id:'legacy'});
  const before=cards.get(key),files=fs.readdirSync(dir);
  assert.equal(before.resultPath,undefined);assert.equal(before.evidenceDir,undefined);
  assert.deepEqual(fs.readdirSync(dir),files);
  assert.throws(()=>cards.report(key,{revision:1,outcome:'ok'}),/기존 카드/);
  const source=path.join(repoPath,'old-result.md'),link=path.join(repoPath,'old-result-link.md');
  fs.writeFileSync(source,'옛 결과');fs.symlinkSync(source,link);
  const saved=cards.report(key,{revision:1,outcome:'ok',resultFile:link});
  assert.equal(saved.result.path,link);assert.equal(fs.readFileSync(source,'utf8'),'옛 결과');
  assert.deepEqual(saved.history.slice(0,-1),before.history);
  assert.equal(fs.existsSync(path.join(dir,'evidence')),false);
 });
}

test('기존 저장소 이전·내보내기가 결과 원문·근거·등록 이력을 함께 보존한다',()=>{
 const source=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-results-backup-'));
 const cards=new CardStore(source),card=cards.create({repo:'test',id:'a',repoPath:source,body:'# 지시'});
 fs.writeFileSync(card.resultPath,'보존할 결과');fs.writeFileSync(path.join(card.evidenceDir,'check.log'),'검증 원문');
 const saved=cards.report(card.key,{revision:1,outcome:'ok'});
 const target=source+'-sqlite',output=source+'-export';
 importStorage(source,target);storageCommand(['pause'],{},{home:target});exportStorage(target,output);
 for(const home of [source,target,output]){
  const copied=new CardStore(home).get(card.key);
  assert.deepEqual(copied.history,saved.history);
  assert.equal(fs.readFileSync(copied.resultPath,'utf8'),'보존할 결과');
  assert.equal(fs.readFileSync(path.join(copied.evidenceDir,'check.log'),'utf8'),'검증 원문');
 }
});
