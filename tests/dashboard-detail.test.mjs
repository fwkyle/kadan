import test from 'node:test';
import assert from 'node:assert/strict';
import {instructionSections,renderInstructionTable,detailEvents,renderDetailSummary} from '../src/dashboard-detail.mjs';
import {renderWorkspaceDetail} from '../src/dashboard-workspace.mjs';
import {approvedDetailGuide} from '../src/dashboard-detail-guides.mjs';
import {createHash} from 'node:crypto';

test('작업 지시를 나눠도 제목·본문·줄바꿈을 포함한 전체 원문을 복원할 수 있다',()=>{
 const bodies=['# 카드\r\n\r\n소개\r\n## Why\r\n목적\r\n## 범위\r\n1. 파일\r\n## 금지\r\n수정 금지\r\n','제목 없는 지시\n추가 내용','## 범위\n내용\n### 세부조건\n조건','# 제목만\n본문','\n  \n'];
 for(const body of bodies){const parsed=instructionSections(body);assert.equal(parsed.prefix+parsed.sections.map(s=>s.body).join(''),body);}
 const parsed=instructionSections(bodies[0]);assert.deepEqual(parsed.sections.map(s=>s.label),['작업 목적','수정 범위','금지 사항']);assert.ok(parsed.prefix.includes('소개'));
});
test('코드 블록 속 제목과 더 짧은 닫힘 표시는 항목 경계로 오인하지 않는다',()=>{
 const body='# 카드\n## 범위\n````sh\n# 셸 주석\n```\n## 코드 안의 제목\n````\n## 금지\n~~~text\n# 예시\n~~~\n끝\n';
 const parsed=instructionSections(body);assert.deepEqual(parsed.sections.map(s=>s.title),['범위','금지']);assert.equal(parsed.prefix+parsed.sections.map(s=>s.body).join(''),body);
 assert.ok(parsed.sections[0].body.includes('## 코드 안의 제목'));
});
test('알 수 없는 항목은 원래 제목으로 표시하고 빈 지시와 제목 없는 지시도 읽는다',()=>{
 assert.match(renderInstructionTable({body:'## 고유 조건\n조건 A'}),/고유 조건/);
 assert.match(renderInstructionTable({body:''}),/작업 지시가 없습니다/);
 assert.match(renderInstructionTable({body:'본문만 있는 지시'}),/전체 지시/);
 assert.equal(instructionSections('## 금지\n').sections[0].content,'');
});
test('지시의 미리보기와 펼친 원문은 외부 HTML·이미지·스크립트를 실행하지 않는다',()=>{
 const html=renderInstructionTable({body:'# 제목\n## <img onerror=x>\n<script>evil()</script>\n[위험](javascript:evil)\n![외부 이미지](https://example.com/x.png)\n## 긴 지시\n'+'단어 '.repeat(200)});
 assert.ok(!html.includes('<img'));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('href="javascript:'));assert.match(html,/&lt;script&gt;/);assert.match(html,/단어 …/);
 assert.equal((html.match(/data-dd-row=/g)||[]).length,2);
});
test('실제 카드 내용으로 항목을 만들고 다른 카드 시안의 숫자·요약을 섞지 않는다',()=>{
 const html=renderInstructionTable({body:'# 새 카드\n## 범위\n정확히 3개 파일만 수정\n## 기한\n10분'});
 assert.match(html,/3개 파일만 수정/);assert.match(html,/10분/);assert.doesNotMatch(html,/244|994|120분|Backend/);
});
test('최근 기록은 시각순이며 완료 기록자의 모름과 원문 및 상태 전환을 보존한다',()=>{
 const events=detailEvents({history:[{revision:1,at:'2020-01-01',status:'draft',note:'생성'},{revision:2,at:'2020-01-03',status:'hold',by:'감독',note:'원본\n이유'}],runs:[{sentAt:'2020-01-02',at:'2020-01-04',state:'done',role:'작업자',by:'발령자',result:'ok'}]});
 assert.deepEqual(events.map(x=>x.at),['2020-01-04','2020-01-03','2020-01-02','2020-01-01']);assert.equal(events[0].by,null);assert.equal(events[2].byLabel,'발령자');assert.equal(events[1].note,'원본\n이유');assert.match(events[1].transition,/초안 → 보류/);
});
test('완료한 카드도 없는 검수와 다음 행동을 추정하지 않는다',()=>{
 const html=renderDetailSummary({status:'done',displayState:'done',scope:'실측 1개만',history:[]},{report:{state:'unknown'}});
 assert.match(html,/실측 1개만/);assert.match(html,/보고 확인 불가/);assert.match(html,/연결된 검수 카드가 없습니다/);assert.match(html,/다음 행동 미기록/);assert.match(html,/기록자 모름/);assert.doesNotMatch(html,/검수 통과|전체 완료|21개/);
});
test('표형 기본과 문서형 버튼을 제공하면서 관리 폼은 한 번만 포함한다',()=>{
 const html=renderWorkspaceDetail({key:'r/c',id:'c',repo:'r',body:'## Why\n목적',status:'draft',displayState:'draft',history:[],runs:[]},{form:'<form method="post">보존할 폼</form>'});
 assert.match(html,/<p class="dd-jump"><a href="\?mailCard=r%2Fc#mailbox">이 카드의 우편<\/a><a href="\?ledgerCard=r%2Fc&amp;ledgerRoutine=1#ledger">이 카드의 사건<\/a><\/p>/);
 assert.match(html,/data-detail-view="table" data-key=/);assert.match(html,/data-detail-view="document" aria-pressed="false"/);assert.equal(html.split('보존할 폼').length-1,1);assert.match(html,/data-detail-section="work"/);
});
test('승인한 설명은 원문·상태·버전이 일치할 때만 재사용하고 변경되면 원문으로 돌아간다',()=>{
 const hash=value=>createHash('sha256').update(value).digest('hex');
 const card={key:'r/c',body:'원본 지시',revision:4,status:'done',displayState:'done',statusReason:'1개만 완료'};
 const source={'r/c':{bodyHash:hash(card.body),reasonHash:hash(card.statusReason),revision:4,status:'done',displayState:'done',work:{범위:['범위','지시 요약']},summary:{headline:'1개 완료'}}};
 assert.equal(approvedDetailGuide(card,source).summary.headline,'1개 완료');
 for(const patch of [{revision:5},{status:'hold'},{displayState:'failed'},{statusReason:'변경된 이유'}]){const found=approvedDetailGuide({...card,...patch},source);assert.equal(found.summary,null);assert.ok(found.work);}
 assert.equal(approvedDetailGuide({...card,body:'새 원문'},source),null);assert.equal(approvedDetailGuide({...card,key:'other/c'},source),null);
});
