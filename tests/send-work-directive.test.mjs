import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createDatabase,writeStorageMarker} from '../src/storage.mjs';
import {readLedger} from '../src/ledger.mjs';
import {looksLikeWorkDirective} from '../src/work-directive.mjs';

const cli=new URL('../src/cli.mjs',import.meta.url).pathname;
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const pause=()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
const GUARD=/작업 지시로 보입니다/;

test('작업 지시 구분기: 지시 어미·일 동사 결합만 잡는다',()=>{
  // 오늘 원장에서 실측한 카드 없는 지시문 어미·동사
  for(const m of ['리서치핑라','실측핑라','추가해라','덧붙여라','답핑라','카드를 만들어라','이거 고쳐핑라','설계핑라','구현핑라','결과를 확인해라','테스트 돌려라','그 파일 본내라'])
    assert.equal(looksLikeWorkDirective(m),true,m);
  // 어미 없이 끝나는 명령형(수렴형·-어/-해)은 줄 끝에서만
  for(const m of ['카드를 만들어','이 부분 고쳐','상태를 확인해','로그를 남겨','이거 실행해'])
    assert.equal(looksLikeWorkDirective(m),true,m);
  // 깨우기·제어 말은 지시가 아니다
  for(const m of ['계속해','멈춰','뭐하고 있어','계속 진행해','응답 있어','살아있어'])
    assert.equal(looksLikeWorkDirective(m),false,m);
  // 서술·의문·인용은 지시가 아니다
  for(const m of ['확인했고 완료했다','수정해 왔다','확인해?','감독이 확인해라고 했다','만들어서 올렸다','이번 달 목표','처리할 것'])
    assert.equal(looksLikeWorkDirective(m),false,m);
});

test('카드 없는 대화는 말투와 무관하고 구 강제 옵션은 호환 no-op이다', {skip:spawnSync('tmux',['-V']).status!==0},()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-guard-'));
  createDatabase(home);writeStorageMarker(home,'sqlite');
  const socket=path.basename(home),env={...process.env,KADAN_HOME:home,KADAN_SOCKET:socket,KADAN_WINDOW:'none',KADAN_FLOOR:'tmux',KADAN_ROLE:''};
  const call=(...args)=>spawnSync(process.execPath,[cli,...args],{env,cwd:home,encoding:'utf8',timeout:10000});
  const run=(...args)=>{const r=call(...args);assert.equal(r.status,0,r.stderr);return r.stdout;};
  const receiver=path.join(home,'receiver.mjs');
  fs.writeFileSync(receiver,"import fs from 'node:fs';import path from 'node:path';process.stdin.on('data',b=>fs.appendFileSync(path.join(process.env.KADAN_HOME,process.env.KADAN_ROLE+'.received'),b));\n");
  for(const role of ['guard-worker','guard-감독'])
    run('start',role,'--hidden','--cmd',`${quote(process.execPath)} ${quote(receiver)}`);
  const sends=()=>readLedger(home).filter(e=>e.kind==='send'&&e.transport!=='mailbox');
  const received=(role)=>{const end=Date.now()+3000,file=path.join(home,role+'.received');
    while(Date.now()<end&&(!fs.existsSync(file)||!fs.readFileSync(file,'utf8').trim()))pause();
    return fs.existsSync(file)?fs.readFileSync(file,'utf8'):''};
  try {
    // 카드 없는 대화는 말투와 관계없이 전달한다.
    const sent=call('send','guard-worker','결과를 확인해라');
    assert.equal(sent.status,0,sent.stderr);
    assert.match(sent.stdout,/우편ID [a-f0-9-]+/);
    assert.equal(sends().length,1);
    // 2) --force-no-card → 경고 없이 전달
    const forced=call('send','guard-worker','--force-no-card','결과를 확인해라');
    assert.equal(forced.status,0,forced.stderr);
    assert.doesNotMatch(forced.stderr,GUARD);
    assert.equal(sends().length,2);
    // 3) 깨우기 말 → 경고 없이 전달
    for(const wake of ['계속해','멈춰','뭐하고 있어']) {
      const w=call('send','guard-worker',wake);
      assert.equal(w.status,0,wake+': '+w.stderr);
      assert.doesNotMatch(w.stderr,GUARD);
    }
    assert.equal(sends().length,5);
    // 4) --task 경로는 가드를 거치지 않는다 — 카드가 없으면 기존 발령 검사가 막고,
    //    어느 쪽이든 가드 문구는 나오지 않아야 한다
    const tasked=call('send','guard-worker','--task','kadan/card-guard-x','결과를 확인해라');
    assert.doesNotMatch(tasked.stderr,GUARD);
    // 5) 감독 계열을 향한 보고는 지시 어미가 있어도 가드를 거치지 않는다
    const report=call('send','guard-감독','결과를 정리해라');
    assert.equal(report.status,0,report.stderr);
    assert.doesNotMatch(report.stderr,GUARD);
    // 실제로 수신 파일까지 갔는지 본다 — 멈춘 1건만 없어야 한다
    const workerBody=received('guard-worker');
    assert.equal((workerBody.match(/결과를 확인해라/g)||[]).length,2);
    assert.match(workerBody,/계속해/);assert.match(workerBody,/멈춰/);assert.match(workerBody,/뭐하고 있어/);
    assert.match(received('guard-감독'),/결과를 정리해라/);
  } finally {
    for(const role of ['guard-worker','guard-감독'])spawnSync('tmux',['-L',socket,'kill-session','-t',`kadan-${role}`],{env});
  }
});
