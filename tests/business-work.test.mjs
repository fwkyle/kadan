import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDatabase,writeStorageMarker,readStream,appendStream} from '../src/storage.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {CardStore} from '../src/card-store.mjs';
import {workCommand} from '../src/work-command.mjs';
import {SecretaryMailbox} from '../src/secretary-mailbox.mjs';
import {Mailbox} from '../src/mailbox.mjs';
import {resolveWorkMail,workLetters} from '../src/work-mail.mjs';
import {appendLedger,readLedger} from '../src/ledger.mjs';
import {buildCardCenter} from '../src/card-center.mjs';
import {workDashboardModel} from '../src/work-dashboard.mjs';
import {renderCenterWall} from '../src/center-wall.mjs';
import {createWallServer} from '../src/wall.mjs';
import {filterWorkspaceRows} from '../src/dashboard-workspace.mjs';
import {importStorage,exportStorage,verifyStorage} from '../src/storage-migration.mjs';

function fixture(mode='sqlite'){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-business-work-'));
 if(mode==='sqlite'){createDatabase(home);writeStorageMarker(home,'sqlite');}
 const store=new WorkStore(home),cards=new CardStore(home);
 const create=(id='photos')=>store.create({key:'repo/'+id,title:'제품 사진 생성·연결',goal:'전체 제품에서 사진을 확인',scope:'등록 제품 244개',acceptance:'생성·연결·화면 검수와 누락 확인',owner:'감독',repoPath:home,board:'제품'});
 const work=create();
 const change=(action,fields={},extra={})=>store.change(work.key,action,fields,{revision:store.get(work.key).revision,by:'감독',note:'명시적으로 확인',...extra});
 return {home,store,cards,work,create,change};
}
for(const mode of ['jsonl','sqlite'])test(`${mode}: 병렬 실행·검수·재수정은 같은 업무에 남고 실행 종료는 업무를 완료하지 않는다`,()=>{
 const {home,store,cards,work,change}=fixture(mode);
 for(const phase of ['implementation','release','review','fix'])change('execute',{title:phase,body:'허용한 작업만 수행하고 결과를 기록',phase,round:phase==='fix'?'2':'1'});
 const executions=store.get(work.key).executions;
 assert.equal(new Set(executions.map(x=>x.key)).size,4);
 assert.ok(executions.every(x=>x.key!==work.key));assert.equal(cards.list().length,4);
 assert.throws(()=>change('complete',{result:'모두 확인'}),/끝나지 않은 실행/);
 assert.throws(()=>change('update',{status:'done'}),/최종 완료/);
 for(const x of executions)cards.update(x.key,{status:'done'},{revision:1,note:'이번 실행 종료',by:'작업자'});
 assert.equal(store.get(work.key).status,'open');
 assert.throws(()=>change('complete',{result:'완료 주장'},{by:'작업자'}),/책임 감독/);
 assert.throws(()=>change('complete',{result:''}),/근거/);
 const done=change('complete',{result:'전체 244개 화면 검수 결과: 확인한 문서 경로'});
 assert.equal(done.status,'done');assert.equal(done.executions.length,4);
 const old=JSON.stringify(done.history);change('reopen');change('execute',{title:'후속 수정',body:'기존 결과의 문제 수정',phase:'fix',round:'3'});
 assert.equal(store.get(work.key).executions.length,5);assert.equal(store.get(work.key).status,'open');
 assert.equal(JSON.stringify(store.get(work.key).history.slice(0,done.revision)),old);
 assert.equal(readLedger(home).length,0,'업무 등록·연결은 에이전트 발령이 아니다');
});
test('연결은 기존 실행 원본을 보존하고 중복 업무 연결·오래된 버전·없는 대상을 거절한다',()=>{
 const {store,cards,work,create,change}=fixture();
 const card=cards.create({repo:'repo',id:'old-card',repoPath:work.repoPath,body:'기존 지시문'}),before=cards.get(card.key);
 change('link',{execution:card.key,phase:'implementation',round:'1'});
 assert.deepEqual(cards.get(card.key),before);
 const other=create('another');
 assert.throws(()=>store.change(other.key,'link',{execution:card.key,phase:'review',round:'1'},{revision:1,note:'이중 연결'}),/다른 업무/);
 assert.throws(()=>change('link',{execution:'repo/missing',phase:'review',round:'1'}));
 assert.throws(()=>change('update',{progress:'지난 화면에서 작성'},{revision:1}),/변경됨/);
 change('unlink',{execution:card.key});
 assert.deepEqual(cards.get(card.key),before);assert.equal(store.get(work.key).history[1].executions[0].key,card.key);
 assert.throws(()=>store.get('../oops'),/업무 주소/);
});
test('기존 SQLite 인박스의 업무 참조·답장·읽음은 한 원장을 쓰며 조회가 읽음을 만들지 않는다',()=>{
 const {home,store,cards,work,change}=fixture();
 change('execute',{title:'사진 생성',body:'지시',phase:'implementation',round:1});
 const execution=store.get(work.key).executions[0].key,mail=new SecretaryMailbox(home);
 const first=mail.send({by:'감독',message:'생성 실행 결과를 확인해 주세요',workKey:work.key,executionKey:execution});
 const reply=new Mailbox(home,'감독').send({by:'비서',message:'남은 다섯 장을 이어 처리합니다',replyTo:first.mailId});
 mail.send({by:'다른감독',message:'관계 없는 업무'});
 const entries=readLedger(home),letters=workLetters(store.get(work.key),entries,cards.list());
 assert.equal(letters.length,2);assert.ok(letters.every(x=>x.workKey===work.key&&x.executionKey===execution));
 assert.equal(mail.list().length,2);assert.equal(readStream(home,'mail/events.jsonl').length,3);
 assert.deepEqual(resolveWorkMail(home,{taskId:execution.split('/')[1]}),{workKey:work.key,executionKey:execution});
 assert.throws(()=>mail.send({by:'감독',message:'잘못된 연결',workKey:'repo/no-work',replyTo:reply.mailId}),/다릅니다/);
 new Mailbox(home,'감독').acknowledge(reply.mailId,'감독');
 assert.equal(workLetters(store.get(work.key),readLedger(home),cards.list()).find(x=>x.mailId===reply.mailId).read,true);
 assert.equal(readStream(home,'mail/events.jsonl').length,4);
});
test('과거 task 연결만 복원하고 본문 키워드·중복 ID로 임의 묶지 않는다',()=>{
 const {home,work,store,cards,change}=fixture();
 const c=cards.create({repo:'repo',id:'old',repoPath:home,body:'old'});
 change('link',{execution:c.key,phase:'implementation',round:1});
 appendLedger({kind:'send',by:'감독',role:'작업자',taskId:'old',digest:'a'},home);
 appendLedger({kind:'send',by:'감독',role:'작업자',preview:'사진 생성·연결 old 준비수신'},home);
 assert.equal(workLetters(store.get(work.key),readLedger(home),cards.list()).length,1);
 cards.create({repo:'another',id:'old',repoPath:home,body:'다른 원본'});
 assert.equal(workLetters(store.get(work.key),readLedger(home),cards.list()).length,0);
});
test('업무 기록 손상·원장 손상은 완료와 정상 화면으로 둔갑하지 않는다',()=>{
 const {home,store,work,change}=fixture();
 appendStream(home,`works/${work.key}/events.jsonl`,{...work,revision:99});assert.throws(()=>store.list(),/이력 손상/);
 const html=renderCenterWall({home,center:buildCardCenter({cards:[],entries:[],tree:[]}),entries:[]});assert.match(html,/업무 상태 모름/);
 assert.throws(()=>workLetters(work,[{broken:'손상'}],[]),/원장 손상/);
 assert.throws(()=>change('complete',{result:'잘못된 완료'}),/이력 손상/);
});
test('업무 표 기본값·내부 실행 링크·완료 대기·가벼운 목록 데이터',()=>{
 const {home,work,store,cards,change}=fixture();
 change('execute',{title:'검수',body:'원본 비공개 지시',phase:'review',round:2});
 const execution=store.get(work.key).executions[0].key;
 cards.update(execution,{status:'done'},{revision:1,note:'실행 결과 독점본문'});
 const snapshot={home,center:buildCardCenter({cards:cards.list(),entries:[],tree:[]}),entries:[]};
 const models=workDashboardModel(store.list(),snapshot.center,[]);
 assert.equal(models[0].turnLabel,'감독');assert.match(models[0].flowLabel,/2라운드 · 감독 최종 확인/);assert.equal(models[0].stateLabel,'진행 중');
 const html=renderCenterWall(snapshot,{url:new URL('http://localhost/?card=work:repo/photos')});
 const data=JSON.parse(html.match(/id="dw-data">([^<]+)</)[1]);
 assert.equal(data.state.collection,'work');assert.equal(data.rows.length,2);assert.ok(data.rows.every(x=>!x.executions&&!x.history&&!x.body&&!x.letters));assert.ok(data.rows.filter(x=>x.kind==='work').every(x=>x.workKey),'업무 행은 관계도 연결에 쓸 workKey를 남긴다');
 assert.equal(filterWorkspaceRows(data.rows,{collection:'work',state:'all'}).length,1);
 assert.equal(filterWorkspaceRows(data.rows,{collection:'unlinked',state:'all'}).length,0);
 assert.ok(!JSON.stringify(data).includes('원본 비공개 지시'));assert.match(html,/data-card-key="repo\/exec-/);
 const legacy=renderCenterWall(snapshot,{url:new URL('http://localhost/?card='+execution)});
 assert.match(legacy,/이 화면은 업무 안의 실행/);
});
test('업무 표는 병행 대신 남은 실행 수를 말한다',()=>{
 const {home,work,store,cards,change}=fixture();
 change('execute',{title:'구현',body:'허용한 작업만 수행',phase:'implementation',round:1});
 change('execute',{title:'검수',body:'허용한 작업만 수행',phase:'review',round:1});
 const [first,second]=store.get(work.key).executions;
 cards.update(first.key,{status:'done'},{revision:1,note:'구현 종료',by:'작업자'});
 const center=buildCardCenter({cards:cards.list(),entries:[],tree:[]});
 const model=workDashboardModel(store.list(),center,[])[0];
 assert.equal(model.flowPhase,'실행 1/2건 종료 · 남은 실행 1건 · 업무는 미완료');
 assert.doesNotMatch(model.flowPhase,/병행/);
 const html=renderCenterWall({home,center,entries:[]},{url:new URL('http://localhost/?collection=work&state=all')});
 assert.match(html,/남은 실행 1건/);
 assert.ok(!html.includes('건 병행'));
});

test('웹 업무 쓰기는 출처·토큰·버전을 확인하고 실행을 시작하지 않는다',async()=>{
 const {home,store,cards,work}=fixture();
 const server=createWallServer(()=>({center:buildCardCenter({cards:cards.list(),entries:readLedger(home),tree:[]}),entries:readLedger(home)}),{home});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{
  const html=await(await fetch(base+'/?card=work:repo/photos')).text(),token=html.match(/name="token" value="([a-f0-9]+)"/)[1];
  const post=(action,fields,origin=base)=>fetch(base+'/works/'+action,{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token,...fields}),redirect:'manual'});
  const fields={key:'work:'+work.key,revision:'1',note:'오늘 처리 현황',progress:'20개 처리 · 224개 남음 · 21번부터 재개'};
  assert.equal((await post('update',fields,'https://evil.example')).status,403);
  assert.equal((await post('update',{...fields,token:'bad'})).status,403);
  const response=await post('update',fields);assert.equal(response.status,303);assert.match(response.headers.get('location'),/work%3Arepo%2Fphotos/);
  assert.equal((await post('update',fields)).status,409);assert.equal(store.get(work.key).revision,2);
  assert.equal(readLedger(home).length,0);
 }finally{await new Promise(r=>server.close(r));}
});
test('CLI 업무 지시문은 새 실행 번호를 만들고 카드 발령과 DONE 규약을 보존한다',()=>{
 const {home,work,store}=fixture(),body=path.join(home,'instruction.md');fs.writeFileSync(body,'# 이번 실행\n허용 범위와 완료 조건');
 const result=workCommand(['execute',work.key],{revision:1,phase:'implementation',round:1,title:'구현',note:'첫 실행','body-file':body},{home,by:'감독'});
 assert.equal(result.executions.length,1);assert.equal(new CardStore(home).get(result.executions[0].key).status,'draft');
 assert.equal(store.get(work.key).status,'open');assert.equal(readLedger(home).length,0);
});
test('업무·실행·SQLite 인박스는 기존 내보내기와 재수입에서도 이력 그대로 복구된다',()=>{
 const {home,work,store,change}=fixture();
 change('execute',{title:'구현',body:'변하지 않을 원문',phase:'implementation',round:1});
 new SecretaryMailbox(home).send({by:'감독',message:'업무에 연결한 원본 편지',workKey:work.key});
 const before=store.get(work.key),letters=readLedger(home);
 fs.writeFileSync(path.join(home,'storage-paused.json'),'{}');
 const destination=home+'-export',imported=home+'-import';
 exportStorage(home,destination);assert.deepEqual(new WorkStore(destination).get(work.key),before);
 importStorage(destination,imported);assert.equal(verifyStorage(imported).integrity,'ok');
 assert.deepEqual(new WorkStore(imported).get(work.key),before);assert.deepEqual(readLedger(imported),letters);
 assert.equal(new SecretaryMailbox(imported).read(letters[0].mailId).body,'업무에 연결한 원본 편지');
});
test('업무 ID는 발령하지 않으며 종료한 업무 안의 실행 재발령은 재개 확인이 필요하다',()=>{
 const {home,work,store,cards,change}=fixture();
 assert.throws(()=>resolveWorkMail(home,{taskId:work.id}),/업무 ID/);
 change('execute',{title:'구현',body:'지시',phase:'implementation',round:1});
 const execution=store.get(work.key).executions[0].key;
 cards.update(execution,{status:'done'},{revision:1,note:'실행 종료'});change('complete',{result:'전체 결과 확인'});
 assert.throws(()=>resolveWorkMail(home,{taskId:execution.split('/')[1]}),/종료한 업무/);
 assert.equal(resolveWorkMail(home,{workKey:work.key}).workKey,work.key,'완료 뒤 결과 우편은 연결할 수 있다');
});

for(const mode of ['jsonl','sqlite'])test(`${mode}: 업무 owner는 owner를 정한 뒤 확정된 역할 인계를 따라간다`,()=>{
 const {home,store,change}=fixture(mode);
 const transfer=(from,to,t)=>appendLedger({kind:'handover',phase:'transferred',handoverId:`${from}-${to}`,from,to,taskIds:[],t},home);
 transfer('감독','옛-후임','2000-01-01T00:00:00.000Z');
 transfer('다른-감독','다른-후임',new Date().toISOString());
 assert.throws(()=>change('complete',{result:'완료'},{by:'옛-후임'}),/책임 감독/);
 transfer('감독','감독-2',new Date(Date.now()+1000).toISOString());
 transfer('감독-2','감독-3',new Date(Date.now()+2000).toISOString());
 for(const by of ['감독','감독-2','다른-후임'])assert.throws(()=>change('complete',{result:'완료'},{by}),/책임 감독/);
 const done=change('complete',{result:'인계받은 감독이 전체 결과 확인'},{by:'감독-3'});
 assert.equal(done.status,'done');assert.equal(done.owner,'감독');
 assert.equal(store.get(done.key).history.at(-1).by,'감독-3');
});
