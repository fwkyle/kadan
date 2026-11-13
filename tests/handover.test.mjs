import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Handover } from '../src/handover.mjs';
import { openTaskIds, workEntries } from '../src/handover-state.mjs';
import { buildTree, guardedSend } from '../src/cli.mjs';
import { registerRoleManually, registerStartedRole } from '../src/hierarchy-register.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const DEAD_WATCH=999;
// 실제 흐름과 같게 만든 틀: 감시기가 관계표를 이미 읽고 있고(hierarchy-loaded), 후임을 띄우면 실제 등록 코드가
// 인계를 부른 역할(비서)을 상위로 후임 줄을 관계표에 넣는다. 선임의 상위(@user)와 등록 상위(비서)는 일부러 다르다.
// options.link면 인계에는 링크 경로를 주고 감시기 사건에는 직접 경로를 적는다(운영의 ~/.kadan-lite ↔ ~/.kadan).
// options.from·to로 선임·후임 이름을 바꾼다. 표는 [역할, 상위] 목록에서 만든다(객체 글자로 쓰면 __proto__ 줄을 못 만든다).
// options.noRegister면 후임 줄을 등록하지 않는다(사람이 역할 없이 인계를 불러 등록이 건너뛰어진 경우).
function fixture(options={}) {
 const from=options.from??'p-감독',to=options.to??'p-감독-2';
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-handover-'));
 const hierarchy=path.join(home,'parents.json'),context=path.join(home,'context.md');
 fs.writeFileSync(hierarchy,JSON.stringify(Object.fromEntries(
  [['비서','@user'],[from,'@user'],['p-작업자',from],['else-감독','@user']])));
 fs.writeFileSync(context,'승인된 범위와 현재 카드');
 let statePath=hierarchy;
 if(options.link){const link=`${home}-link`;fs.symlinkSync(home,link);statePath=path.join(link,'parents.json');}
 const rows=[{kind:'start',role:from,session:`kadan-${from}`,panePid:10,floor:'tmux',cmd:'codex',cwd:home},
  {kind:'send',role:from,session:`kadan-${from}`,taskId:'card-a',by:'사람'},
  {kind:'send',role:'p-작업자',session:'kadan-p-작업자',taskId:'card-b',by:from},
  {kind:'hierarchy-loaded',path:hierarchy,hash:sha(fs.readFileSync(hierarchy)),pid:100}];
 const live=new Map([[`kadan-${from}`,10],['kadan-p-작업자',20]]);
 const sends=[],stops=[],sleeps=[];const env={KADAN_ROLE:'비서'};
 const f={home,hierarchy,statePath,context,rows,live,sends,stops,sleeps,env,from,to};
 const h=new Handover({home,env,readEntries:()=>rows,record:e=>rows.push(e),sleep:ms=>sleeps.push(ms),
  watchAlive:pid=>{f.onWatchAlive?.();return pid!==DEAD_WATCH},
  floor:{name:'tmux',alive:s=>live.has(s),pid:s=>live.get(s),stop:s=>{stops.push(s);if(!options.stopFails)live.delete(s)}},
  start:(role,cmd,cwd)=>{
   if(options.startFails)throw new Error('start failed');
   live.set(`kadan-${role}`,30);rows.push({kind:'start',role,session:`kadan-${role}`,panePid:30,cmd,cwd});
   if(options.noRegister)return;
   const registered=registerStartedRole({role,creator:env.KADAN_ROLE,cmd,home,entries:rows});
   assert.equal(registered.registered,true,registered.reason);
  },
  send:(role,message)=>{sends.push({role,message});if(options.activationFails&&message.startsWith('인계 전환'))throw new Error('send uncertain')}
 });
 const begin=()=>h.begin(from,{to,hierarchy:statePath,context,atBoundary:true});
 const accept=s=>{env.KADAN_ROLE=s.to;const r=path.join(home,'receipt.json');fs.writeFileSync(r,JSON.stringify({taskIds:s.taskIds,evidencePaths:[context],nextAction:'기존 card-a 확인 후 card-b 검수'}));return h.accept(s.id,r)};
 // 감시기가 지금 파일을 읽었다는 사건. 경로·PID만 바꿔 넣을 수 있다.
 const loaded=(s,{at=hierarchy,pid=100}={})=>rows.push({kind:'hierarchy-loaded',path:at,hash:sha(fs.readFileSync(hierarchy)),pid});
 const table=()=>JSON.parse(fs.readFileSync(hierarchy,'utf8'));
 // 다른 판의 등록·정리처럼 파일 전체를 다시 쓴다.
 const edit=change=>{const next=table();change(next);fs.writeFileSync(hierarchy,JSON.stringify(next,null,2)+'\n');};
 // 인수까지 마치고 외부 지휘자(비서)로 돌아온 상태.
 const accepted=()=>{const s=begin();accept(s);env.KADAN_ROLE='비서';return s;};
 const lock=path.join(home,'hierarchy-register.lock');
 return Object.assign(f,{h,begin,accept,loaded,table,edit,accepted,lock});
}
test('09-07 후임 생성/인수만으로 선임 종료하지 않는다; watch 확인 뒤 카드와 하위 관계를 이전한다',()=>{
 const f=fixture();const s=f.begin();assert.equal(s.phase,'prepared');assert.equal(f.stops.length,0);
 assert.equal(f.table()['p-감독-2'],'비서');
 assert.throws(()=>f.h.finish(s.id,{timeout:0}),/인수 확인/);
 f.accept(s);f.env.KADAN_ROLE='비서';assert.equal(f.h.finish(s.id,{timeout:0}).phase,'routes-pending');assert.equal(f.stops.length,0);
 f.loaded(s);const result=f.h.finish(s.id,{timeout:0});assert.equal(result.phase,'complete');
 assert.deepEqual(f.stops,['kadan-p-감독']);assert.equal(f.live.get('kadan-p-작업자'),20);
 const graph=JSON.parse(fs.readFileSync(f.hierarchy));assert.equal(graph['p-작업자'],'p-감독-2');assert.equal(graph['else-감독'],'@user');
 // 후임 줄은 하나, 상위는 등록 때 상위(비서)가 아니라 선임의 상위(@user)다. 선임 줄은 없다.
 assert.deepEqual(graph,{'비서':'@user','p-감독-2':'@user','p-작업자':'p-감독-2','else-감독':'@user'});
 assert.equal(fs.readFileSync(f.hierarchy,'utf8').split('"p-감독-2":').length,2);
 assert.ok(!fs.existsSync(f.lock));
 assert.deepEqual(openTaskIds(f.rows,'p-감독'),[]);assert.deepEqual(openTaskIds(f.rows,'p-감독-2'),['card-a']);
 assert.equal(f.rows.find(e=>e.kind==='send'&&e.taskId==='card-a').role,'p-감독');
 assert.equal(workEntries(f.rows).find(e=>e.kind==='send'&&e.taskId==='card-a').by,'사람');
 const tree=buildTree(f.rows,Object.fromEntries([...f.live].map(([s,pid])=>[s,{pid}])));
 const roles=tree.flatMap(b=>b.roles);assert.deepEqual(roles.find(r=>r.role==='p-감독').cards,[]);
 assert.equal(roles.find(r=>r.role==='p-감독-2').cards[0].taskId,'card-a');
 const count=f.sends.length;f.h.finish(s.id);assert.equal(f.sends.length,count);assert.equal(f.stops.length,1);
});
test('09-07 생성 실패/사용중 후임/경계 미확인은 선임을 보존한다',()=>{
 const f=fixture({startFails:true});assert.throws(f.begin,/선임 보존/);assert.equal(f.stops.length,0);
 const g=fixture();g.begin();assert.throws(g.begin,/사용 중|과거 사용/);
 assert.throws(()=>g.h.begin('p-감독',{to:'p-new'}),/at-boundary/);
});
test('09-07 다른 역할의 accept와 PID 바뀐 후임, 빈 근거를 거부한다',()=>{
 const f=fixture();const s=f.begin();assert.throws(()=>f.h.accept(s.id,'/tmp/no'),/지정 후임/);
 f.live.set('kadan-p-감독-2',31);assert.throws(()=>f.accept(s),/PID/);assert.equal(f.stops.length,0);
});
test('09-07 준비 이후 새 카드/승인이 바뀌면 종료하지 않는다',()=>{
 for(const change of ['task','context']){
  const f=fixture();const s=f.accepted();
  if(change==='task')f.rows.push({kind:'send',role:'p-감독',taskId:'new'});
  if(change==='context')fs.appendFileSync(f.context,'changed');
  assert.throws(()=>f.h.finish(s.id,{timeout:0}),/변경/);assert.equal(f.stops.length,0);
 }
});
// 관계표는 모든 판이 함께 쓴다. 인계는 선임·후임 자리와 관련된 줄만 대조하고 바꾼다(2026-11-13 인계 a3934b85가
// 준비 뒤 붙은 남의 줄과 후임 자신의 줄 때문에 finish에서 멈췄다).
const BEFORE_WRITE={
 '선임 상위 바뀜':t=>{t['p-감독']='else-감독';},
 '선임 줄 사라짐':t=>{delete t['p-감독'];delete t['p-작업자'];},
 '선임 아래 새 하위':t=>{t['p-새작업자']='p-감독';},
 '선임 하위가 다른 상위로 옮겨짐':t=>{t['p-작업자']='else-감독';},
};
for(const [name,change] of Object.entries(BEFORE_WRITE)) test(`준비 뒤 ${name}: 선임 보존, 관계표를 쓰지 않는다`,()=>{
 const f=fixture();const s=f.accepted();f.edit(change);const before=fs.readFileSync(f.hierarchy,'utf8');
 assert.throws(()=>f.h.finish(s.id,{timeout:0}),/관계표가 준비 후 변경됨.*선임 보존/);
 assert.equal(f.h.status(s.id).phase,'accepted');assert.equal(fs.readFileSync(f.hierarchy,'utf8'),before);
 assert.equal(f.stops.length,0);assert.ok(!fs.existsSync(f.lock));
});
const AFTER_WRITE={
 '선임 줄을 되돌림':t=>{t['p-감독']='@user';},
 '옮긴 하위를 다른 상위로 바꿈':t=>{t['p-작업자']='else-감독';},
 '후임 상위를 바꿈':t=>{t['p-감독-2']='else-감독';},
};
for(const [name,change] of Object.entries(AFTER_WRITE)) test(`전환을 쓴 뒤 누가 ${name}: 선임 보존`,()=>{
 for(const when of ['감시기 읽기 전','감시기 읽기 뒤','감시기 사건을 찾은 순간']){
  const f=fixture();const s=f.accepted();f.h.finish(s.id,{timeout:0});
  if(when!=='감시기 읽기 전')f.loaded(s);
  // 마지막 경우는 같은 finish 호출 안에서, 감시기 사건을 찾은 뒤 마지막 확인 전에 바뀐다.
  if(when==='감시기 사건을 찾은 순간'){let once=false;f.onWatchAlive=()=>{if(!once){once=true;f.edit(change);}};}
  else f.edit(change);
  assert.throws(()=>f.h.finish(s.id,{timeout:0}),/인계 관계표 변경.*선임 보존/,when);
  assert.equal(f.h.status(s.id).phase,'routes-pending');assert.equal(f.stops.length,0);
 }
});
test('남의 줄이 준비 뒤·쓰기 뒤·감시기 읽기 뒤에 붙거나 빠져도 끝까지 가고 그 줄은 남는다',()=>{
 const others={'x-감독':'@user','x-작업자':'x-감독'};
 const add=t=>Object.assign(t,others);
 for(const when of ['준비~finish','쓰기~감시기 읽기','감시기 읽기~마지막 확인','모든 시점']){
  const f=fixture();const s=f.accepted();
  if(['준비~finish','모든 시점'].includes(when))f.edit(when==='모든 시점'?t=>{t['y-감독']='@user';delete t['else-감독'];}:add);
  assert.equal(f.h.finish(s.id,{timeout:0}).phase,'routes-pending',when);
  if(['쓰기~감시기 읽기','모든 시점'].includes(when))f.edit(when==='모든 시점'?t=>{t['z-감독']='@user';}:add);
  f.loaded(s);
  // 감시기 사건을 찾은 바로 그 순간(마지막 확인 직전)에 다른 판이 줄을 붙인다.
  if(['감시기 읽기~마지막 확인','모든 시점'].includes(when)){let once=false;f.onWatchAlive=()=>{if(!once){once=true;f.edit(add);}};}
  assert.equal(f.h.finish(s.id,{timeout:0}).phase,'complete',when);
  const graph=f.table();
  assert.equal(graph['x-감독'],'@user',when);assert.equal(graph['x-작업자'],'x-감독',when);
  assert.equal(graph['p-감독-2'],'@user',when);assert.equal(graph['p-작업자'],'p-감독-2',when);assert.ok(!('p-감독' in graph),when);
  if(when==='모든 시점')assert.deepEqual(graph,{'비서':'@user','p-감독-2':'@user','p-작업자':'p-감독-2','y-감독':'@user','z-감독':'@user',...others});
  assert.deepEqual(f.stops,['kadan-p-감독']);assert.ok(!fs.existsSync(f.lock));
 }
});
test('준비 뒤 후임 아래 하위가 생기거나 선임 하위가 정리돼도 끝까지 가고 후임의 하위는 남는다',()=>{
 const f=fixture();const s=f.accepted();
 f.edit(t=>{t['p-감독-2-작업자']='p-감독-2';delete t['p-작업자'];});
 f.h.finish(s.id,{timeout:0});f.edit(t=>{t['p-감독-2-검수자']='p-감독-2';});f.loaded(s);
 assert.equal(f.h.finish(s.id,{timeout:0}).phase,'complete');
 assert.deepEqual(f.table(),{'비서':'@user','p-감독-2':'@user','else-감독':'@user','p-감독-2-작업자':'p-감독-2','p-감독-2-검수자':'p-감독-2'});
});
test('후임이 선임 아래 등록돼 있어도 자기 자신을 가리키지 않고 선임의 상위로 간다',()=>{
 const f=fixture();const s=f.accepted();f.edit(t=>{t['p-감독-2']='p-감독';});
 f.h.finish(s.id,{timeout:0});assert.equal(f.table()['p-감독-2'],'@user');
 f.h.abort(s.id);assert.deepEqual(f.table(),{'비서':'@user','p-감독':'@user','p-감독-2':'p-감독','p-작업자':'p-감독','else-감독':'@user'});
});
test('새 칸이 없는 옛 모양 상태 파일(accepted)로 끝까지 간다',()=>{
 const f=fixture();const s=f.accepted();f.edit(t=>{t['x-감독']='@user';});
 // 2026-11-13 운영 인계 a3934b85의 상태 파일에 있던 칸(roleProfile은 선임 시작 기록에 있을 때만 생긴다).
 const old=['id','sourceEnded','phase','from','to','oldPid','command','cwd','hierarchy','originalHierarchy','originalHash',
  'context','contextHash','taskIds','createdAt','newPid','packet','receipt','receiptHash'];
 const state=f.h.status(s.id);assert.deepEqual(Object.keys(state).filter(k=>k!=='roleProfile'),old);assert.equal(state.phase,'accepted');
 f.h.finish(s.id,{timeout:0});
 // 전환을 쓸 때 남기는 새 칸이 빠진 routes-pending 상태도 준비 스냅샷에서 이끌어 이어간다.
 const pending=f.h.status(s.id);delete pending.routes;delete pending.routeHashes;f.h.save(pending);
 f.edit(t=>{t['y-감독']='@user';});f.loaded(s);
 assert.equal(f.h.finish(s.id,{timeout:0}).phase,'complete');assert.equal(f.table()['y-감독'],'@user');
});
test('감시기 사건의 경로가 링크로 같은 파일이면 통과하고, 같은 내용의 다른 파일이면 통과하지 않는다',()=>{
 const f=fixture({link:true});const s=f.accepted();
 assert.notEqual(f.statePath,f.hierarchy);assert.equal(fs.realpathSync(f.statePath),fs.realpathSync(f.hierarchy));
 f.h.finish(s.id,{timeout:0});
 const other=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'kadan-handover-other-')),'parents.json');
 fs.copyFileSync(f.hierarchy,other);
 f.loaded(s,{at:other});f.loaded(s,{at:path.join(f.home,'없는-파일.json')});
 assert.equal(f.h.finish(s.id,{timeout:0}).phase,'routes-pending');
 f.loaded(s);assert.equal(f.h.finish(s.id,{timeout:0}).phase,'complete');
 // 쓰기는 링크가 아니라 실제 파일에 한다: 링크는 그대로 링크다.
 assert.ok(fs.lstatSync(`${f.home}-link`).isSymbolicLink());assert.equal(f.table()['p-감독-2'],'@user');
});
test('감시기 증명: 쓰기 전 내용·죽은 감시기·전환되지 않은 내용의 사건으로는 넘어가지 않는다',()=>{
 const f=fixture();const s=f.accepted();
 f.loaded(s); // 후임 줄까지 등록된 쓰기 직전 내용을 감시기가 읽었다
 const waiting=f.h.finish(s.id,{timeout:0});assert.equal(waiting.phase,'routes-pending');assert.match(waiting.waiting,/선임 유지/);
 f.loaded(s,{pid:DEAD_WATCH}); // 전환된 내용이지만 죽은 감시기의 사건
 assert.equal(f.h.finish(s.id,{timeout:0}).phase,'routes-pending');
 // 누가 관련 줄을 되돌린 내용을 감시기가 읽었고, 그 뒤 파일은 다시 전환된 모양으로 돌아왔다.
 const transferred=fs.readFileSync(f.hierarchy,'utf8');
 f.edit(t=>{t['p-감독']='@user';t['p-작업자']='p-감독';});f.loaded(s);fs.writeFileSync(f.hierarchy,transferred);
 assert.equal(f.h.finish(s.id,{timeout:0}).phase,'routes-pending');assert.equal(f.stops.length,0);
 f.loaded(s);assert.equal(f.h.finish(s.id,{timeout:0}).phase,'complete');
});
test('전환 뒤 붙은 남의 줄을 감시기가 읽었고 그 뒤 또 바뀌어도, 다시 부른 finish가 이어간다',()=>{
 const f=fixture();const s=f.accepted();f.h.finish(s.id,{timeout:0});
 // finish가 돌지 않는 사이: 남의 줄이 붙고(1) 감시기가 읽고, 또 붙었다(2). 인계는 (1)의 내용을 본 적이 없다.
 f.edit(t=>{t['x-감독']='@user';});f.loaded(s);f.edit(t=>{t['y-감독']='@user';});
 assert.equal(f.h.finish(s.id,{timeout:0}).phase,'routes-pending');
 // 감시기가 다음 주기에 (2)를 읽으면, 인계가 이미 확인해 상태 파일에 남긴 지문과 맞는다.
 f.loaded(s);f.edit(t=>{t['z-감독']='@user';});
 assert.equal(f.h.finish(s.id,{timeout:0}).phase,'complete');
 assert.deepEqual(Object.keys(f.table()).filter(k=>/^[xyz]-/.test(k)),['x-감독','y-감독','z-감독']);
});
test('관계표 잠금이 잡혀 있으면 routes-pending을 저장하지 않고 실패한다; 풀리면 이어간다',()=>{
 const f=fixture();const s=f.accepted();const before=fs.readFileSync(f.hierarchy,'utf8');
 fs.writeFileSync(f.lock,'');
 assert.throws(()=>f.h.finish(s.id,{timeout:0}),e=>e.code==='HIERARCHY_LOCKED'&&/선임 보존/.test(e.message));
 assert.equal(f.h.status(s.id).phase,'accepted');assert.equal(fs.readFileSync(f.hierarchy,'utf8'),before);
 assert.ok(fs.existsSync(f.lock)); // 남의 잠금은 지우지 않는다
 assert.equal(f.sleeps.length,19);assert.ok(f.sleeps.every(ms=>ms===100)); // 약 2초만 기다린다
 fs.renameSync(f.lock,`${f.lock}.test-preserved`);
 assert.equal(f.h.finish(s.id,{timeout:0}).phase,'routes-pending');assert.ok(!fs.existsSync(f.lock));
 // abort도 같은 잠금을 쓴다.
 fs.writeFileSync(f.lock,'');const pending=fs.readFileSync(f.hierarchy,'utf8');
 assert.throws(()=>f.h.abort(s.id),e=>e.code==='HIERARCHY_LOCKED');
 assert.equal(f.h.status(s.id).phase,'routes-pending');assert.equal(fs.readFileSync(f.hierarchy,'utf8'),pending);
});
test('routes 대기 중 abort는 이 인계의 줄만 쓰기 직전으로 되돌리고 남의 줄과 양쪽 세션을 보존한다',()=>{
 const f=fixture();const s=f.accepted();f.edit(t=>{t['w-감독']='@user';});const before=f.table();
 f.h.finish(s.id,{timeout:0});
 // 전환 뒤: 다른 판의 줄과 후임이 띄운 하위 줄이 붙었다.
 const later={'x-감독':'@user','p-감독-2-작업자':'p-감독-2'};f.edit(t=>Object.assign(t,later));
 assert.equal(f.h.abort(s.id).phase,'aborted');
 assert.deepEqual(f.table(),{...before,...later});assert.equal(f.table()['p-감독-2'],'비서');
 assert.equal(f.stops.length,0);assert.ok(f.live.has('kadan-p-감독-2'));assert.ok(!fs.existsSync(f.lock));
});
test('전환을 쓰기 전 abort는 관계표를 건드리지 않고, 남의 줄이 붙어 있어도 막히지 않는다',()=>{
 // 인계가 관계표를 고친 적이 없으므로 대조도 잠금도 하지 않는다: 선임 줄이 바뀌었거나 남의 잠금이 있어도 취소된다.
 for(const change of [t=>{t['x-감독']='@user';},t=>{t['p-감독']='else-감독';}]){
  const f=fixture();const s=f.accepted();f.edit(change);fs.writeFileSync(f.lock,'');
  const before=fs.readFileSync(f.hierarchy,'utf8'),inode=fs.statSync(f.hierarchy).ino;
  assert.equal(f.h.abort(s.id).phase,'aborted');
  assert.equal(fs.readFileSync(f.hierarchy,'utf8'),before);assert.equal(fs.statSync(f.hierarchy).ino,inode);
  assert.ok(fs.existsSync(f.lock));assert.equal(f.sleeps.length,0);
 }
});
test('routes 대기 중 abort: 관련 줄이 다른 값이면 자동 원복을 거절하고, 이미 준비 때 모양이면 쓰지 않는다',()=>{
 const f=fixture();const s=f.accepted();const prepared=fs.readFileSync(f.hierarchy,'utf8');f.h.finish(s.id,{timeout:0});
 f.edit(t=>{t['p-감독-2']='else-감독';});const conflict=fs.readFileSync(f.hierarchy,'utf8');
 assert.throws(()=>f.h.abort(s.id),/관계표 충돌.*자동 원복 금지/);
 assert.equal(f.h.status(s.id).phase,'routes-pending');assert.equal(fs.readFileSync(f.hierarchy,'utf8'),conflict);
 // 상태만 routes-pending이고 파일은 쓰기 전 그대로(저장과 쓰기 사이에 멈춘 경우)면 되돌릴 것이 없다.
 fs.writeFileSync(f.hierarchy,prepared);const inode=fs.statSync(f.hierarchy).ino;
 assert.equal(f.h.abort(s.id).phase,'aborted');
 assert.equal(fs.readFileSync(f.hierarchy,'utf8'),prepared);assert.equal(fs.statSync(f.hierarchy).ino,inode);
});
test('routes 대기 중 abort: 선임·하위 줄은 준비 때 모양인데 후임 줄이 전환 직전 값과 다르면 거절한다',()=>{
 // 누가 선임·하위 줄은 되돌리고 후임 줄만 다른 상위로 바꿨다. 쓰기 전에 멈춘 것이 아니므로 취소 성공으로 끝내지 않는다.
 const f=fixture();const s=f.accepted();const prepared=f.table();f.h.finish(s.id,{timeout:0});
 f.edit(t=>{t['p-감독']='@user';t['p-작업자']='p-감독';t['p-감독-2']='else-감독';});
 const conflict=fs.readFileSync(f.hierarchy,'utf8'),inode=fs.statSync(f.hierarchy).ino;
 assert.throws(()=>f.h.abort(s.id),/관계표 충돌.*후임.*자동 원복 금지/);
 assert.equal(f.h.status(s.id).phase,'routes-pending');
 assert.equal(fs.readFileSync(f.hierarchy,'utf8'),conflict);assert.equal(fs.statSync(f.hierarchy).ino,inode);
 // 후임 줄이 빠진 것도 전환 직전 값(비서)과 다르다.
 f.edit(t=>{delete t['p-감독-2'];});assert.throws(()=>f.h.abort(s.id),/관계표 충돌.*후임.*자동 원복 금지/);
 // 후임 줄까지 전환 직전 값이면 되돌릴 것이 없다.
 f.edit(t=>{t['p-감독-2']='비서';});assert.equal(f.h.abort(s.id).phase,'aborted');assert.deepEqual(lines(f.table()),lines(prepared));
});
// 관계표의 역할 이름은 아무 JSON 키나 된다(parseHierarchy가 허용한다). 새 표를 next[역할]=상위로 담으면 __proto__ 줄이
// 조용히 사라지고, `역할 in 표`·표[역할]은 물려받은 속성(constructor·toString)을 줄로 잘못 읽는다(PR #402 검수 P1).
const lines=t=>Object.entries(t).sort(([a],[b])=>a<b?-1:a>b?1:0);
const own=(t,role)=>Object.hasOwn(t,role)?t[role]:undefined;
test('남의 줄 이름이 __proto__·constructor여도 전환·원복 뒤 그대로 남는다',()=>{
 for(const end of ['complete','abort']){
  const f=fixture();
  for(const role of ['__proto__','constructor']){
   const added=registerRoleManually({role,parent:'else-감독',home:f.home,entries:f.rows});
   assert.equal(added.registered,true,added.reason);
  }
  const s=f.accepted();const before=f.table();
  assert.equal(own(before,'__proto__'),'else-감독');assert.equal(own(before,'constructor'),'else-감독');
  f.h.finish(s.id,{timeout:0});
  assert.equal(own(f.table(),'__proto__'),'else-감독',`전환 뒤(${end})`);
  assert.equal(own(f.table(),'constructor'),'else-감독',`전환 뒤(${end})`);
  if(end==='abort'){assert.equal(f.h.abort(s.id).phase,'aborted');assert.deepEqual(lines(f.table()),lines(before));}
  else{
   f.loaded(s);assert.equal(f.h.finish(s.id,{timeout:0}).phase,'complete');
   assert.deepEqual(lines(f.table()),lines(Object.fromEntries([['비서','@user'],['p-감독-2','@user'],['p-작업자','p-감독-2'],
    ['else-감독','@user'],['__proto__','else-감독'],['constructor','else-감독']])));
  }
 }
});
for(const names of [{from:'__proto__'},{from:'constructor',to:'__proto__'},{to:'toString'},{from:'toString',to:'constructor'}])
 test(`선임·후임 이름이 ${names.from??'(보통)'}·${names.to??'(보통)'}여도 전환하고 abort가 되돌린다`,()=>{
  for(const end of ['complete','abort']){
   const f=fixture(names);const s=f.accepted();const before=f.table();
   assert.equal(own(before,f.from),'@user');assert.equal(own(before,f.to),'비서');
   assert.equal(f.h.finish(s.id,{timeout:0}).phase,'routes-pending');
   const moved=Object.fromEntries([['비서','@user'],[f.to,'@user'],['p-작업자',f.to],['else-감독','@user']]);
   assert.deepEqual(lines(f.table()),lines(moved),`전환 뒤(${end})`);
   assert.equal(Object.hasOwn(f.table(),f.from),false);
   if(end==='abort'){assert.equal(f.h.abort(s.id).phase,'aborted');assert.deepEqual(lines(f.table()),lines(before));}
   else{
    f.loaded(s);assert.equal(f.h.finish(s.id,{timeout:0}).phase,'complete');
    assert.deepEqual(lines(f.table()),lines(moved));assert.deepEqual(f.stops,[`kadan-${f.from}`]);
   }
  }
 });
for(const to of ['__proto__','toString']) test(`줄이 없던 후임의 이름이 ${to}여도 "줄 없음"으로 읽고 abort가 줄 없이 되돌린다`,()=>{
 // 표[역할]로 읽으면 줄이 없는데도 물려받은 속성(객체·함수)이 전환 직전 값으로 잡힌다.
 for(const shape of ['전환된 모양','쓰기 전 모양']){
  const f=fixture({to,noRegister:true});const s=f.accepted();
  const before=f.table(),prepared=fs.readFileSync(f.hierarchy,'utf8');assert.equal(Object.hasOwn(before,to),false);
  f.h.finish(s.id,{timeout:0});
  assert.equal(own(f.table(),to),'@user');assert.equal(f.h.status(s.id).routes.toBefore,null);
  // 쓰기 전 모양: 상태만 routes-pending이고 파일은 쓰기 전 그대로(후임 줄 없음)인 경우.
  if(shape==='쓰기 전 모양')fs.writeFileSync(f.hierarchy,prepared);
  assert.equal(f.h.abort(s.id).phase,'aborted',shape);
  assert.deepEqual(lines(f.table()),lines(before),shape);assert.equal(Object.hasOwn(f.table(),to),false,shape);
 }
});
test('09-07 선임 자기 종료와 선임 종료실패는 후임 활성화로 넘어가지 않는다',()=>{
 const f=fixture({stopFails:true});const s=f.begin();f.accept(s);f.env.KADAN_ROLE=s.from;
 assert.throws(()=>f.h.finish(s.id,{timeout:0}),/자기 종료/);f.env.KADAN_ROLE='비서';f.h.finish(s.id,{timeout:0});f.loaded(s);
 assert.throws(()=>f.h.finish(s.id,{timeout:0}),/종료 미확인/);assert.ok(!f.sends.some(x=>x.message.startsWith('인계 전환 완료')));
});
test('09-07 활성화 전송 불확실은 반복 finish로 중복 전송하지 않는다',()=>{
 const f=fixture({activationFails:true});const s=f.begin();f.accept(s);f.env.KADAN_ROLE='비서';f.h.finish(s.id,{timeout:0});f.loaded(s);
 assert.throws(()=>f.h.finish(s.id,{timeout:0}),/uncertain/);const n=f.sends.length;
 assert.throws(()=>f.h.finish(s.id),/activation-pending/);assert.equal(f.sends.length,n);
});
test('09-07 반복 인계와 같은 카드ID의 다른 역할 책임을 분리한다',()=>{
 const rows=[{kind:'send',role:'a',session:'kadan-a',taskId:'x'}, {kind:'send',role:'b',taskId:'x'},
  {kind:'handover',phase:'transferred',from:'a',to:'c',taskIds:['x']},
  {kind:'handover',phase:'transferred',from:'c',to:'d',taskIds:['x']},{kind:'done',role:'b',taskId:'x'}];
 assert.deepEqual(openTaskIds(rows,'d'),['x']);assert.deepEqual(openTaskIds(rows,'a'),[]);
});

for(const stage of ['prepare','activate']) test(`후임 ${stage} 직전 PID 교체는 새 세대로 전달하지 않는다`,()=>{
 const f=fixture();let attempts=0;
 const guarded=(role,message,expectedPid)=>{
  if((stage==='prepare'&&message.startsWith('인수 준비'))||(stage==='activate'&&message.startsWith('인계 전환 완료'))){
   assert.equal(expectedPid,'30');f.live.set(`kadan-${role}`,31);
  }
  guardedSend({floor:{...f.h.floor,pid:s=>String(f.live.get(s)),send:()=>{attempts++;}},
   session:`kadan-${role}`,role,message,recordedPid:expectedPid,env:{KADAN_HOME:f.home},
   readEntries:()=>f.rows,record:e=>f.rows.push(e),saveBody:()=>{}});
 };
 f.h.send=guarded;
 if(stage==='prepare'){
  assert.throws(f.begin,/다른 프로세스/);assert.equal(attempts,0);assert.equal(f.stops.length,0);
 }else{
  const s=f.begin();f.accept(s);f.env.KADAN_ROLE='비서';f.h.finish(s.id,{timeout:0});f.loaded(s);
  assert.throws(()=>f.h.finish(s.id,{timeout:0}),/다른 프로세스/);
  assert.equal(attempts,1);assert.equal(f.h.status(s.id).phase,'activation-pending');
 }
});

test('명시 종료 선임 복구: 과거 시작 기록으로 인계하고 하위는 유지',()=>{
 const f=fixture(); f.live.delete('kadan-p-감독');
 assert.throws(f.begin,/생존/);
 const s=f.h.begin('p-감독',{to:'p-감독-2',hierarchy:f.hierarchy,context:f.context,atBoundary:true,sourceEnded:true});
 f.accept(s);f.env.KADAN_ROLE='비서';f.h.finish(s.id,{timeout:0});f.loaded(s);
 assert.equal(f.h.finish(s.id,{timeout:0}).phase,'complete');
 assert.equal(f.live.get('kadan-p-작업자'),20);assert.equal(f.stops.length,0);
});
test('종료 선임 옵션은 살아있는 선임이나 다시 나타난 세션을 거부한다',()=>{
 const f=fixture();const opts={to:'p-감독-2',hierarchy:f.hierarchy,context:f.context,atBoundary:true,sourceEnded:true};
 assert.throws(()=>f.h.begin('p-감독',opts),/다시 나타남/);
 f.live.delete('kadan-p-감독');const s=f.h.begin('p-감독',opts);f.accept(s);f.env.KADAN_ROLE='비서';
 f.live.set('kadan-p-감독',99);assert.throws(()=>f.h.finish(s.id,{timeout:0}),/다시 나타남/);assert.equal(f.stops.length,0);
});
