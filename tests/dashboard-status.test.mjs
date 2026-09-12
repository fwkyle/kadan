import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {renderDashboardStatus,recentExecutionEvents,staleCleanupRequest} from '../src/dashboard-status.mjs';
import {executionBucket,executionHealth} from '../src/dashboard-execution.mjs';
import {boardProgressCounts} from '../src/board-progress.mjs';
import {cardCommand} from '../src/card-command.mjs';
import {CardStore} from '../src/card-store.mjs';

const now=Date.parse('2026-09-12T11:00:00Z');
const at=hoursAgo=>new Date(now-hoursAgo*3600_000).toISOString();
const work=(over={})=>({key:'work:r/w1',id:'w1',repo:'r',title:'현황 업무',state:'running',stateLabel:'진행 중',purpose:'사용자에게 약속한 결과',flowLabel:'1라운드 · 구현',flowPhase:'실행 0/1건 종료 · 업무는 미완료',turnLabel:'슈퍼감독',next:'DONE 후보 수신 시 결과·마커 대조 후 독립검수 발령',summary:'구현 결과 도착 보고',reportLabel:'09. 10. 11:32',board:'b',...over});
const card=(over={})=>({key:'r/c1',id:'c1',title:'실행 카드',status:'assigned',displayState:'unconfirmed',board:'b',role:'작업자',at:'2026-09-10T02:00:00Z',runs:[],history:[],...over});
const centerWith=cards=>({cards,boards:[{name:'b',state:'needs-check',cards,runs:[]}],summary:{cards:cards.length,running:0,ready:0,attention:cards.filter(c=>['unconfirmed','orphaned','failed'].includes(c.displayState)).length,openBoards:1}});

test('현황 화면은 지금 막힌 것·진행 업무·끝난 업무를 구분해 보여준다',()=>{
 const cards=[card({runs:[{role:'작업자',sessionState:'alive',sentAt:at(1)}]}),card({key:'r/c2',id:'c2',title:'<실패 카드>',displayState:'failed',runs:[{role:'작업자',sessionState:'alive',sentAt:at(2),state:'failed',at:at(1)}]}),card({key:'r/c3',id:'c3',title:'끝난 카드',displayState:'done'})];
 const works=[work(),work({key:'work:r/w2',id:'w2',title:'끝난 업무',state:'done',stateLabel:'업무 완료'})];
 const html=renderDashboardStatus({center:centerWith(cards),works,decisions:[{id:'q1',status:'open',question:'공개?'}],now});
 assert.match(html,/st-cnt-attn">2건<\/span>/);
 assert.match(html,/시작 확인 필요/);
 assert.match(html,/실패 확인 필요/);
 assert.ok(html.includes('&lt;실패 카드&gt;'),'카드 제목은 이스케이프한다');
 assert.match(html,/st-num">3<\/span><span class="st-lbl">전체 실행 카드/);
 assert.match(html,/st-num">2<\/span><span class="st-lbl">지금 막힌 것/);assert.match(html,/st-num">0<\/span><span class="st-lbl">오래된 미정리/);
 assert.match(html,/최근 24시간에 일어난 일<\/h2><span class="st-cnt">완료 0 · 실패 1 · 발령 2/);
 assert.match(html,/DONE 후보 수신 시 결과·마커 대조 후 독립검수 발령/);
 assert.match(html,/지금 차례<\/dt><dd class="st-turn">슈퍼감독/);
 assert.match(html,/업무 기록 09. 10. 11:32/);
 assert.match(html,/<summary>끝난 업무 1장<\/summary>/);assert.ok(!html.includes('오래된 미정리 '),'미정리가 없으면 구역을 그리지 않는다');
 assert.match(html,/내 결정 대기/);
 assert.match(html,/data-view="status"/);
 assert.match(html,/id="boards"/);assert.match(html,/판별 진행 막대 1개 판/);
 assert.ok(!html.includes('430'),'다른 화면 수치를 끌어오지 않는다');
});

test('카드 기록을 읽지 못하면 수치를 꾸미지 않고 모름으로 표시한다',()=>{
 const html=renderDashboardStatus({center:null,works:null});
 assert.match(html,/카드 기록을 읽지 못해 확인 필요 수를 계산하지 않았습니다/);
 assert.match(html,/업무 기록을 읽을 수 없습니다/);
 assert.match(html,/>모름<\/span><span class="st-lbl">지금 막힌 것/);assert.match(html,/>모름<\/span><span class="st-lbl">오래된 미정리/);
 assert.ok(!html.includes('0건'));
});

test('업무 기록만 깨져도 확인 필요 목록은 그대로 보여준다',()=>{
 const cards=[card({runs:[{role:'작업자',sessionState:'alive',sentAt:at(1)}]})];
 const html=renderDashboardStatus({center:centerWith(cards),works:null,workError:'손상된 줄',now});
 assert.match(html,/업무 기록을 읽을 수 없습니다: 손상된 줄/);
 assert.match(html,/실행 카드/);
 assert.match(html,/>1건<\/span>/);
});

test('확인 필요는 세션 생존·신호 시각으로 지금 막힌 것과 오래된 미정리로 갈라지고 막대와 같은 집합을 센다',()=>{
 const alive=card({runs:[{role:'작업자',sessionState:'alive',sentAt:at(30)}]});
 const freshDead=card({key:'r/c2',id:'c2',displayState:'orphaned',runs:[{role:'작업자',sessionState:'absent',sentAt:at(3)}]});
 const oldDead=card({key:'r/c3',id:'c3',displayState:'orphaned',runs:[{role:'작업자',sessionState:'absent',sentAt:at(48)}]});
 const noSignal=card({key:'r/c4',id:'c4',status:'draft',displayState:'orphaned',role:null,runs:[]});
 const done=card({key:'r/c5',id:'c5',displayState:'done'}),cancelled=card({key:'r/c6',id:'c6',displayState:'cancelled'});
 assert.equal(executionBucket(alive,now),'stuck');assert.equal(executionBucket(freshDead,now),'stuck');assert.equal(executionBucket(oldDead,now),'stale');assert.equal(executionBucket(noSignal,now),'stale');
 assert.equal(executionBucket(done,now),'closed');assert.equal(executionBucket({...done,...executionHealth(done,now)},now),'closed');
 const counts=boardProgressCounts({cards:[alive,freshDead,oldDead,noSignal,done,cancelled,{...card({key:'r/m',id:'m'}),workType:'coordination'}]},{buckets:true,now});
 assert.equal(counts.total,6);assert.deepEqual({stuck:counts.counts.stuck,stale:counts.counts.stale,done:counts.counts.done,closed:counts.counts.closed},{stuck:2,stale:2,done:1,closed:1});
 const html=renderDashboardStatus({center:centerWith([alive,freshDead,oldDead,noSignal,done,cancelled]),works:[],now});
 assert.match(html,/st-num">2<\/span><span class="st-lbl">지금 막힌 것/);assert.match(html,/st-num">2<\/span><span class="st-lbl">오래된 미정리/);
 assert.match(html,/오래된 미정리 2장 · 24시간 이상 신호 없음 · 정리 대상/);assert.match(html,/마지막 신호 없음 · 저장 상태 draft/);assert.match(html,/\(2일 전\)/);
 assert.match(html,/지금 막힌 것 2장/);assert.match(html,/오래된 미정리 2장/);
 assert.match(html,/data-copy-label="정리 요청"/);
 const request=staleCleanupRequest([{...oldDead,...executionHealth(oldDead,now),revision:4}],now);
 assert.match(request,/오래된 미정리 실행 1장/);assert.match(request,/kadan card update r\/c3 --revision 4 --status superseded --replaced-by <저장소\/후속카드>/);assert.match(request,/--supersedes/);
});

test('최근 24시간 사건은 실행 원장의 발령·완료·실패만 최신순으로 모으고 카드 편집은 세지 않는다',()=>{
 const c=card({at:at(0.1),runs:[{role:'작업자',sentAt:at(30),state:'done',at:at(26)},{role:'작업자',sentAt:at(5),state:'done',at:at(2)},{role:'검수자',sentAt:at(1),state:'unconfirmed'},{role:'x',sentAt:'bad',at:'bad'}]});
 const events=recentExecutionEvents([c],now);
 assert.deepEqual(events.map(e=>[e.label,e.role]),[['발령','검수자'],['완료','작업자'],['발령','작업자']]);
 assert.equal(recentExecutionEvents([card({runs:[{role:'a',sentAt:new Date(now+60_000).toISOString()}]})],now).length,0,'미래 시각은 세지 않는다');
});

test('card create --supersedes는 새 카드를 만든 뒤 옛 카드를 대체됨으로 연결하고 종료된 옛 카드는 거부한다',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-supersede-'));const store=new CardStore(home);
 const old=store.create({repo:'r',id:'card-old',repoPath:home,body:'# 옛 일\n\n## 읽고 시작할 것\n- /tmp/x.md',title:'옛 일'});
 const created=cardCommand(['create','r/card-new'],{'repo-path':home,'body-file':path.join(home,'cards','r','card-old','card.md'),title:'새 일',supersedes:'r/card-old'},{home,by:'감독'});
 assert.equal(created.key,'r/card-new');assert.equal(created.superseded.status,'superseded');
 const previous=store.get('r/card-old');assert.equal(previous.status,'superseded');assert.equal(previous.replacedBy,'r/card-new');assert.match(previous.note,/후속 카드 r\/card-new 생성으로 대체/);assert.equal(previous.revision,old.revision+1);
 assert.throws(()=>cardCommand(['create','r/card-third'],{'repo-path':home,'body-file':path.join(home,'cards','r','card-old','card.md'),supersedes:'r/card-old'},{home,by:'감독'}),/이미 종료 상태/);
 assert.ok(!fs.existsSync(path.join(home,'cards','r','card-third')),'옛 카드 검사에 실패하면 새 카드를 만들지 않는다');
 assert.throws(()=>cardCommand(['create','r/card-x'],{'repo-path':home,'body-file':path.join(home,'cards','r','card-old','card.md'),supersedes:'nokey'},{home,by:'감독'}),/저장소\/옛카드/);
});
