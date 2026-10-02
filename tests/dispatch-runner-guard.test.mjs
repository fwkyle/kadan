import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {readLedger} from '../src/ledger.mjs';
import {CardStore} from '../src/card-store.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {guardedSend} from '../src/cli.mjs';
import {inspectDispatchRunnerGuard} from '../src/dispatch-runner-guard.mjs';

// 2026-09-29: 작업자·검수자 기본값이 바뀐 뒤에도 옛 실행기·모델로 떠 있던 세션에 새 카드가 갔다(9/23, 9/29).
// 카드 발령(guardedSend의 taskId 경로)은 세션의 실제 실행 명령과 그 역할 프로필의 지금 기본값을 대조한다.
// 실행기·모델 다름=거절, 강도·실행 인자만 다름=경고, --allow-old-runner "<이유>"=예외 통과.
const cli=new URL('../src/cli.mjs',import.meta.url).pathname;
const pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
const hasTmux=spawnSync('tmux',['-V']).status===0;
const rally={rallyId:'rally',rallyTitle:'묶음',rallyRound:'1',rallyStep:'implementation'};

// 실제 ~/.kadan/runner-settings.json과 같은 명령 틀
const RUNNERS={
 claude:{spawn:'claude --model {model} --effort {effort} --dangerously-skip-permissions'},
 codex:{spawn:'codex -p lite --model "{model}" -c model_reasoning_effort="{effort}"'},
};
const WORKER={runner:'claude',model:'claude-sonnet-5-5',effort:'xhigh'};
const REVIEWER={runner:'codex',model:'gpt-6-sol',effort:'high'};
const WORKER_CMD='claude --model claude-sonnet-5-5 --effort xhigh --dangerously-skip-permissions';
const REVIEWER_CMD='codex -p lite --model "gpt-6-sol" -c model_reasoning_effort="high"';
const OLD_OPUS_CMD='claude --model claude-opus-5-5 --effort high --dangerously-skip-permissions';
const settingsDoc=(roles={worker:WORKER,reviewer:REVIEWER},revision=7)=>
 ({version:1,revision,activePreset:'B',presets:{B:{roles}},runners:RUNNERS});

function rig({settings=settingsDoc(),cmd=WORKER_CMD,roleProfile='worker',step='implementation',roles=null}={}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-runner-guard-'));
 if(settings!==null)fs.writeFileSync(path.join(home,'runner-settings.json'),typeof settings==='string'?settings:JSON.stringify(settings));
 // 역할 이름으로 프로필을 정하는 설정(role-instructions.json) — 시작 기록에 프로필이 없는 옛 세션을 알아보는 근거 중 하나
 if(roles)fs.writeFileSync(path.join(home,'role-instructions.json'),JSON.stringify({version:1,roles}));
 const store=new CardStore(home);
 const card=store.create({repo:'r',id:'card-1',repoPath:home,body:'# 지시'});
 store.update(card.key,{status:'assigned',role:'r',board:'r',scope:'시험 범위',...rally,rallyStep:step},{revision:1,note:'배정'});
 const r={home,card,sent:0,records:[],entries:[]};
 const floor={name:'fake',alive:()=>true,pid:()=>'111',send:()=>{r.sent++;return {};}};
 r.start=(extra={})=>({kind:'start',role:'r',session:'kadan-r',panePid:'111',...(roleProfile?{roleProfile}:{}),...extra});
 r.entries=[r.start({...(cmd?{cmd}:{})})];
 // 경고는 console.error로 나온다 — 시험에서 모아 본다
 r.call=(extra={})=>{
  const lines=[],original=console.error;
  console.error=(...args)=>lines.push(args.join(' '));
  try{
   guardedSend({floor,session:'kadan-r',role:'r',message:'카드 지시',taskId:'card-1',recordedPid:'111',env:{KADAN_HOME:home},
    readEntries:()=>r.entries,record:e=>r.records.push(e),saveBody:()=>{},...extra});
   return lines;
  }finally{console.error=original;}
 };
 r.sends=()=>r.records.filter(e=>e.kind==='send');
 return r;
}
const stale=e=>e.code==='KADAN_STALE_RUNNER'&&e.delivery==='not-sent';

test('같은 실행기·모델·명령이면 그대로 통과하고 기록에 경계 필드가 없다',()=>{
 const r=rig();
 assert.deepEqual(r.call(),[]);
 assert.equal(r.sent,1);assert.equal(r.sends()[0].runnerGuard,undefined);
});

test('모델이 다르면 거절한다 — 안내 3줄(기본값·세션 값·조치), 전달·send 원장 없음',()=>{
 const r=rig({cmd:OLD_OPUS_CMD});
 assert.throws(()=>r.call(),e=>{
  assert.ok(stale(e),`${e.code}/${e.delivery}`);
  const lines=e.message.split('\n');
  assert.equal(lines.length,3);
  assert.match(lines[0],/worker 기본값 = claude · claude-sonnet-5-5 · xhigh \(설정 revision 7\)/);
  assert.match(lines[1],/claude · claude-opus-5-5/);
  assert.match(lines[2],/kadan stop r 뒤 kadan start r --profile worker/);
  assert.match(lines[2],/--allow-old-runner/);
  return true;
 });
 assert.equal(r.sent,0);assert.equal(r.sends().length,0);
});

test('실행기가 다르면 모델 이름이 같아도 거절한다',()=>{
 const r=rig({cmd:'codex --model claude-sonnet-5-5'});
 assert.throws(()=>r.call(),stale);
 assert.equal(r.sent,0);
});

test('강도만 다르면 통과하고 경고 한 줄을 출력하며 send 기록에 남긴다',()=>{
 const r=rig({cmd:'claude --model claude-sonnet-5-5 --effort high --dangerously-skip-permissions'});
 const lines=r.call();
 assert.equal(r.sent,1);
 assert.equal(lines.length,1);assert.match(lines[0],/^경고: kadan-r의 강도·실행 인자가 지금 worker 기본값과 다르다\(기본값 강도 xhigh\)/);
 assert.deepEqual(r.sends()[0].runnerGuard,{result:'warn',code:'effort-or-args',settingsRevision:7});
});

test('시작 기록이 없거나 명령이 없는 세션은 옛 신원 경계가 먼저, 더 엄하게 막는다(약화 없음)',()=>{
 const r=rig();
 r.entries=[];
 assert.throws(()=>r.call(),e=>e.code==='KADAN_AI_IDENTITY_UNVERIFIED');
 r.entries=[r.start()];
 assert.throws(()=>r.call(),e=>e.code==='KADAN_AI_IDENTITY_UNVERIFIED');
 assert.equal(r.sent,0);
});

test('--allow-old-runner "<이유>"로만 예외 통과한다 — 이유는 send 기록에 남고 빈 이유는 거절',()=>{
 const r=rig({cmd:OLD_OPUS_CMD});
 for(const blank of ['',' ',true,['a','b']]){
  assert.throws(()=>r.call({allowOldRunner:blank}),e=>{assert.ok(stale(e));assert.match(e.message,/이유가 필요하다/);return true;},String(blank));
 }
 assert.equal(r.sent,0);
 const lines=r.call({allowOldRunner:'  사진 규칙 수정 이어서  '});
 assert.equal(r.sent,1);
 assert.match(lines[0],/옛 세션 예외 통과\(--allow-old-runner\).*이유: 사진 규칙 수정 이어서/);
 assert.deepEqual(r.sends()[0].runnerGuard,{result:'allowed',code:'runner-or-model',reason:'사진 규칙 수정 이어서',settingsRevision:7});
 // 옛 세션이 아니면 옵션은 무시된다 — 기록도 없다
 const same=rig();
 same.call({allowOldRunner:'필요 없음'});
 assert.equal(same.sends()[0].runnerGuard,undefined);
});

test('빈 예외 이유는 세션이 기본값과 같아도, --raw여도, 받는 역할이 무엇이든 항상 거절한다',()=>{
 const blankRejected=(r,extra={})=>{
  for(const blank of ['',' ',true,['a','b']]){
   assert.throws(()=>r.call({allowOldRunner:blank,...extra}),e=>{assert.ok(stale(e));assert.match(e.message,/이유가 필요하다/);assert.equal(e.message.split('\n').length,2);return true;},String(blank));
  }
  assert.equal(r.sent,0);assert.equal(r.sends().length,0);
 };
 blankRejected(rig());                                  // 기본값과 같은 새 세션
 blankRejected(rig(),{raw:true});                       // --raw
 blankRejected(rig({roleProfile:'reviewer',cmd:REVIEWER_CMD,step:'review'}));
 blankRejected(rig({roleProfile:'conductor'}));         // 검사 대상이 아닌 역할도 규칙은 하나
 // 이유가 있으면 옛 세션이 아닌 경우 옵션은 그냥 무시된다(기존 동작 유지)
 const fresh=rig();fresh.call({allowOldRunner:'필요 없음',raw:true});
 assert.equal(fresh.sent,1);assert.equal(fresh.sends()[0].runnerGuard,undefined);
});

test('작업자·검수자가 아닌 역할과 프로필을 모르는 역할에는 적용하지 않는다 — --raw여도 같다',()=>{
 for(const profile of ['conductor','super','secretary']){
  for(const raw of [false,true]){
   const r=rig({cmd:OLD_OPUS_CMD,roleProfile:profile});
   r.call({raw});assert.equal(r.sent,1,`${profile} raw=${raw}`);assert.equal(r.sends()[0].runnerGuard,undefined);
  }
 }
 // 시작 기록의 프로필이 우선한다 — 발령 쪽 프로필 인자보다
 const conductor=rig({cmd:OLD_OPUS_CMD,roleProfile:'conductor'});
 conductor.call({roleProfile:'worker'});assert.equal(conductor.sent,1);
 // 시작 기록에 프로필이 없어도 역할 이름 설정(role-instructions.json)이 감독이면 카드 단계(implementation)보다 우선해 raw도 적용하지 않는다
 for(const profile of ['conductor','super']){
  const named=rig({cmd:OLD_OPUS_CMD,roleProfile:null,roles:{r:profile}});
  named.call({raw:true});assert.equal(named.sent,1,`역할 이름 ${profile}`);
 }
 // 프로필을 끝내 알 수 없으면 대조하지 않는다 — 검사 함수는 프로필이 없으면 skip
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-runner-guard-noprofile-'));
 fs.writeFileSync(path.join(home,'runner-settings.json'),JSON.stringify(settingsDoc()));
 for(const profile of [undefined,null,'',  'unknown']){
  assert.deepEqual(inspectDispatchRunnerGuard({home,role:'r',session:'kadan-r',profile,identity:{harness:'claude',model:'claude-opus-5-5',launch:{cmd:OLD_OPUS_CMD}}}),
   {result:'skip',reason:'not-worker-reviewer'},String(profile));
 }
});

test('프로필은 시작 기록 → 발령 인자(자동 발령) → 카드 단계 추론 순서로 정한다 — 옛 세션이면 모두 거절',()=>{
 const noProfile=rig({cmd:OLD_OPUS_CMD,roleProfile:null});
 assert.throws(()=>noProfile.call({roleProfile:'worker'}),stale,'발령 인자');
 assert.throws(()=>noProfile.call(),stale,'카드 단계(implementation) 추론');
 const rawExplicit=rig({cmd:OLD_OPUS_CMD});
 assert.throws(()=>rawExplicit.call({raw:true}),stale,'--raw여도 시작 기록의 프로필이 있으면 우회할 수 없다');
});

test('--raw 발령도 옛 작업자·검수자 세션에는 가지 않는다 — 시작 기록에 프로필이 없는 옛 세션이 검수 재현 조건이다',()=>{
 // 검수 재현: 옛 오퍼스·프로필 없음·지금 소넷·카드 단계 implementation·raw 발령. 고치기 전에는 sent=1, runnerGuard=null이었다
 for(const raw of [false,true]){
  const r=rig({cmd:OLD_OPUS_CMD,roleProfile:null});
  assert.throws(()=>r.call({raw}),e=>{assert.ok(stale(e));assert.match(e.message.split('\n')[0],/worker 기본값 = claude · claude-sonnet-5-5/);return true;},`raw=${raw}`);
  assert.equal(r.sent,0);assert.equal(r.sends().length,0);
 }
 // 판정 근거 하나씩: 카드 단계 implementation·fix·research → worker, review → reviewer(검수자 기본값과 대조)
 for(const step of ['implementation','fix']){
  const r=rig({cmd:OLD_OPUS_CMD,roleProfile:null,step});
  assert.throws(()=>r.call({raw:true}),e=>{assert.ok(stale(e));assert.match(e.message,/worker 기본값/);return true;},step);
 }
 const review=rig({cmd:OLD_OPUS_CMD,roleProfile:null,step:'review'});
 assert.throws(()=>review.call({raw:true}),e=>{assert.ok(stale(e));assert.match(e.message,/reviewer 기본값 = codex · gpt-6-sol/);return true;});
 // 역할 이름 설정(role-instructions.json)이나 발령 쪽 프로필 인자가 작업자인데 카드 단계가 review면
 // 프로필·단계 불일치로 거절한다(2026-10-02 — 전에는 worker 기본값과 대조했다). 조치는 reviewer로 새로 띄우기
 const named=rig({cmd:OLD_OPUS_CMD,roleProfile:null,step:'review',roles:{r:'worker'}});
 assert.throws(()=>named.call({raw:true}),e=>{assert.ok(stale(e));assert.match(e.message,/검수 카드\(review\)를 작업자\(worker\) 프로필 세션에/);assert.match(e.message,/--profile reviewer/);return true;});
 const arg=rig({cmd:OLD_OPUS_CMD,roleProfile:null,step:'review'});
 assert.throws(()=>arg.call({raw:true,roleProfile:'worker'}),e=>{assert.ok(stale(e));assert.match(e.message,/검수 카드\(review\)를 작업자\(worker\) 프로필 세션에/);return true;});
 assert.equal(review.sent+named.sent+arg.sent,0);
 // 이유가 있는 예외는 raw여도 통과하고 send 기록에 남는다
 const allowed=rig({cmd:OLD_OPUS_CMD,roleProfile:null});
 allowed.call({raw:true,allowOldRunner:'raw 예외 시험'});
 assert.equal(allowed.sent,1);assert.deepEqual(allowed.sends()[0].runnerGuard,{result:'allowed',code:'runner-or-model',reason:'raw 예외 시험',settingsRevision:7});
 // 기본값과 같은 세션은 raw도 그대로 통과 — 기록에 경계 필드가 없고 raw는 역할 지침을 붙이지 않는다
 const fresh=rig({cmd:WORKER_CMD,roleProfile:null});
 assert.deepEqual(fresh.call({raw:true}),[]);
 assert.equal(fresh.sent,1);assert.equal(fresh.sends()[0].runnerGuard,undefined);assert.equal(fresh.sends()[0].roleInstructions.reason,'explicit-raw');
});

test('검수자는 검수자 기본값과 대조한다',()=>{
 const same=rig({cmd:REVIEWER_CMD,roleProfile:'reviewer',step:'review'});
 assert.deepEqual(same.call(),[]);assert.equal(same.sent,1);
 const old=rig({cmd:'codex -p lite --model "gpt-6-astra" -c model_reasoning_effort="high"',roleProfile:'reviewer',step:'review'});
 assert.throws(()=>old.call(),e=>{assert.ok(stale(e));assert.match(e.message,/reviewer 기본값 = codex · gpt-6-sol · high/);return true;});
 assert.equal(old.sent,0);
});

// 2026-10-02: 10/1부터 검수 카드 18건이 `--profile worker`로 띄운 세션(작업자와 같은 소넷)에 갔다. 세션 시작 프로필만
// 대조해 통과했다 — 발령 카드의 단계가 요구하는 프로필(review→reviewer)과 세션 프로필이 다르면 거절한다.
const mismatchLine=/^카드 발령 거절: 검수 카드\(review\)를 작업자\(worker\) 프로필 세션에 보낸다 — 검수 카드\(review\)는 reviewer 프로필\(지금 기본값 codex · gpt-6-sol · high\)이어야 한다$/;
test('검수 카드를 작업자 프로필 세션에 보내면 거절한다 — 세션이 작업자 기본값과 같아도',()=>{
 const r=rig({cmd:WORKER_CMD,roleProfile:'worker',step:'review'});
 for(const raw of [false,true]){
  assert.throws(()=>r.call({raw}),e=>{
   assert.ok(stale(e),`${e.code}/${e.delivery}`);
   const lines=e.message.split('\n');
   assert.equal(lines.length,3);
   assert.match(lines[0],mismatchLine);
   assert.match(lines[1],/이 세션\(kadan-r\) 값 = claude · claude-sonnet-5-5 — 세션 프로필 worker/);
   assert.match(lines[2],/kadan stop r 뒤 kadan start r --profile reviewer로 새로 띄워 보내라/);
   assert.match(lines[2],/--allow-old-runner/);
   return true;
  },`raw=${raw}`);
 }
 assert.equal(r.sent,0);assert.equal(r.sends().length,0);
 // 반대 방향: 작업 카드를 검수자 프로필 세션에 보내도 거절
 const back=rig({cmd:REVIEWER_CMD,roleProfile:'reviewer',step:'fix'});
 assert.throws(()=>back.call(),e=>{assert.ok(stale(e));assert.match(e.message,/작업 카드\(구현·수정 등\)를 검수자\(reviewer\) 프로필 세션에/);assert.match(e.message,/--profile worker/);return true;});
 assert.equal(back.sent,0);
 // 검사 함수가 돌려주는 코드
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-runner-guard-phase-'));
 fs.writeFileSync(path.join(home,'runner-settings.json'),JSON.stringify(settingsDoc()));
 const verdict=inspectDispatchRunnerGuard({home,role:'r',session:'kadan-r',profile:'worker',phaseProfile:'reviewer',
  identity:{harness:'claude',model:'claude-sonnet-5-5',launch:{cmd:WORKER_CMD}}});
 assert.equal(verdict.result,'reject');assert.equal(verdict.code,'profile-phase-mismatch');
});

test('검수 카드를 검수자 프로필 세션(검수자 기본값)에 보내면 통과, 작업 카드를 작업자 세션에 보내도 그대로 통과',()=>{
 const review=rig({cmd:REVIEWER_CMD,roleProfile:'reviewer',step:'review'});
 assert.deepEqual(review.call(),[]);
 assert.equal(review.sent,1);assert.equal(review.sends()[0].runnerGuard,undefined);
 for(const step of ['implementation','fix']){
  const work=rig({cmd:WORKER_CMD,roleProfile:'worker',step});
  assert.deepEqual(work.call(),[],step);
  assert.equal(work.sent,1);assert.equal(work.sends()[0].runnerGuard,undefined);
 }
 // 단계 프로필이 같으면 기존 대조는 그대로다 — 검수자 세션이 옛 모델이면 여전히 옛 세션으로 거절
 const stalereviewer=rig({cmd:'codex -p lite --model "gpt-6-astra" -c model_reasoning_effort="high"',roleProfile:'reviewer',step:'review'});
 assert.throws(()=>stalereviewer.call(),e=>{assert.ok(stale(e));assert.match(e.message,/옛 실행기·모델 세션이다 — 지금 reviewer 기본값/);return true;});
});

test('검수 카드→작업자 세션도 --allow-old-runner "<이유>"면 예외 통과하고 이유가 send 기록에 남는다',()=>{
 const r=rig({cmd:WORKER_CMD,roleProfile:'worker',step:'review'});
 const lines=r.call({allowOldRunner:'검수자 세션 없음, 같은 모델 검수 감수'});
 assert.equal(r.sent,1);
 assert.equal(lines.length,1);
 assert.match(lines[0],/^경고: kadan-r 옛 세션 예외 통과\(--allow-old-runner\) — 검수 카드\(review\)를 작업자\(worker\) 프로필 세션에 보낸다.* — 이유: 검수자 세션 없음, 같은 모델 검수 감수$/);
 assert.deepEqual(r.sends()[0].runnerGuard,{result:'allowed',code:'profile-phase-mismatch',reason:'검수자 세션 없음, 같은 모델 검수 감수',settingsRevision:7});
 // 빈 이유는 여전히 거절
 const blank=rig({cmd:WORKER_CMD,roleProfile:'worker',step:'review'});
 assert.throws(()=>blank.call({allowOldRunner:' '}),e=>{assert.ok(stale(e));assert.match(e.message,/이유가 필요하다/);return true;});
});

test('카드 단계를 하나로 정할 수 없으면(묶음 단계 review·업무 연결 단계 implementation) 세션 시작 프로필로만 대조한다 — 기존 동작 그대로',()=>{
 // 실제 발령에서는 카드에 묶음 단계가 늘 있다. 업무 실행 연결의 단계와 엇갈리면 단계 판정이 ambiguous가 된다
 const ambiguous=extra=>{
  const r=rig({step:'review',...extra});
  const works=new WorkStore(r.home);
  const work=works.create({key:'r/work',title:'업무',goal:'목표',scope:'범위',acceptance:'조건',owner:'boss',repoPath:r.home});
  works.change(work.key,'link',{execution:r.card.key,phase:'implementation',round:1},{revision:work.revision,note:'연결'});
  return r;
 };
 for(const [roleProfile,cmd] of [['worker',WORKER_CMD],['reviewer',REVIEWER_CMD]]){
  const r=ambiguous({cmd,roleProfile});
  assert.deepEqual(r.call(),[],roleProfile);
  assert.equal(r.sent,1);assert.equal(r.sends()[0].runnerGuard,undefined);
 }
 const old=ambiguous({cmd:OLD_OPUS_CMD,roleProfile:'worker'});
 assert.throws(()=>old.call(),e=>{assert.ok(stale(e));assert.match(e.message,/옛 실행기·모델 세션이다 — 지금 worker 기본값/);return true;});
 // 단계 인자를 안 넘기면 검사 함수도 예전과 같다
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-runner-guard-nophase-'));
 fs.writeFileSync(path.join(home,'runner-settings.json'),JSON.stringify(settingsDoc()));
 for(const phaseProfile of [undefined,null,'conductor']){
  assert.deepEqual(inspectDispatchRunnerGuard({home,role:'r',session:'kadan-r',profile:'worker',phaseProfile,
   identity:{harness:'claude',model:'claude-sonnet-5-5',launch:{cmd:WORKER_CMD}}}),{result:'pass'},String(phaseProfile));
 }
});

// 2026-10-02: `kadan start --profile reviewer --fallback N`으로 정식으로 띄운 폴백 세션은 옛 세션이 아니다.
test('지금 설정의 폴백 목록과 같은 세션은 통과 + 폴백 번호 경고, 어느 것과도 다르면 거절',()=>{
 const FALLBACK={runner:'codex',model:'gpt-6-astra',effort:'high'};
 const settings={...settingsDoc(),presets:{B:{roles:{worker:WORKER,reviewer:REVIEWER},fallback:{reviewer:[{runner:'codex',model:'gpt-5-x',effort:'high'},FALLBACK]}}}};
 const fb=rig({settings,cmd:'codex -p lite --model "gpt-6-astra" -c model_reasoning_effort="high"',roleProfile:'reviewer',step:'review'});
 const lines=fb.call();
 assert.equal(fb.sent,1);
 assert.equal(lines.length,1);
 assert.equal(lines[0],'경고: kadan-r은(는) reviewer 폴백 2번(codex · gpt-6-astra · high)으로 떠 있다 — 기본값(codex · gpt-6-sol · high)이 아니다');
 assert.deepEqual(fb.sends()[0].runnerGuard,{result:'warn',code:'fallback',fallbackIndex:2,settingsRevision:7});
 // 폴백에도 없는 모델은 기존처럼 옛 세션 거절
 const none=rig({settings,cmd:'codex -p lite --model "gpt-4-old" -c model_reasoning_effort="high"',roleProfile:'reviewer',step:'review'});
 assert.throws(()=>none.call(),e=>{assert.ok(stale(e));assert.match(e.message,/옛 실행기·모델 세션이다/);return true;});
 assert.equal(none.sent,0);
 // 검수자 폴백과 같은 모델이어도 작업자 프로필 세션이면 검수 카드는 프로필 불일치로 거절
 const wrongProfile=rig({settings,cmd:'codex -p lite --model "gpt-6-astra" -c model_reasoning_effort="high"',roleProfile:'worker',step:'review'});
 assert.throws(()=>wrongProfile.call(),e=>{assert.ok(stale(e));assert.match(e.message.split('\n')[0],mismatchLine);return true;});
 // 폴백 목록이 없는 설정은 예전과 같다
 const plain=rig({cmd:'codex -p lite --model "gpt-6-astra" -c model_reasoning_effort="high"',roleProfile:'reviewer',step:'review'});
 assert.throws(()=>plain.call(),stale);
});

test('설정이 없거나 그 역할 값이 없으면 대조하지 않는다 — 설정 파일이 깨졌으면 닫고, 예외 이유가 있으면 통과',()=>{
 const none=rig({settings:null,cmd:OLD_OPUS_CMD});
 none.call();assert.equal(none.sent,1);assert.equal(none.sends()[0].runnerGuard,undefined);
 const noRole=rig({settings:settingsDoc({reviewer:REVIEWER}),cmd:OLD_OPUS_CMD});
 noRole.call();assert.equal(noRole.sent,1);
 const broken=rig({settings:'{ 깨진 json',cmd:WORKER_CMD});
 assert.throws(()=>broken.call(),e=>{assert.ok(stale(e));assert.match(e.message,/실행 모델 설정을 읽을 수 없다/);return true;});
 assert.equal(broken.sent,0);
 broken.call({allowOldRunner:'설정 복구 전 긴급'});
 assert.equal(broken.sends()[0].runnerGuard.code,'settings-unreadable');
});

test('기본값 명령에서 실행기·모델을 못 읽으면 막지 않고 경고한다',()=>{
 const settings={...settingsDoc(),runners:{...RUNNERS,claude:{spawn:'claude --model {provider}/{model} --effort {effort}'}}};
 const r=rig({settings});
 const lines=r.call();
 assert.equal(r.sent,1);assert.match(lines[0],/기본값 명령에서 실행기·모델을 읽지 못해/);
 assert.equal(r.sends()[0].runnerGuard.code,'expected-unreadable');
});

test('살아 있는 세션에 start를 다시 불러 생긴 빈 start 기록은 옛 세션을 새 세션으로 바꾸지 못한다',()=>{
 const r=rig({cmd:OLD_OPUS_CMD});
 // cmdStart의 reusing 분기: 같은 pane PID, cmd·harness·model·launchSource 없는 새 start 기록
 r.entries.push(r.start());
 // 가장 최근 start를 기준으로 삼으면 모델이 비어(모름) 경고로만 끝나 옛 세션이 통과한다 — 그래서 쓰지 않는다
 assert.equal(r.entries.at(-1).model,undefined);assert.equal(r.entries.at(-1).cmd,undefined);
 assert.throws(()=>r.call(),stale);
 r.entries.push(r.start());
 assert.throws(()=>r.call(),stale,'재시작을 몇 번 불러도 같다');
 assert.equal(r.sent,0);
 // 새 세션(같은 세대의 새 기본값 명령)은 재사용 기록이 붙어도 그대로 통과한다
 const fresh=rig({cmd:WORKER_CMD});
 fresh.entries.push(fresh.start());
 fresh.call();assert.equal(fresh.sent,1);
 // stop 뒤 새로 띄운 세션은 이전 세대의 옛 명령을 물려받지 않는다
 const restarted=rig({cmd:OLD_OPUS_CMD});
 restarted.entries.push({kind:'stop',role:'r',session:'kadan-r'},restarted.start({cmd:WORKER_CMD,panePid:'111'}));
 restarted.call();assert.equal(restarted.sent,1);
});

test('카드 연결이 없는 일반 우편·질문은 옛 세션에도 그대로 간다',()=>{
 const r=rig({cmd:OLD_OPUS_CMD});
 r.call({taskId:undefined,message:'일반 우편'});
 r.call({taskId:undefined,message:'질문',mailContext:{executionKey:r.card.key,expectReply:true}});
 assert.equal(r.sent,2);assert.equal(r.sends().every(e=>e.runnerGuard===undefined),true);
});

test('inspectDispatchRunnerGuard: 시작 때 설정 revision이 있으면 세션 값 줄에 보여 준다',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-runner-guard-pure-'));
 fs.writeFileSync(path.join(home,'runner-settings.json'),JSON.stringify(settingsDoc()));
 const verdict=inspectDispatchRunnerGuard({home,role:'r',session:'kadan-r',profile:'worker',
  identity:{harness:'claude',model:'claude-opus-5-5',launch:{cmd:OLD_OPUS_CMD,launchSource:'settings',settingsRevision:3}}});
 assert.equal(verdict.result,'reject');
 assert.match(verdict.message.split('\n')[1],/\(시작 때 설정 revision 3\)/);
});

test('inspectDispatchRunnerGuard: 시작 기록·모델을 모르면 이 검사는 경고만 한다(거절은 기존 신원 검사 몫)',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-runner-guard-unknown-'));
 fs.writeFileSync(path.join(home,'runner-settings.json'),JSON.stringify(settingsDoc()));
 for(const identity of [{},{harness:'claude'},{harness:'claude',model:'claude-opus-5-5'},{harness:'claude',model:'claude-opus-5-5',launch:{}}]){
  const verdict=inspectDispatchRunnerGuard({home,role:'r',session:'kadan-r',profile:'worker',identity});
  assert.equal(verdict.result,'warn',JSON.stringify(identity));assert.equal(verdict.code,'session-unknown');
  assert.match(verdict.warning,/시작 기록·실행 모델을 몰라/);assert.equal(verdict.ledger.settingsRevision,7);
 }
 // 예외 이유가 빈 채로 오면 이 경우에도 규칙은 하나 — 거절
 assert.equal(inspectDispatchRunnerGuard({home,role:'r',session:'kadan-r',profile:'worker',identity:{},allowOldRunner:''}).result,'reject');
});

test('실제 CLI+격리 tmux: 살아 있는 옛 세션에 start를 다시 불러도 카드 발령은 거절된다',{skip:!hasTmux},()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-runner-guard-cli-'));
 const socket=path.basename(home),env={...process.env,KADAN_HOME:home,KADAN_SOCKET:socket,KADAN_WINDOW:'none',KADAN_FLOOR:'tmux',KADAN_ROLE:''};
 const call=(...args)=>spawnSync(process.execPath,[cli,...args],{env,cwd:home,encoding:'utf8',timeout:15000});
 const run=(...args)=>{const r=call(...args);assert.equal(r.status,0,`${args}: ${r.stderr}`);return r;};
 const tmux=(...args)=>spawnSync('tmux',['-L',socket,...args],{env,encoding:'utf8'});
 const ledger=()=>readLedger(home);
 const sends=()=>ledger().filter(e=>e.kind==='send'&&e.transport!=='mailbox');
 const paneText=s=>tmux('capture-pane','-p','-S','-200','-t',s).stdout||'';
 // 등록 실행기 이름(codex)의 수신기 — 실제 codex를 실행하지 않는다. 붙여넣은 본문을 <역할>.received에 쓴다
 const receiver=path.join(home,'codex.mjs');
 fs.writeFileSync(receiver,"process.stdout.write('› ');import fs from 'node:fs';import path from 'node:path';process.stdin.on('data',b=>fs.appendFileSync(path.join(process.env.KADAN_HOME,process.env.KADAN_ROLE+'.received'),b));fs.writeFileSync(path.join(process.env.KADAN_HOME,process.env.KADAN_ROLE+'.ready'),'ready');\n");
 const harness=path.join(home,'codex');
 fs.writeFileSync(harness,`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(receiver)} "$@"\n`);fs.chmodSync(harness,0o755);
 fs.writeFileSync(path.join(home,'runner-settings.json'),JSON.stringify(settingsDoc({worker:{runner:'codex',model:'new-model',effort:'high'},reviewer:REVIEWER})));
 const store=new CardStore(home);
 const assign=(id,role)=>{const c=store.create({repo:'r',id,repoPath:home,body:'# 지시'});store.update(c.key,{status:'assigned',role,board:'r',scope:'시험 범위',...rally},{revision:1,note:'배정'});return c;};
 const started=[];
 try{
  // (1) 기본값(new-model)이 생기기 전에 옛 모델(old-model)로 띄운 작업자 세션
  run('start','rg-old','--hidden','--profile','worker','--cmd',`${harness} --model old-model`,'--reason','시험: 옛 세션');started.push('kadan-rg-old');
  // (2) 감독이 그 세션에 start를 다시 부른다 — '시작됨'이 나오지만 새로 띄운 것이 아니다
  const again=run('start','rg-old','--hidden','--profile','worker');
  assert.match(again.stdout,/이미 살아 있음/);assert.match(again.stdout,/시작됨/);
  const starts=ledger().filter(e=>e.kind==='start'&&e.session==='kadan-rg-old');
  assert.equal(starts.length,2);
  assert.equal(starts[0].model,'old-model');
  assert.equal(starts[1].panePid,starts[0].panePid,'같은 pane');
  for(const key of ['cmd','harness','model','launchSource'])assert.equal(starts[1][key],undefined,`재사용 start 기록에 ${key}가 있다`);
  // (3) 카드 발령은 거절된다 — 전달·send 원장 없음
  assign('card-old','rg-old');
  const denied=call('send','rg-old','--task','card-old','카드 지시 본문');
  assert.notEqual(denied.status,0);
  assert.match(denied.stderr,/옛 실행기·모델 세션이다/);assert.match(denied.stderr,/old-model/);assert.match(denied.stderr,/new-model/);
  assert.equal(sends().length,0);
  pause(300);assert.doesNotMatch(paneText('kadan-rg-old'),/카드 지시 본문/,'옛 세션 pane에 카드가 붙여넣어졌다');
  // (4) 빈 이유는 거절, 이유가 있으면 예외 통과하고 이유가 send 원장에 남는다
  const blank=call('send','rg-old','--task','card-old','--allow-old-runner','','카드 지시 본문');
  assert.notEqual(blank.status,0);assert.equal(sends().length,0);
  const allowed=call('send','rg-old','--task','card-old','--allow-old-runner','시험 예외','카드 지시를 수행하라');
  assert.equal(allowed.status,0,allowed.stderr);
  assert.equal(sends().length,1);assert.equal(sends()[0].runnerGuard.result,'allowed');assert.equal(sends()[0].runnerGuard.reason,'시험 예외');
  // (5) 기본값 모델·실행기로 띄운 세션은 통과한다 — 명령 문자열만 달라(경로 접두) 경고 한 줄이 붙는다
  run('start','rg-new','--hidden','--profile','worker','--cmd',`${harness} --model new-model`,'--reason','시험: 새 세션');started.push('kadan-rg-new');
  assign('card-new','rg-new');
  const ok=call('send','rg-new','--task','card-new','카드 지시를 수행하라');
  assert.equal(ok.status,0,ok.stderr);assert.match(ok.stderr,/강도·실행 인자가 지금 worker 기본값과 다르다/);
  assert.equal(sends().at(-1).runnerGuard.result,'warn');
  // (6) 검수 재현: --profile 없이 옛 모델로 띄운 세션(시작 기록에 프로필 없음)에 --raw로 카드 발령 — 거절된다
  const before=sends().length;
  run('start','rg-legacy','--hidden','--cmd',`${harness} --model old-model`,'--reason','시험: 프로필 없는 옛 세션');started.push('kadan-rg-legacy');
  assert.equal(ledger().find(e=>e.kind==='start'&&e.session==='kadan-rg-legacy').roleProfile,undefined);
  assign('card-legacy','rg-legacy');
  for(const extra of [[],['--raw']]){
   const rawDenied=call('send','rg-legacy','--task','card-legacy',...extra,'카드 지시 RAW본문');
   assert.notEqual(rawDenied.status,0,`${extra}: ${rawDenied.stdout}`);
   assert.match(rawDenied.stderr,/옛 실행기·모델 세션이다/);assert.match(rawDenied.stderr,/old-model/);
  }
  assert.equal(sends().length,before);
  pause(300);assert.doesNotMatch(paneText('kadan-rg-legacy'),/RAW본문/,'--raw 발령이 옛 세션 pane에 붙여넣어졌다');
  // 빈 이유는 --raw여도 거절, 이유가 있으면 예외 통과
  const rawBlank=call('send','rg-legacy','--task','card-legacy','--raw','--allow-old-runner','','카드 지시 RAW본문');
  assert.notEqual(rawBlank.status,0);assert.match(rawBlank.stderr,/이유가 필요하다/);assert.equal(sends().length,before);
  const rawAllowed=call('send','rg-legacy','--task','card-legacy','--raw','--allow-old-runner','시험 raw 예외','카드 지시를 수행하라');
  assert.equal(rawAllowed.status,0,rawAllowed.stderr);
  assert.equal(sends().length,before+1);assert.equal(sends().at(-1).runnerGuard.reason,'시험 raw 예외');
 }finally{
  for(const s of started)tmux('kill-session','-t',s);
 }
});
