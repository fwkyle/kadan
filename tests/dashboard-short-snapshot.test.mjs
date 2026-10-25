import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {dashboardFixture} from './helpers/dashboard-fixture.mjs';
import {createWallSnapshotLoader} from '../src/commands/tree-wall.mjs';
import {createWallServer} from '../src/wall.mjs';
import {dashboardData} from '../src/dashboard-api.mjs';
import {floor} from '../src/floor.mjs';
import {wallCache} from '../src/wall-snapshot-cache.mjs';
import {appendRow,appendStream,storageSnapshot,storagePath} from '../src/storage.mjs';
import {BriefStore} from '../src/human-brief.mjs';

const routes=['workspace?collection=executions&state=all','workspace?collection=work',
  'detail?card=demo/card-1','detail?card=work:demo/dashboard','status','kanban',
  'ledger?ledgerDomain=tasks','ledger?ledgerDomain=mail','ledger?ledgerDomain=system'];
const outputs=snapshot=>routes.map(route=>dashboardData(snapshot,
  new URL('http://local/api/dashboard/'+route)));

test('확보 후 DB가 바뀌어도 계산·응답은 DB를 다시 열지 않고 같은 원본을 쓴다',t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-01-01T12:00:00Z')});
  const f=dashboardFixture({count:2});process.env.KADAN_HOME=f.home;wallCache.clear();
  const list=floor.list;floor.list=()=>[];
  try{
    new BriefStore(f.home).write('demo/card-1',
      {revision:1,title:'저장한 설명',workstream:'같은 시점',summary:'이전 설명'},'사람');
    const loader=createWallSnapshotLoader(null,{listOnly:true});
    const build=input=>Object.assign(loader.build(input),{home:f.home});
    const expected=outputs(build(storageSnapshot(f.home,loader.read)));
    const captured=storageSnapshot(f.home,loader.read);
    f.cards.update('demo/card-1',{title:'새 카드'},{revision:1,by:'사람',note:'변경'});
    const work=f.works.get('demo/dashboard');
    f.works.change(work.key,'update',{title:'새 업무'},
      {revision:work.revision,by:'사람',note:'변경'});
    f.decisions.cancel(f.decision.id,{revision:1,reason:'새 상태'},'사람');
    appendStream(f.home,'automatic-review/demo/dashboard/events.jsonl',
      {status:'exception',reason:'확보 후 변경',current:{key:'demo/card-1'}});
    wallCache.clear();let sql=0;
    const prepare=DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare=function(...args){sql++;return prepare.apply(this,args);};
    try{assert.deepEqual(outputs(build(captured)),expected);assert.equal(sql,0);}
    finally{DatabaseSync.prototype.prepare=prepare;}
    assert.notDeepEqual(outputs(build(storageSnapshot(f.home,loader.read))),expected);
  }finally{floor.list=list;wallCache.clear();}
});

test('확보 도중 다른 연결의 원자적 변경은 다음 수집에서만 함께 보인다',()=>{
  const f=dashboardFixture({count:2});process.env.KADAN_HOME=f.home;wallCache.clear();
  const card=f.cards.get('demo/card-1').history.at(-1),work=f.works.get('demo/dashboard').history.at(-1);
  const loader=createWallSnapshotLoader(null,{listOnly:true});
  const prepare=DatabaseSync.prototype.prepare;let injected=false;
  DatabaseSync.prototype.prepare=function(sql,...args){
    if(!injected&&sql.includes('SELECT stream,seq,payload FROM heads WHERE stream GLOB')){
      injected=true;
      const writer=new DatabaseSync(storagePath(f.home));
      try{
        writer.exec('BEGIN IMMEDIATE');
        appendRow(writer,'cards/demo/card-1/events.jsonl',
          {...card,revision:card.revision+1,title:'동시에 바뀐 카드'});
        appendRow(writer,'works/demo/dashboard/events.jsonl',
          {...work,revision:work.revision+1,title:'동시에 바뀐 업무'});
        writer.exec('COMMIT');
      }finally{writer.close();}
    }
    return prepare.call(this,sql,...args);
  };
  try{
    const old=storageSnapshot(f.home,loader.read);assert.equal(injected,true);
    assert.equal(old.cards.find(c=>c.key===card.key).title,card.title);
    assert.equal(old.registeredWorks[0].title,work.title);
    const next=storageSnapshot(f.home,loader.read);
    assert.equal(next.cards.find(c=>c.key===card.key).title,'동시에 바뀐 카드');
    assert.equal(next.registeredWorks[0].title,'동시에 바뀐 업무');
  }finally{DatabaseSync.prototype.prepare=prepare;wallCache.clear();}
});

test('HTTP·선행 수집에서 tmux와 화면 계산 전에 DB가 닫히고 진단은 쓰지 않는다',async t=>{
  const f=dashboardFixture({count:2});process.env.KADAN_HOME=f.home;wallCache.clear();
  // 선행 수집이 첫 HTTP의 양보 구간보다 먼저 실행되면 그 결과가 재사용될 수 있다.
  // 시간을 직접 전진시켜 첫 요청과 선행 수집의 DB 종료 경계를 각각 확인한다.
  t.mock.timers.enable({apis:['setTimeout']});
  const exec=DatabaseSync.prototype.exec,list=floor.list;let active=0,checked=0,queries=0;
  DatabaseSync.prototype.exec=function(sql,...args){
    const result=exec.call(this,sql,...args);
    if(sql==='BEGIN')active++;
    if(sql==='COMMIT'||sql==='ROLLBACK')active--;
    return result;
  };
  floor.list=()=>{assert.equal(active,0);checked++;return [];};
  const loader=createWallSnapshotLoader(null,{listOnly:true});
  const server=createWallServer(loader,{home:f.home,loadListSnapshot:loader,warmAfterMs:10});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/api/dashboard/`;
  try{
    const r=await fetch(base+'workspace?collection=work');assert.equal(r.status,200);await r.text();
    assert.equal(checked,1);
    t.mock.timers.tick(10);assert.equal(checked,2);
    const prepare=DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare=function(...args){queries++;return prepare.apply(this,args);};
    try{
      const status=await fetch(base+'storage'),value=await status.json();
      assert.equal(status.status,200);assert.equal(value.scope,'this-process');
      assert.equal(value.checkpoint,'not-run');assert.equal(value.oldestReadMs,null);
      assert.equal(queries,0);
      const denied=await fetch(base+'storage',{headers:{origin:'https://bad.invalid'}});
      assert.equal(denied.status,403);
    }finally{DatabaseSync.prototype.prepare=prepare;}
  }finally{
    await new Promise(resolve=>server.close(resolve));
    DatabaseSync.prototype.exec=exec;floor.list=list;wallCache.clear();
  }
});

test('DB 확보가 끝나면 OS 조회가 계속돼도 다른 연결의 WAL checkpoint가 완료된다',()=>{
  const f=dashboardFixture({count:2});process.env.KADAN_HOME=f.home;wallCache.clear();
  const loader=createWallSnapshotLoader(null,{listOnly:true}),list=floor.list;
  const writer=new DatabaseSync(storagePath(f.home));let blocked,released;
  const write=()=>{
    writer.exec('BEGIN IMMEDIATE');
    appendRow(writer,'checkpoint-probe/events.jsonl',{value:'검증용 사건'});
    writer.exec('COMMIT');
    return writer.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
  };
  try{
    writer.exec('PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0');
    const input=storageSnapshot(f.home,()=>{
      const input=loader.read();blocked=write();return input;
    });
    assert.ok(blocked.log>blocked.checkpointed,'열린 reader가 새 WAL의 반영을 막는다');
    floor.list=()=>{released=write();return [];};
    loader.build(input);
    assert.equal(released.log,released.checkpointed,'OS 조회 단계에는 이전 reader가 없다');
    assert.equal(released.busy,0);
  }finally{floor.list=list;writer.close();wallCache.clear();}
});
