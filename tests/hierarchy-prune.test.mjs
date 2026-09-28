import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { planHierarchyPrune, pruneHierarchy, hierarchyCommand, PRUNE_GRACE_MS } from '../src/hierarchy-prune.mjs';
import { parseHierarchy } from '../src/hierarchy.mjs';
import { registerStartedRole } from '../src/hierarchy-register.mjs';
import { Handover } from '../src/handover.mjs';
import { createDatabase, writeStorageMarker } from '../src/storage.mjs';
import { appendLedger } from '../src/ledger.mjs';

const now = Date.parse('2026-09-28T12:00:00Z');
const old = new Date(now - 2 * PRUNE_GRACE_MS).toISOString();
const started = new Date(now - 3 * PRUNE_GRACE_MS).toISOString();
const table = {boss:'@user', leaf:'boss'};
const start = role => ({kind:'start',role,panePid:10,t:started});
const stop = role => ({kind:'stop',role,t:old});
const entries = [start('boss'), start('leaf'), stop('boss'), stop('leaf')];
const plan = extra => planHierarchyPrune({table,entries,cards:[],works:[],sessions:[],now,...extra});
const reason = (result, role = 'leaf') => result.retain.find(r => r.role === role)?.reason;

test('끝난 잎만 빼며 현재 자식이 있는 상위는 다음 회차까지 남긴다', () => {
  const result = plan();
  assert.deepEqual(result.remove.map(r => r.role), ['leaf']);
  assert.equal(reason(result, 'boss'), '하위 역할 있음');
  assert.deepEqual(Object.fromEntries(parseHierarchy(result.next)), {boss:'@user'});
  assert.equal(plan({table:result.next}).removeCount, 1);
  assert.deepEqual(table, {boss:'@user',leaf:'boss'});
});

test('살아 있는 자손의 상위 사슬과 PID 불일치 역할을 보존한다', () => {
  for (const pid of [10, 99]) {
    const result = plan({table:{...table, child:'leaf'},sessions:[{session:'kadan-child',pid}]});
    assert.equal(result.removeCount, 0);
    assert.equal(reason(result), '하위 역할 있음');
  }
  assert.equal(reason(plan({sessions:[{session:'kadan-leaf',pid:99}]})), 'PID 또는 시작 기록 모름');
  assert.equal(reason(plan({sessions:[{session:'kadan-leaf',pid:10}]})), '살아 있음');
});

test('오래된 시작은 종료 근거가 아니며 재시작·경보 해소 뒤에는 다시 관측해야 한다', () => {
  for (const records of [
    [start('leaf')],
    [start('leaf'),stop('leaf'),{...start('leaf'),t:old}],
    [start('leaf'),{kind:'alert',role:'leaf',alertKind:'죽음',t:old,resolved:true}],
    [start('leaf'),stop('leaf'),{kind:'done',role:'leaf',taskId:'x',t:old}],
    [start('leaf'),{...stop('leaf'),t:'bad'}],
    [start('leaf'),{...stop('leaf'),t:new Date(now+1).toISOString()}],
  ]) assert.equal(reason(plan({entries:records})), '종료 시각 모름');
  for (const records of [[],[stop('leaf')],[{...start('leaf'),panePid:null},stop('leaf')]]) {
    assert.equal(reason(plan({entries:records})), '시작 기록 모름');
  }
});

test('마지막 시작 뒤 종료 관측부터 24시간을 센다', () => {
  for (const kind of ['stop','alert']) {
    const death = {kind,role:'leaf',alertKind:'죽음',t:new Date(now-PRUNE_GRACE_MS+1).toISOString()};
    assert.equal(reason(plan({entries:[start('leaf'),death]})), '종료 후 24시간 미경과');
    death.t = new Date(now-PRUNE_GRACE_MS).toISOString();
    assert.equal(plan({entries:[start('leaf'),death]}).removeCount, 1);
  }
});

test('카드 상태와 실제 발령 중 어느 한쪽이라도 미완료면 보존한다; 우편은 발령이 아니다', () => {
  const card={key:'repo/c',id:'c',role:'leaf',at:old,status:'assigned'};
  const send={kind:'send',role:'leaf',taskId:'c',t:started};
  for (const status of ['assigned','hold','draft','ready']) {
    assert.equal(reason(plan({cards:[{...card,status}]})), '미완료 카드');
  }
  assert.equal(reason(plan({cards:[{...card,status:'done'}],entries:[...entries,send]})), '미완료 발령');
  const completed=[start('leaf'),send,{...send,kind:'done',result:'ok'},stop('leaf')];
  assert.equal(plan({cards:[{...card,status:'done'}],entries:completed}).removeCount, 1);
  const failed=[start('leaf'),send,{...send,kind:'done',result:'failed',t:old},stop('leaf')];
  assert.equal(reason(plan({cards:[{...card,status:'done',at:started}],entries:failed})), '미완료 카드');
  assert.equal(plan({entries:[{...send,transport:'mailbox'},...entries]}).removeCount, 1);
  assert.equal(reason(plan({entries:[start('leaf'),{...send,taskId:'missing/card'},stop('leaf')]})), '카드 연결 모름');
});

test('역할·정식 카드 주소·인계를 구별하여 남은 책임을 보존한다', () => {
  const card={key:'repo/c',id:'c',role:'old',status:'assigned',at:started};
  const send={kind:'send',role:'old',taskId:'repo/c',t:started};
  const transfer={kind:'handover',phase:'transferred',from:'old',to:'leaf',taskIds:['repo/c'],t:old};
  assert.equal(reason(plan({cards:[card],entries:[...entries,send,transfer]})), '미완료 카드');
  assert.equal(reason(plan({cards:[{...card,status:'done'}],entries:[...entries,send,transfer]})), '미완료 발령');
  const otherDone={kind:'done',role:'other',taskId:'repo/c',result:'ok',t:old};
  assert.equal(reason(plan({cards:[{...card,status:'done'}],entries:[...entries,send,transfer,otherDone]})), '미완료 카드');
});

test('실행이 끝나도 열린·보류 업무의 현재 책임자와 다음 담당은 보존한다', () => {
  for (const status of ['open','hold']) {
    assert.equal(reason(plan({works:[{owner:'leaf',status}]})), '미완료 업무');
    assert.equal(reason(plan({works:[{owner:'boss',turnOwner:'leaf',status}]})), '미완료 업무');
    assert.equal(reason(plan({works:[{owner:'old',status}],entries:[...entries,{kind:'handover',phase:'transferred',from:'old',to:'leaf',taskIds:[],t:old}]})), '미완료 업무');
  }
  assert.equal(plan({works:[{owner:'leaf',status:'done'}]}).removeCount, 1);
});

test('생존·카드·원장 정보 모름과 깨진 관계는 실패로 닫는다', () => {
  for (const extra of [{sessions:null},{sessions:[{session:'kadan-leaf',alive:true,pid:null}]},
    {sessions:[{session:'kadan-leaf',alive:false,state:'unknown'}]},
    {cards:null},{works:null},{entries:[{broken:'x'}]}, {table:{leaf:'missing'}}]) assert.throws(()=>plan(extra));
});

function fixture() {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-prune-'));
  const file=path.join(home,'parents.json');
  fs.writeFileSync(file,JSON.stringify(table));
  const snapshot={entries:[{kind:'hierarchy-loaded',path:file},...entries],cards:[],works:[],version:null};
  const options={home,file,floor:{list:()=>[]},now:()=>now,readSnapshot:()=>snapshot};
  return {home,file,snapshot,options};
}

test('미리 보기는 잠금·백업을 만들거나 파일을 바꾸지 않는다', () => {
  const f=fixture(), original=fs.readFileSync(f.file,'utf8');
  const result=pruneHierarchy(f.options);
  assert.equal(result.applied,false);assert.equal(result.removeCount,1);
  assert.deepEqual(fs.readdirSync(f.home),['parents.json']);
  assert.equal(fs.readFileSync(f.file,'utf8'),original);
});

test('적용은 먼저 원본을 백업하고 유효한 관계표만 남긴다; 두 잠금 모두 배타적이다', () => {
  const f=fixture(),original=fs.readFileSync(f.file,'utf8');
  f.options.floor.list=()=>{
    assert.throws(()=>new Handover({home:f.home}).locked(()=>assert.fail()),/잠금/);
    const registration=registerStartedRole({home:f.home,role:'new',creator:'boss',entries:f.snapshot.entries});
    assert.equal(registration.registered,false);assert.match(registration.reason,/진행 중/);
    return [];
  };
  const result=pruneHierarchy({...f.options,apply:true});
  assert.equal(result.applied,true);
  assert.equal(fs.readFileSync(result.backup,'utf8'),original);
  assert.equal(fs.statSync(result.backup).mode&0o777,0o600);
  assert.deepEqual(Object.fromEntries(parseHierarchy(JSON.parse(fs.readFileSync(f.file,'utf8')))),{boss:'@user'});
  assert(!fs.existsSync(path.join(f.home,'hierarchy-register.lock')));
  assert(!fs.existsSync(path.join(f.home,'handovers','.lock')));
});

test('열린 인계와 기존 등록·인계 잠금은 적용을 막고 남의 잠금을 보존한다', () => {
  for (const blocker of ['handover','register','open']) {
    const f=fixture(),original=fs.readFileSync(f.file,'utf8');
    fs.mkdirSync(path.join(f.home,'handovers'));
    if (blocker==='handover') fs.mkdirSync(path.join(f.home,'handovers','.lock'));
    if (blocker==='register') fs.writeFileSync(path.join(f.home,'hierarchy-register.lock'),'owned');
    if (blocker==='open') fs.writeFileSync(path.join(f.home,'handovers','test.json'),JSON.stringify({id:'test',phase:'routes-pending',hierarchy:f.file}));
    assert.throws(()=>pruneHierarchy({...f.options,apply:true}),/잠금|진행 중|열린 인계/);
    assert.equal(fs.readFileSync(f.file,'utf8'),original);
    if(blocker==='register')assert.equal(fs.readFileSync(path.join(f.home,'hierarchy-register.lock'),'utf8'),'owned');
    if(blocker==='handover')assert(fs.existsSync(path.join(f.home,'handovers','.lock')));
  }
});

test('파일·발령 정보 변경과 적용 직전 생존 복귀·조회 실패에는 쓰지 않는다', () => {
  for (const change of ['file','snapshot','alive','failure']) {
    const f=fixture(),original=fs.readFileSync(f.file,'utf8');let calls=0;
    f.options.floor.list=()=>{
      calls++;
      if(calls===1&&change==='snapshot') f.options.readSnapshot=()=>({...f.snapshot,cards:[{key:'r/c',id:'c',role:'leaf',status:'hold'}]});
      if(calls===2&&change==='file')fs.appendFileSync(f.file,' ');
      if(calls===2&&change==='alive')return [{session:'kadan-leaf',pid:11}];
      if(change==='failure')throw new Error('생존 조회 실패');
      return [];
    };
    // readSnapshot은 호출 도중 교체를 볼 수 있게 연결한다.
    const readSnapshot=()=>f.options.readSnapshot();
    assert.throws(()=>pruneHierarchy({...f.options,readSnapshot,apply:true}),/변경|살아남|실패/);
    assert.equal(fs.readFileSync(f.file,'utf8'),original+(change==='file'?' ':''));
  }
});

test('SQLite 자료 변경은 적용 직전 버전 검사에서 멈춘다', () => {
  const f=fixture();createDatabase(f.home);writeStorageMarker(f.home,'sqlite');
  for(const entry of f.snapshot.entries)appendLedger(entry,f.home);
  let calls=0;
  const floor={list:()=>{if(++calls===1)appendLedger({kind:'start',role:'new',panePid:30,t:old},f.home);return [];}};
  assert.throws(()=>pruneHierarchy({home:f.home,file:f.file,floor,now:()=>now,apply:true}),/원장·카드 변경/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),table);
});

test('CLI 기본 미리 보기와 잘못된 옵션, tmux 조회 실패를 확인한다', () => {
  const f=fixture();fs.writeFileSync(path.join(f.home,'ledger.jsonl'),f.snapshot.entries.map(e=>JSON.stringify(e)).join('\n')+'\n');
  const bin=path.join(f.home,'bin');fs.mkdirSync(bin);
  const executable=path.join(bin,'tmux');fs.writeFileSync(executable,'#!/bin/sh\nexit 0\n',{mode:0o700});
  const env={...process.env,KADAN_HOME:f.home,KADAN_FLOOR:'tmux',PATH:`${bin}:${process.env.PATH}`};
  const args=['src/cli.mjs','hierarchy','prune'];
  const dry=spawnSync(process.execPath,args,{encoding:'utf8',env});
  assert.equal(dry.status,0,dry.stderr);assert.equal(JSON.parse(dry.stdout).applied,false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),table);
  fs.writeFileSync(executable,'#!/bin/sh\nexit 1\n',{mode:0o700});
  const failed=spawnSync(process.execPath,[...args,'--apply'],{encoding:'utf8',env});
  assert.equal(failed.status,1);assert.match(failed.stderr,/생존 상태 모름/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),table);
  assert.throws(()=>hierarchyCommand(['prune'],{apply:'false'},{home:f.home,floor:{list:()=>[]}}),/사용법/);
});

test('CLI add는 자동 등록이 빠진 역할을 표에 더하고 잘못된 인자를 거부한다', () => {
  const f=fixture();
  fs.writeFileSync(path.join(f.home,'ledger.jsonl'),f.snapshot.entries.map(e=>JSON.stringify(e)).join('\n')+'\n');
  const added=hierarchyCommand(['add','사람이-띄운-역할','boss'],{},{home:f.home,floor:{list:()=>[]}});
  assert.equal(added.registered,true);
  assert.equal(added.parent,'boss');
  assert.equal(JSON.parse(fs.readFileSync(f.file,'utf8'))['사람이-띄운-역할'],'boss');
  assert.equal(hierarchyCommand(['add','사람이-띄운-역할','leaf'],{},{home:f.home,floor:{list:()=>[]}}).registered,false);
  assert.throws(()=>hierarchyCommand(['add','역할만'],{},{home:f.home,floor:{list:()=>[]}}),/사용법/);
  assert.throws(()=>hierarchyCommand(['add','역할','상위'],{apply:true},{home:f.home,floor:{list:()=>[]}}),/사용법/);
  assert.throws(()=>hierarchyCommand(['add'],{},{home:f.home,floor:{list:()=>[]}}),/사용법/);
});
