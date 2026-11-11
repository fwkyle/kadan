import "./helpers/isolated-home.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {CardStore} from '../src/card-store.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {appendStream,readStream} from '../src/storage.mjs';
import {DecisionStore,decisionCommand,CHAT_OPTIONS} from '../src/decisions.mjs';
import {workCommand} from '../src/work-command.mjs';
import {appendLedger,readLedger} from '../src/ledger.mjs';
import {autopilotState} from '../src/autopilot.mjs';
import {summarizeAutopilot} from '../src/autopilot-summary.mjs';
import {renderDecisions} from '../src/decision-wall.mjs';
process.env.KADAN_NOTIFY='off';
const SUPER='a-슈퍼감독';
const mkWork=(works,key)=>works.create({key,title:'채팅 시험',goal:'목표',scope:'범위',acceptance:'조건',owner:'a-감독',repoPath:os.tmpdir()});
function fixture(){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-decision-chat-'));
  const cards=new CardStore(home),works=new WorkStore(home),sent=[],user=[];
  cards.create({repo:'repo',id:'card-a',repoPath:home,body:'# 테스트'});
  mkWork(works,'repo/w1');mkWork(works,'repo/w2');
  const store=new DecisionStore(home,{notify:(...x)=>sent.push(x),userNotify:(...x)=>{user.push(x);return null}});
  const body=path.join(home,'body.md');fs.writeFileSync(body,'지시');
  return {home,cards,works,store,sent,user,body,ctx:{home,by:SUPER}};
}
const chatInput={question:'합칠까요?',work:'repo/w1'};
const cardInput={question:'카드 결정?',options:['예','아니오'],recommendation:'예',reason:'이유\n- 확인 경로 없음: 시험',work:'repo/w1'};
const events=home=>readStream(home,'decisions/events.jsonl');

test('채팅 등록: 업무만 있으면 되고 기본 선택지·확인 경로가 자동으로 채워지며 알림은 0건이다',()=>{
  const f=fixture();
  const d=f.store.request(null,{...chatInput,chat:true},SUPER);
  assert.equal(d.chat,true);assert.equal(d.card,null);assert.equal(d.work,'repo/w1');
  assert.deepEqual(d.options,[...CHAT_OPTIONS]);assert.equal(d.recommendation,'추천대로 진행');
  assert.match(d.reason,/^- 확인 경로 없음: 채팅 질문$/m);
  assert.deepEqual(f.user,[],'등록 알림(디코·OS) 0건');assert.deepEqual(f.sent,[]);
  // 같은 work+요청자+질문은 같은 결정(중복 판정은 카드가 아니라 업무 기준)
  assert.equal(f.store.request(null,{...chatInput,chat:true},SUPER).id,d.id);
  assert.notEqual(f.store.request(null,{...chatInput,work:'repo/w2',chat:true},SUPER).id,d.id);
  // 직접 준 선택지는 지금 규칙대로, 이유에 이미 확인 경로가 있으면 줄을 덧붙이지 않는다
  const own=f.store.request(null,{question:'다른 질문',options:['A','B'],recommendation:'B',reason:'- PR: https://github.com/o/r/pull/1',work:'repo/w1',chat:true},SUPER);
  assert.deepEqual(own.options,['A','B']);assert.ok(!own.reason.includes('확인 경로 없음'));
  assert.throws(()=>f.store.request(null,{question:'x',work:'repo/w1',options:['A'],recommendation:'A',chat:true},SUPER),/선택지/);
  // 업무가 필요하고, 카드와 같이 쓰지 못하고, 슈퍼감독만 쓴다
  assert.throws(()=>f.store.request(null,{question:'x',chat:true},SUPER),/--work/);
  assert.throws(()=>f.store.request(null,{question:'x',work:'없음',chat:true},SUPER),/--work/);
  assert.throws(()=>f.store.request('repo/card-a',{...chatInput,chat:true},SUPER),/카드 없이/);
  assert.throws(()=>f.store.request(null,{...chatInput,chat:true},'작업자'),/슈퍼감독/);
});

test('CLI: --chat은 카드키 없이 --work로 등록하고 닫는 명령을 한 줄로 안내한다. 일반 결정은 그대로다',()=>{
  const f=fixture();
  const out=decisionCommand(['request'],{chat:true,question:'합칠까요?',work:'repo/w1'},{home:f.home,by:SUPER,notify:()=>{}});
  assert.equal(out.chatCloseCommand,`kadan decision cancel ${out.id} --revision 1 --reason "kyle 채팅 답: <원문>"`);
  assert.throws(()=>decisionCommand(['request','repo/card-a'],{chat:true,question:'x',work:'repo/w1'},{home:f.home,by:SUPER,notify:()=>{}}),/카드키 없이/);
  assert.throws(()=>decisionCommand(['request'],{question:'x',option:['a','b'],recommend:'a',reason:'r'},{home:f.home,by:SUPER,notify:()=>{}}));
  const plain=decisionCommand(['request','repo/card-a'],cardInput.work?{question:cardInput.question,option:cardInput.options,recommend:'예',reason:cardInput.reason,work:'repo/w1'}:{},{home:f.home,by:SUPER,notify:()=>{}});
  assert.equal(plain.chat,undefined);assert.equal(plain.card,'repo/card-a');assert.equal('chatCloseCommand' in plain,false);
});

test('옛 이력이 섞여도 list()가 통과하고, chat이 아닌 card:null·모양이 틀린 chat 행은 손상으로 거절한다',()=>{
  const f=fixture();
  const old=f.store.request('repo/card-a',cardInput,SUPER);
  const chat=f.store.request(null,{...chatInput,chat:true},SUPER);
  assert.deepEqual(f.store.list().map(d=>d.id).sort(),[old.id,chat.id].sort());
  const bad=extra=>{const g=fixture();g.store.request(null,{...chatInput,chat:true},SUPER);
    appendStream(g.home,'decisions/events.jsonl',{...events(g.home)[0],id:'x',revision:1,...extra});
    assert.throws(()=>g.store.list(),/결정 이력 손상/);};
  bad({chat:undefined});            // chat 없이 card:null
  bad({card:'repo/card-a'});        // chat인데 카드가 있음
  bad({work:undefined});            // chat인데 업무가 없음
  bad({chat:false});                // chat은 true만 허용
});

const capture=run=>{const lines=[],write=process.stderr.write;process.stderr.write=s=>{lines.push(String(s));return true;};let result;
  try{result=run();}finally{process.stderr.write=write;}return {result,lines};};
const execute=(f,by)=>capture(()=>workCommand(['execute','repo/w1'],{revision:1,phase:'implementation',round:1,title:'구현','body-file':f.body,note:'실행'},{home:f.home,by}));
const turn=(f,by,owner,revision=1)=>capture(()=>workCommand(['update','repo/w1'],{revision,note:'넘김','turn-owner':owner},{home:f.home,by}));

test('요청자 본인의 work execute와 모든 work complete는 이유 문구와 감사 필드를 남기고 닫는다. 다른 업무·카드 결정은 그대로다',()=>{
  const cases=[
    ['후속 발령으로 자동 닫힘','work execute',(f)=>execute(f,SUPER)],
    ['업무 완료로 자동 닫힘','work complete',(f)=>capture(()=>workCommand(['complete','repo/w1'],{revision:1,result:'끝: 근거 있음',note:'완료'},{home:f.home,by:'사람'}))],
  ];
  for(const [reason,via,run] of cases){
    const f=fixture();
    const mine=f.store.request(null,{...chatInput,chat:true},SUPER),other=f.store.request(null,{...chatInput,work:'repo/w2',chat:true},SUPER);
    const card=f.store.request('repo/card-a',cardInput,SUPER);
    const {lines}=run(f);
    const after=Object.fromEntries(f.store.list().map(d=>[d.id,d]));
    assert.equal(after[mine.id].status,'cancelled',via);
    assert.equal(after[mine.id].cancelReason,reason);assert.equal(after[mine.id].cancelledBy,'자동');assert.equal(after[mine.id].cancelledVia,via);
    assert.equal(after[other.id].status,'open','다른 업무의 채팅 결정은 그대로');
    assert.equal(after[card.id].status,'open','같은 업무의 카드 결정도 그대로');
    assert.deepEqual(f.user,[],'닫힘 알림 0건');
    assert.deepEqual(lines,[],'남긴 결정이 없으면 stderr 없음');
  }
});

test('차례 변경은 요청자 본인이 해도 닫지 않고 남긴 결정마다 stderr 한 줄을 낸다. 같은 값 재저장도 안내한다',()=>{
  for(const by of ['a-감독',SUPER,'사람']){
    const f=fixture();const d=f.store.request(null,{...chatInput,chat:true},SUPER);
    const {result,lines}=turn(f,by,'b-감독');
    assert.equal(result.turnOwner,'b-감독','업무 명령 결과(stdout)는 그대로');
    assert.equal(f.store.get(d.id).status,'open',`${by}의 차례 변경은 닫지 않는다`);
    assert.equal(lines.length,1);
    assert.ok(lines[0].includes(d.id.slice(0,8))&&lines[0].includes(SUPER)&&lines[0].includes('합칠까요?'),lines[0]);
    assert.ok(lines[0].includes(`kadan decision cancel ${d.id} --revision 1 --reason`),lines[0]);
    assert.equal(turn(f,by,'b-감독',2).lines.length,1,'같은 값 재저장도 열린 결정이 남아 있으면 안내한다');
    assert.equal(turn(f,by,'',3).lines.length,1,'차례 해제도 안내한다(닫지 않음)');
    assert.equal(f.store.get(d.id).status,'open');
  }
});

test('다른 역할의 work execute는 닫지 않고 stderr로 알린다. 요청자 본인 것만 닫고 나머지는 알린다. 사람 명의 호출은 닫지 않되 알린다',()=>{
  const f=fixture();
  const mine=f.store.request(null,{...chatInput,chat:true},SUPER),theirs=f.store.request(null,{question:'다른 질문',work:'repo/w1',chat:true},'b-슈퍼감독');
  const {lines}=execute(f,SUPER);
  assert.equal(f.store.get(mine.id).status,'cancelled');assert.equal(f.store.get(theirs.id).status,'open','다른 요청자의 결정은 그대로');
  assert.equal(lines.length,1);assert.ok(lines[0].includes(theirs.id.slice(0,8))&&lines[0].includes('b-슈퍼감독'),lines[0]);
  for(const by of ['a-감독','사람']){
    const g=fixture();const d=g.store.request(null,{...chatInput,chat:true},SUPER);
    const out=execute(g,by);
    assert.equal(g.store.get(d.id).status,'open',`${by}의 발령은 요청자가 아니라 닫지 않는다`);assert.equal(out.lines.length,1);
  }
  const h=fixture();const e=h.store.request(null,{...chatInput,chat:true},SUPER),o=h.store.request(null,{question:'다른 질문',work:'repo/w1',chat:true},'b-슈퍼감독');
  const done=capture(()=>workCommand(['complete','repo/w1'],{revision:1,result:'끝: 근거',note:'완료'},{home:h.home,by:'a-감독'}));
  assert.equal(h.store.get(e.id).status,'cancelled');assert.equal(h.store.get(o.id).status,'cancelled','complete는 요청자와 무관하게 모두 닫는다');
  assert.deepEqual(done.lines,[]);
});

test('F1: 차례 외 update·link·cancel·reopen도 열린 채팅 결정이 남으면 안내하고, cancel은 완료처럼 모두 닫는다. 읽기 명령은 조용하다',()=>{
  const f=fixture();const d=f.store.request(null,{...chatInput,chat:true},SUPER);
  let rev=1;const w=(args,flags,by='a-감독')=>{const out=capture(()=>workCommand(args,{revision:rev,note:'시험',...flags},{home:f.home,by}));rev=f.works.get('repo/w1').revision;return out;};
  for(const flags of [{progress:'2/10'},{'next-action':'다음'},{owner:'b-감독'}]){
    const out=w(['update','repo/w1'],flags);
    assert.equal(out.lines.length,1,JSON.stringify(flags));assert.ok(out.lines[0].includes(d.id.slice(0,8)),out.lines[0]);
    assert.equal(f.store.get(d.id).status,'open');
  }
  for(const args of [['list'],['show','repo/w1']]){
    const lines=capture(()=>workCommand(args,{},{home:f.home,by:'a-감독'})).lines;assert.deepEqual(lines,[],args[0]);
  }
  const cancelled=w(['cancel','repo/w1'],{result:'취소: 근거'},'사람');
  assert.deepEqual(cancelled.lines,[]);
  const after=f.store.get(d.id);
  assert.equal(after.status,'cancelled');assert.equal(after.cancelReason,'업무 취소로 자동 닫힘');assert.equal(after.cancelledBy,'자동');assert.equal(after.cancelledVia,'work cancel');
  assert.deepEqual(w(['reopen','repo/w1'],{},'사람').lines,[],'열린 결정이 없으면 reopen도 조용하다');
  const e=f.store.request(null,{question:'다시 연 뒤 질문',work:'repo/w1',chat:true},SUPER);
  const again=w(['cancel','repo/w1'],{result:'취소: 근거'},'사람');
  assert.deepEqual(again.lines,[]);assert.equal(f.store.get(e.id).status,'cancelled','사람 명의 취소도 요청자와 무관하게 닫는다');
  w(['reopen','repo/w1'],{},'사람');
  const g=f.store.request(null,{question:'세 번째',work:'repo/w1',chat:true},SUPER);
  assert.equal(w(['update','repo/w1'],{progress:'3'}).lines.length,1);assert.equal(f.store.get(g.id).status,'open');
});

test('F2: 실행만 등록되고 배정이 실패해도 업무에 쓴 것이 있으면 안내하고 닫지 않으며 원래 오류를 그대로 던진다. 아무것도 안 쓴 실패는 조용하다',()=>{
  const f=fixture();const d=f.store.request(null,{...chatInput,chat:true},SUPER);
  const body=path.join(f.home,'body-read.md');fs.writeFileSync(body,`## 읽고 시작할 것\n\n- ${f.body} — 시험\n`);
  const lines=[],write=process.stderr.write;process.stderr.write=s=>{lines.push(String(s));return true;};
  let error;try{workCommand(['execute','repo/w1'],{revision:1,phase:'implementation',round:1,title:'구현','body-file':body,note:'x',assign:'invalid/role'},{home:f.home,by:SUPER});}catch(e){error=e;}finally{process.stderr.write=write;}
  assert.ok(error,'원래 오류가 그대로 던져진다');assert.match(error.message,/이미 등록됐다/);
  assert.ok(f.works.get('repo/w1').revision>1,'업무에 실행이 등록됐다');
  assert.equal(f.store.get(d.id).status,'open','실패한 명령은 요청자 본인이어도 닫지 않는다');
  assert.equal(lines.length,1);assert.ok(lines[0].includes(d.id.slice(0,8)),lines[0]);
  const quiet=capture(()=>{try{workCommand(['update','repo/w1'],{revision:99,note:'x',progress:'1'},{home:f.home,by:'a-감독'});}catch{}});
  assert.deepEqual(quiet.lines,[],'업무를 쓰지 못한 실패는 안내하지 않는다');
});

test('결정 목록을 읽지 못하면 결과는 그대로 두고 확인 방법 한 줄을 낸다. 안내는 5줄 + 외 N건이다',()=>{
  const f=fixture();for(let i=0;i<7;i++)f.store.request(null,{question:`질문 ${i}`,work:'repo/w1',chat:true},SUPER);
  const many=capture(()=>workCommand(['update','repo/w1'],{revision:1,note:'x',progress:'1'},{home:f.home,by:'a-감독'}));
  assert.equal(many.lines.length,6);assert.match(many.lines[5],/외 2건/);
  appendStream(f.home,'decisions/events.jsonl','bad');
  const broken=capture(()=>workCommand(['update','repo/w1'],{revision:2,note:'x',progress:'2'},{home:f.home,by:'a-감독'}));
  assert.equal(broken.result.progress,'2','업무 명령 결과는 그대로');
  assert.equal(broken.lines.length,1);assert.match(broken.lines[0],/열린 채팅 결정을 확인하지 못했습니다.*kadan decision list --status open/);
});

test('F3: 안내 문구는 부른 쪽에 맞춘다. 요청자·사람에게는 닫는 명령, 그 밖의 역할에게는 요청자 또는 kyle만 닫을 수 있다고 알린다',()=>{
  const f=fixture();const d=f.store.request(null,{...chatInput,chat:true},SUPER);
  const other=turn(f,'a-감독','b-감독').lines[0];
  assert.match(other,new RegExp(`요청자\\(${SUPER}\\) 또는 kyle만 닫을 수 있습니다 — kyle 답을 받았으면 ${SUPER}가 닫습니다: kadan decision cancel ${d.id} --revision 1`));
  const own=turn(f,SUPER,'c-감독',2).lines[0];
  assert.ok(own.includes(`답을 받았으면 kadan decision cancel ${d.id} --revision 1`)&&!own.includes('만 닫을 수'),own);
  const human=turn(f,'사람','d-감독',3).lines[0];
  assert.ok(!human.includes('만 닫을 수'),human);
});

test('대시보드 폼(WorkStore.change)과 우편 차례 되돌림은 업무 명령 경로를 거치지 않아 채팅 결정을 닫지 않는다',()=>{
  const f=fixture();const d=f.store.request(null,{...chatInput,chat:true},SUPER);
  f.works.change('repo/w1','update',{turnOwner:'b-감독'},{revision:1,by:'사람',note:'폼 저장'});
  f.works.changeTurnOwner('repo/w1',()=>({turnOwner:'a-감독',by:'b-감독',note:'차례 되돌림'}));
  assert.equal(f.store.get(d.id).status,'open');
});

test('실제 CLI(자식 프로세스): 다른 역할의 차례 변경은 stdout JSON·종료 코드를 그대로 두고 stderr 한 줄만 낸다. 열린 결정이 없으면 stderr가 비어 있다',()=>{
  const f=fixture();const d=f.store.request(null,{...chatInput,chat:true},SUPER);
  const cli=new URL('../src/cli.mjs',import.meta.url).pathname,env={...process.env,KADAN_HOME:f.home,KADAN_WINDOW:'none',KADAN_NOTIFY:'off'};
  const run=(args,by)=>spawnSync(process.execPath,[cli,...args],{env:{...env,KADAN_ROLE:by},encoding:'utf8'});
  const r=run(['work','update','repo/w1','--revision','1','--note','넘김','--turn-owner','b-감독'],'a-감독');
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).turnOwner,'b-감독');
  assert.equal(r.stderr.trim().split('\n').length,1);assert.ok(r.stderr.includes(d.id.slice(0,8)),r.stderr);
  assert.equal(f.store.get(d.id).status,'open');
  f.store.cancel(d.id,{revision:1,reason:'kyle 채팅 답: 진행'},SUPER);
  const quiet=run(['work','update','repo/w1','--revision','2','--note','다시','--turn-owner','c-감독'],'a-감독');
  assert.equal(quiet.status,0,quiet.stderr);assert.equal(quiet.stderr,'');
});

test('업무 명령이 실패하면 닫지 않고, 닫기가 실패해도 업무 명령은 성공하며 stderr에 한 줄만 낸다. 만료는 없다',()=>{
  const f=fixture();const d=f.store.request(null,{...chatInput,chat:true},SUPER);
  assert.throws(()=>workCommand(['execute','repo/w1'],{revision:9,phase:'implementation',round:1,title:'구현','body-file':f.body,note:'x'},f.ctx));
  assert.equal(f.store.get(d.id).status,'open','실패한 업무 명령은 닫지 않는다');
  workCommand(['update','repo/w1'],{revision:1,note:'진행',progress:'3/10'},f.ctx); // turn-owner 없는 update
  assert.equal(f.store.get(d.id).status,'open');
  appendStream(f.home,'decisions/events.jsonl','bad'); // 결정 저장소를 읽을 수 없게 만든다
  const lines=[],write=process.stderr.write;process.stderr.write=s=>{lines.push(String(s));return true;};
  let result;try{result=workCommand(['complete','repo/w1'],{revision:2,result:'끝: 근거',note:'완료'},{home:f.home,by:'사람'});}finally{process.stderr.write=write;}
  assert.equal(result.status,'done','닫기 실패가 업무 명령을 깨뜨리지 않는다');
  assert.equal(lines.length,1);assert.match(lines[0],/열린 채팅 결정을 확인하지 못했습니다/);
});

test('자동 닫기용 by는 채팅 결정에만 통하고, 사람이 답하면 요청자에게 직접 라우팅한다',()=>{
  const f=fixture();
  const card=f.store.request('repo/card-a',cardInput,SUPER),chat=f.store.request(null,{...chatInput,chat:true},SUPER);
  assert.throws(()=>f.store.cancel(card.id,{revision:1,reason:'x'},'자동'),/요청자 또는 사용자/);
  assert.throws(()=>f.store.cancel(chat.id,{revision:1,reason:'x'},'아무개'),/요청자 또는 사용자/);
  const answered=f.store.answer(chat.id,{revision:1,choice:'추천대로 진행'},'사람');
  assert.equal(answered.delivery.status,'sent');assert.equal(answered.delivery.role,SUPER);
  assert.equal(f.sent.length,1);assert.equal(f.sent[0][0],SUPER);assert.match(f.sent[0][1],/업무 repo\/w1: 추천대로 진행/);
  assert.deepEqual(f.user,[],'답 알림(디코·OS)도 0건');
  // 요청자가 kyle의 채팅 답을 원문과 함께 닫는다
  const next=f.store.request(null,{question:'둘째?',work:'repo/w2',chat:true},SUPER);
  const closed=f.store.cancel(next.id,{revision:1,reason:'kyle 채팅 답: 진행해'},SUPER);
  assert.equal(closed.cancelledBy,SUPER);assert.equal(closed.cancelReason,'kyle 채팅 답: 진행해');
});

test('Autopilot 요약: 채팅 등록은 따로 세고 자동 닫힘·요청자 닫힘은 취소로 세지 않는다. 채팅 닫힘도 사람 답도 Autopilot을 끄지 않는다',()=>{
  const T0=Date.parse('2026-10-23T14:00:00.000Z'),H=3600_000,iso=ms=>new Date(ms).toISOString();
  const row={card:null,chat:true,work:'repo/w1',requestedBy:SUPER,question:'?',options:['a','b'],recommendation:'a',reason:'r',to:'@user'};
  const evs=[
    {...row,id:'c1',revision:1,status:'open',at:iso(T0+H)},
    {...row,id:'c1',revision:2,status:'cancelled',cancelledBy:'자동',cancelledAt:iso(T0+2*H),cancelReason:'후속 발령으로 자동 닫힘'},
    {...row,id:'c2',revision:1,status:'open',at:iso(T0+H)},
    {...row,id:'c2',revision:2,status:'cancelled',cancelledBy:SUPER,cancelledAt:iso(T0+2*H),cancelReason:'kyle 채팅 답: 응'},
    {...row,id:'c3',revision:1,status:'open',at:iso(T0-H)}, // 켜지기 전 등록은 세지 않는다
  ];
  const start={kind:'autopilot',phase:'on',t:iso(T0),until:iso(T0+8*H),by:'사람',text:'자러 감',to:[],delivered:[]};
  const s=summarizeAutopilot({start,phase:'off',endedAt:T0+4*H,entries:[],decisionEvents:evs,readBody:()=>null});
  assert.equal(s.counts.chatRegistered,2);assert.equal(s.counts.cancelledByHuman,0);assert.equal(s.counts.cancelledBySuper,0);
  assert.match(s.text,/채팅 등록 2건/);assert.doesNotMatch(s.text,/취소한 결정|대신 닫은 결정/);
  assert.equal(autopilotState([start],T0+3*H).on,true,'채팅 닫힘은 Autopilot을 끄지 않는다');
  const human={...row,id:'c4',revision:2,status:'answered',answer:{by:'사람',text:'ok',at:iso(T0+3*H)}};
  assert.equal(autopilotState([start],T0+3*H).on,true,'사람 명의 답도 Autopilot을 끄지 않는다(결정 저장소는 보지 않는다)');void human;
});

test('대시보드 결정 화면: 채팅 꼬리표와 업무·경과 시간을 보이고 깨진 카드 링크(?card=null)를 만들지 않는다',()=>{
  const f=fixture();const chat=f.store.request(null,{...chatInput,chat:true},SUPER);const card=f.store.request('repo/card-a',cardInput,SUPER);
  const html=renderDecisions(f.store.list(),null,'tok');
  assert.match(html,/<span class="dc-chat">채팅<\/span><span class="dc-key">업무 repo\/w1<\/span>/);
  assert.ok(!html.includes('?card=null'));assert.match(html,/href="\?card=repo%2Fcard-a#detail"/);
  assert.match(html,new RegExp(`id="decision-${chat.id}"[\\s\\S]*방금`));
  assert.ok(html.includes(card.id));
});

test('저장소 점검은 카드가 없는 채팅 결정을 "가리키는 카드 없음"으로 거절하지 않는다',async()=>{
  const {verifyStorage}=await import('../src/storage-migration.mjs');
  const f=fixture();f.store.request(null,{...chatInput,chat:true},SUPER);f.store.request('repo/card-a',cardInput,SUPER);
  assert.doesNotThrow(()=>verifyStorage(f.home));
});
