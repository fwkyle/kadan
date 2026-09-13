import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CardStore } from '../src/card-store.mjs';
import { buildCardCenter } from '../src/card-center.mjs';
import { createWallServer } from '../src/wall.mjs';
import { renderCenterWall } from '../src/center-wall.mjs';
function fixture(){const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-center-'));const store=new CardStore(home);const c=store.create({repo:'repo',id:'card-a',repoPath:home,body:'# 제품 검색',by:'사람'});return{home,store,c};}
const rows=[{kind:'plan',taskId:'card-a',board:'integration',t:'2020-09-07T00:00:00Z'}, {kind:'send',role:'different-작업자',taskId:'card-a',t:'2020-09-07T00:01:00Z'}];
const tree=[{name:'different',roles:[{role:'different-작업자',life:{state:'alive',pidState:'match'}}]}];
test('09-07 중앙 카드 버전/승인/배정 경계와 질문 답변 기록',()=>{
 const {store,c}=fixture();assert.throws(()=>store.checkSend('card-a','r'),/발령 불가/);
 assert.throws(()=>store.update(c.key,{status:'ready'},{revision:1,note:'승인'}),/범위/);
 const ready=store.update(c.key,{status:'ready',scope:'로컬 구현만'},{revision:1,note:'사용자 승인'});
 assert.throws(()=>store.update(c.key,{title:'stale'},{revision:1,note:'충돌'}),/변경됨/);
 assert.throws(()=>store.checkSend('card-a','r'),/발령 불가/);
 store.update(c.key,{status:'assigned',role:'r',board:'b',rallyId:'r1',rallyTitle:'묶음',rallyRound:'1',rallyStep:'implementation'},{revision:ready.revision,note:'범위 그대로 배정'});
 assert.equal(store.checkSend('card-a','r').board,'b');
 assert.throws(()=>store.checkSend('card-a','r2'),/발령 불가/);
 store.update(c.key,{}, {revision:3,note:'질문 <script>',noteKind:'question',by:'슈퍼감독'});
 assert.equal(store.get(c.key).history[3].by,'슈퍼감독');
 assert.throws(()=>store.get('../escape'),/주소/);
});
test('09-07 중앙 원본 연결과 원본 변경/이력 손상은 조용히 덮어쓰지 않는다',()=>{
 const {store,home}=fixture();const source=path.join(home,'old.md');fs.writeFileSync(source,'# 옛 카드');
 const c=store.create({repo:'repo',id:'card-b',repoPath:home,sourcePath:source});store.link(c.key);
 assert.equal(fs.realpathSync(source),fs.realpathSync(c.path));assert.equal(fs.readFileSync(source,'utf8'),'# 옛 카드');
 assert.equal(fs.readdirSync(store.dir(c.key)).filter(n=>n.startsWith('original-')).length,1);
 fs.appendFileSync(path.join(store.dir(c.key),'events.jsonl'),'broken\n');assert.throws(()=>store.list());
});
test('09-07 생존은 진행이 아님, 다른 역할 이름도 명시 계획에 연결하고 재발령은 재개한다',()=>{
 const {c}=fixture();let center=buildCardCenter({cards:[c],entries:rows,tree});
 assert.equal(center.cards[0].displayState,'unconfirmed');assert.equal(center.boards[0].name,'integration');assert.equal(center.boards.length,1);
 const done={kind:'done',taskId:'card-a',role:'different-작업자',result:'ok',t:'2020-09-07T00:02:00Z'};
 center=buildCardCenter({cards:[c],entries:[...rows,done],tree});assert.equal(center.cards[0].displayState,'done');
 center=buildCardCenter({cards:[c],entries:[...rows,done,{...rows[1],t:'2020-09-07T00:03:00Z'}],tree});assert.equal(center.cards[0].displayState,'unconfirmed');
 center=buildCardCenter({cards:[c],entries:[...rows,{...done,role:'검수자'}],tree});assert.equal(center.cards[0].displayState,'unconfirmed');
 center=buildCardCenter({cards:[c],entries:rows,tree:[],runtimeKnown:false});assert.equal(center.cards[0].runs[0].sessionState,'unknown');assert.equal(center.cards[0].displayState,'unconfirmed');
 assert.throws(()=>buildCardCenter({cards:[c],entries:[{broken:'oops'}],tree}),/손상/);
});
test('09-07 저장소별 동일 ID는 합치지 않으며 명시 보류/완료는 과거 발송으로 되돌리지 않는다',()=>{
 const {c,store}=fixture();const hold=store.update(c.key,{status:'hold'},{revision:1,note:'사용자 판단 대기'});
 assert.equal(buildCardCenter({cards:[hold],entries:rows,tree}).cards[0].displayState,'hold');
 const center=buildCardCenter({cards:[c,{...c,key:'other/card-a',repo:'other'}],entries:rows,tree});
 assert.ok(center.cards.every(c=>c.ambiguous&&c.runs.length===0));assert.equal(center.unregistered.length,1);
});
test('09-07 웹 저장은 출처/토큰/버전을 확인하고 저장 뒤 조회로 돌아온다',async()=>{
 const {home,c,store}=fixture();const center=buildCardCenter({cards:[c],entries:[],tree:[]});
 const snapshot={center,collectedAt:new Date(),tree:[],entries:[],ledgerLines:0};
 const server=createWallServer(()=>snapshot,{home});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 try{
  const html=await (await fetch(base)).text();const token=html.match(/name="token" value="([a-f0-9]+)"/)[1];
  const post=(data,origin=base)=>fetch(base+'/cards/update',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin},body:new URLSearchParams(data),redirect:'manual'});
  const data={token,key:c.key,revision:'1',title:'제품 <img onerror=oops>',status:'draft',scope:'',note:'답변',noteKind:'answer'};
  assert.equal((await post(data,'https://evil.example')).status,403);
  assert.equal((await post({...data,token:'bad'})).status,403);
  assert.equal((await post(data)).status,303);
  assert.equal((await post(data)).status,409);
  assert.equal(store.get(c.key).history.length,2);
  const rendered=renderCenterWall({...snapshot,center:buildCardCenter({cards:store.list(),entries:[],tree:[]})},{url:new URL(base+'/?card='+encodeURIComponent(c.key))});
  assert.ok(rendered.includes('&lt;img onerror=oops&gt;'));assert.ok(!rendered.includes('<img onerror'));
 }finally{await new Promise(resolve=>server.close(resolve))}
});
test('09-07 시작 보고는 시간으로 만료되지 않으며 세션 소실은 따로 표시한다',()=>{
 const {store,c}=fixture();const s=store.update(c.key,{status:'assigned',scope:'로컬',board:'b',role:'different-작업자',rallyId:'r1',rallyTitle:'묶음',rallyRound:'1',rallyStep:'implementation'},{revision:1,note:'배정'});
 assert.throws(()=>store.update(c.key,{activity:'running'},{revision:s.revision,by:'비서',note:'진행'}),/배정된 역할/);
 const active=store.update(c.key,{activity:'running'},{revision:s.revision,by:'different-작업자',note:'구현 시작'});
 const now=Date.parse(active.activityAt)+1000;
 assert.equal(buildCardCenter({cards:[active],entries:rows,tree,now}).cards[0].displayState,'running');
 assert.equal(buildCardCenter({cards:[active],entries:rows,tree,now:now+900000}).cards[0].displayState,'running');
 assert.equal(buildCardCenter({cards:[active],entries:rows,tree:[],now}).cards[0].displayState,'orphaned');
});
test('09-07 인계한 중앙 카드도 후임에게 귀속하며 옛 담당에게 발령하지 않는다',()=>{
 const {store,c,home}=fixture();store.update(c.key,{status:'assigned',scope:'로컬',board:'b',role:'old',rallyId:'r1',rallyTitle:'묶음',rallyRound:'1',rallyStep:'implementation'},{revision:1,note:'배정'});
 const transfer={kind:'handover',phase:'transferred',from:'old',to:'new',taskIds:['card-a'],t:'2099-01-01T00:00:00Z'};
 fs.writeFileSync(path.join(home,'ledger.jsonl'),JSON.stringify(transfer)+'\n');
 assert.equal(store.checkSend('card-a','new').role,'new');assert.throws(()=>store.checkSend('card-a','old'),/발령 불가/);
 const center=buildCardCenter({cards:store.list(),entries:[transfer],tree:[]});assert.equal(center.cards[0].role,'new');
});
test('09-07 완료된 카드도 명시적으로 다시 ready로 바꾸면 과거 완료가 새 결정을 덮지 않는다',()=>{
 const {store,c}=fixture();const done={kind:'done',role:'different-작업자',taskId:'card-a',result:'ok',t:'2020-09-07T00:02:00Z'};
 const ready=store.update(c.key,{status:'ready',scope:'두번째 검토만'},{revision:1,note:'추가 범위를 결정했다'});
 const x=buildCardCenter({cards:[ready],entries:[...rows,done],tree});assert.equal(x.cards[0].displayState,'ready');assert.equal(x.summary.ready,1);
});
test('작업/결과대기 상태는 하루 뒤에도 유지하지만 재발령·완료·실패·담당변경으로 재평가한다',()=>{
 const {store,c}=fixture();const assigned=store.update(c.key,{status:'assigned',scope:'로컬',board:'b',role:'different-작업자',rallyId:'r1',rallyTitle:'묶음',rallyRound:'1',rallyStep:'implementation'},{revision:1,note:'배정'});
 const active=store.update(c.key,{activity:'running'},{revision:assigned.revision,by:'different-작업자',note:'시작'});
 const at=Date.parse(active.activityAt),now=at+86400000;
 const state=(card=active,entries=rows,roles=tree,runtimeKnown=true)=>buildCardCenter({cards:[card],entries,tree:roles,now,runtimeKnown}).cards[0].displayState;
 assert.equal(state(),'running');assert.equal(state({...active,activity:'waiting'}),'waiting');
 assert.equal(state(active,[...rows,{...rows[1],t:new Date(at+1000).toISOString()}]),'unconfirmed');
 for(const [result,expected] of [['ok','done'],['failed','failed']])assert.equal(state(active,[...rows,{kind:'done',role:active.role,taskId:active.id,result,t:new Date(at+1000).toISOString()}]),expected);
 assert.equal(state({...active,status:'hold',at:new Date(at+1000).toISOString()}),'hold');
 assert.equal(state({...active,role:'successor'}),'unconfirmed');
 assert.equal(state(active,rows,[{roles:[{role:active.role,life:{state:'alive',pidState:'changed'}}]}]),'unconfirmed');
 assert.equal(state(active,rows,tree,false),'unconfirmed');
 assert.equal(state({...active,activity:'unknown'}),'unconfirmed');
 assert.equal(state({...active,activityAt:new Date(now+1000).toISOString()}),'unconfirmed');
});

test('역할별 최신 시작 기록의 실행기·모델을 모은다 — 모델 없는 시작은 제외',()=>{
 const entries=[...rows,
  {kind:'start',role:'different-작업자',harness:'codex',model:'xai/grok-4.6',t:'2020-09-07T00:02:00Z'},
  {kind:'start',role:'different-작업자',harness:'codex',model:'command-code/deepseek-v4',cmd:'codex -p lite --model command-code/deepseek-v4 -c model_reasoning_effort="max"',t:'2020-09-07T00:03:00Z'},
  {kind:'start',role:'other-역할',t:'2020-09-07T00:04:00Z'}];
 const center=buildCardCenter({cards:[],entries,tree});
assert.deepEqual(center.models['different-작업자'],{harness:'codex',model:'command-code/deepseek-v4',at:'2020-09-07T00:03:00Z',effort:'max'});
assert.equal(center.models['other-역할'],undefined);
});

test('강도는 실행기마다 다른 플래그에서 읽는다 — codex·claude·omo',()=>{
const entries=[...rows,
 {kind:'start',role:'claude-검수자',harness:'claude',model:'fable',cmd:'claude --model fable --effort xhigh --dangerously-skip-permissions',t:'2020-09-07T00:05:00Z'},
 {kind:'start',role:'omo-작업자',harness:'omo',model:'openai-codex/gpt-6-astra',cmd:'omo --model openai-codex/gpt-6-astra --thinking high --no-recommended-models',t:'2020-09-07T00:06:00Z'}];
const center=buildCardCenter({cards:[],entries,tree});
assert.equal(center.models['claude-검수자'].effort,'xhigh');
assert.equal(center.models['omo-작업자'].effort,'high');
});

test('겹따옴표로 감싼 강도도 읽는다',()=>{
 const entries=[...rows,
  {kind:'start',role:'kimi-작업자',harness:'codex',model:'kimi/k3[1m]',cmd:`codex -p lite --model 'kimi/k3[1m]' -c model_reasoning_effort='"max"'`,t:'2020-09-07T00:07:00Z'}];
 const center=buildCardCenter({cards:[],entries,tree});
 assert.equal(center.models['kimi-작업자'].effort,'max');
});
