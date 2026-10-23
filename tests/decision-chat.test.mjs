import "./helpers/isolated-home.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CardStore} from '../src/card-store.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {appendStream,readStream} from '../src/storage.mjs';
import {DecisionStore,decisionCommand,CHAT_OPTIONS} from '../src/decisions.mjs';
import {workCommand} from '../src/work-command.mjs';
import {appendLedger,readLedger} from '../src/ledger.mjs';
import {nightState} from '../src/night.mjs';
import {summarizeNight} from '../src/night-summary.mjs';
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

test('자동 닫힘 3경로: 같은 업무의 열린 채팅 결정만 이유 문구와 감사 필드를 남기고 닫힌다. 다른 업무·카드 결정은 그대로다',()=>{
  const cases=[
    ['후속 발령으로 자동 닫힘','work execute',(f)=>workCommand(['execute','repo/w1'],{revision:1,phase:'implementation',round:1,title:'구현','body-file':f.body,note:'실행'},f.ctx)],
    ['차례 변경으로 자동 닫힘','work update --turn-owner',(f)=>workCommand(['update','repo/w1'],{revision:1,note:'넘김','turn-owner':'a-감독'},f.ctx)],
    ['업무 완료로 자동 닫힘','work complete',(f)=>workCommand(['complete','repo/w1'],{revision:1,result:'끝: 근거 있음',note:'완료'},{home:f.home,by:'사람'})],
  ];
  for(const [reason,via,run] of cases){
    const f=fixture();
    const mine=f.store.request(null,{...chatInput,chat:true},SUPER),other=f.store.request(null,{...chatInput,work:'repo/w2',chat:true},SUPER);
    const card=f.store.request('repo/card-a',cardInput,SUPER);
    run(f);
    const after=Object.fromEntries(f.store.list().map(d=>[d.id,d]));
    assert.equal(after[mine.id].status,'cancelled',via);
    assert.equal(after[mine.id].cancelReason,reason);assert.equal(after[mine.id].cancelledBy,'자동');assert.equal(after[mine.id].cancelledVia,via);
    assert.equal(after[other.id].status,'open','다른 업무의 채팅 결정은 그대로');
    assert.equal(after[card.id].status,'open','같은 업무의 카드 결정도 그대로');
    assert.deepEqual(f.user,[],'닫힘 알림 0건');
  }
});

test('차례 변경으로 닫는 것은 저장 전후 turnOwner가 실제로 다를 때만이다. 같은 값 재저장은 열어 둔다. 차례 해제(값 비움)는 변경이다',()=>{
  const f=fixture();
  workCommand(['update','repo/w1'],{revision:1,note:'넘김','turn-owner':'a-감독'},f.ctx);
  const d=f.store.request(null,{...chatInput,chat:true},SUPER);
  workCommand(['update','repo/w1'],{revision:2,note:'같은 값 재저장','turn-owner':'a-감독'},f.ctx);
  assert.equal(f.store.get(d.id).status,'open','같은 값 재저장은 닫지 않는다');
  workCommand(['update','repo/w1'],{revision:3,note:'다른 값','turn-owner':'b-감독'},f.ctx);
  assert.equal(f.store.get(d.id).status,'cancelled','다른 값은 닫는다');
  const e=f.store.request(null,{...chatInput,chat:true},SUPER);
  workCommand(['update','repo/w1'],{revision:4,note:'차례 해제','turn-owner':''},f.ctx);
  assert.equal(f.store.get(e.id).status,'cancelled','차례 해제도 차례가 움직인 변경이다');
  const g=f.store.request(null,{...chatInput,chat:true},SUPER);
  workCommand(['update','repo/w1'],{revision:5,note:'빈 값 재저장','turn-owner':''},f.ctx);
  assert.equal(f.store.get(g.id).status,'open','비운 채 다시 비우는 것은 변경이 아니다');
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
  assert.equal(lines.length,1);assert.match(lines[0],/채팅 결정 자동 닫기 실패/);
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

test('나이트 요약: 채팅 등록은 따로 세고 자동 닫힘·요청자 닫힘은 취소로 세지 않는다. 채팅 닫힘은 밤을 끄지 않고 사람 답만 끈다',()=>{
  const T0=Date.parse('2026-10-23T14:00:00.000Z'),H=3600_000,iso=ms=>new Date(ms).toISOString();
  const row={card:null,chat:true,work:'repo/w1',requestedBy:SUPER,question:'?',options:['a','b'],recommendation:'a',reason:'r',to:'@user'};
  const evs=[
    {...row,id:'c1',revision:1,status:'open',at:iso(T0+H)},
    {...row,id:'c1',revision:2,status:'cancelled',cancelledBy:'자동',cancelledAt:iso(T0+2*H),cancelReason:'후속 발령으로 자동 닫힘'},
    {...row,id:'c2',revision:1,status:'open',at:iso(T0+H)},
    {...row,id:'c2',revision:2,status:'cancelled',cancelledBy:SUPER,cancelledAt:iso(T0+2*H),cancelReason:'kyle 채팅 답: 응'},
    {...row,id:'c3',revision:1,status:'open',at:iso(T0-H)}, // 켜지기 전 등록은 세지 않는다
  ];
  const start={kind:'night',phase:'on',t:iso(T0),until:iso(T0+8*H),by:'사람',text:'자러 감',to:[],delivered:[]};
  const s=summarizeNight({start,phase:'off',endedAt:T0+4*H,entries:[],decisionEvents:evs,readBody:()=>null});
  assert.equal(s.counts.chatRegistered,2);assert.equal(s.counts.cancelledByHuman,0);assert.equal(s.counts.cancelledBySuper,0);
  assert.match(s.text,/채팅 등록 2건/);assert.doesNotMatch(s.text,/취소한 결정|대신 닫은 결정/);
  assert.equal(nightState([start],evs,T0+3*H).on,true,'채팅 닫힘은 밤을 끄지 않는다');
  const human={...row,id:'c4',revision:2,status:'answered',answer:{by:'사람',text:'ok',at:iso(T0+3*H)}};
  assert.equal(nightState([start],[...evs,human],T0+3*H).pending.phase,'ended-by-input','사람 명의 답만 밤을 끈다');
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
