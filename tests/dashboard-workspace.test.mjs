import test from 'node:test';
import assert from 'node:assert/strict';
import {Script,runInNewContext} from 'node:vm';
import {renderCenterWall} from '../src/center-wall.mjs';
import {buildHumanBrief,stateText} from '../src/human-brief.mjs';
import {renderCardDocument,documentLink} from '../src/card-content.mjs';
import {workspaceModel,filterWorkspaceRows,sortWorkspaceRows,renderWorkspaceDetail,workspaceRowsHtml,renderDashboardWorkspace,workspaceColumnSets,workspaceStateLabel,workspacePresetCounts} from '../src/dashboard-workspace.mjs';
import {dashboardWorkspaceScript} from '../src/dashboard-workspace-client.mjs';

const at='2020-09-08T01:00:00Z',sent='2020-09-08T00:00:00Z';
const card=(patch={})=>({key:'repo/card-a',repo:'repo',id:'card-a',title:'제품 조건 확인',body:'# 작업\n\n본문',status:'assigned',displayState:'unconfirmed',role:'작업자',board:'판-a',revision:2,at,scope:'로컬 확인',runs:[{role:'작업자',state:'unconfirmed',sessionState:'alive',sentAt:sent,at:sent}],history:[],path:'/central/repo/card-a/card.md',sourcePath:'/repo/docs/task.md',repoPath:'/repo',...patch});
const center=cards=>({cards,roles:[],boards:[],unregistered:[],runtimeKnown:true});
const render=(cards,query='',other={})=>renderCenterWall({center:center(cards),collectedAt:at,entries:[],ledgerLines:0,...other},{token:'fixture-token',url:new URL('http://localhost/'+query)});
const readData=html=>JSON.parse(html.match(/<script type="application\/json" id="dw-data">([\s\S]*?)<\/script>/)[1]);

test('보고는 Halley 현재 보고 값만 사용하고 없음과 미확인을 구분한다',()=>{
 const c=card({at:'2020-09-09T00:00:00Z',history:[{at,by:'작업자',noteKind:'progress',note:'현재 보고'}]});
 let model=workspaceModel(center([c]),buildHumanBrief(center([c])))[0];assert.equal(model.reportAt,at);assert.notEqual(model.reportAt,c.at);
 const resent=card({runs:[{role:'작업자',sentAt:'2020-09-08T02:00:00Z'}],history:c.history});
 model=workspaceModel(center([resent]),buildHumanBrief(center([resent])))[0];assert.equal(model.reportAt,null);assert.equal(model.reportLabel,'보고 없음');
 const broken=card({history:[{at:'bad',by:'작업자',noteKind:'progress',note:'알 수 없음'}]});
 model=workspaceModel(center([broken]),buildHumanBrief(center([broken])))[0];assert.equal(model.reportState,'unknown');assert.match(model.reportLabel,/확인 불가/);
});
test('403장 목록 모델에 원본 본문과 이력을 일괄 복사하지 않고 상세는 하나만 렌더한다',()=>{
 const cards=Array.from({length:403},(_,i)=>card({id:'card-'+i,key:'repo/card-'+i,body:'독점본문-'+i+'\n'+('긴내용'.repeat(100)),history:[{at,by:'작업자',noteKind:'progress',note:'독점보고-'+i}]}));
 const html=render(cards,'?card=repo%2Fcard-19&state=all');const data=readData(html);
 assert.equal(data.rows.length,403);assert.equal(data.state.layout,'table');assert.equal((html.match(/<article class="card-detail dw-reader"/g)||[]).length,1);
 assert.ok(html.includes('독점본문-19'));assert.ok(!html.includes('독점본문-402'));assert.ok(!JSON.stringify(data).includes('독점보고-'));
 assert.ok(data.rows.every(c=>!('body'in c)&&!('history'in c)));assert.equal((html.match(/<tbody id="dw-table-body">([\s\S]*?)<\/tbody>/)[1].match(/<tr data-card-row=/g)||[]).length,403);
});
test('센터 오류는 모름이며 기존 운영 메뉴와 폼 토큰·revision을 보존한다',()=>{
 const c=card();const html=render([c],'?card=repo%2Fcard-a&refresh=0');
 for(const id of ['sessions','mailbox','ledger','runs','create','decisions','status'])assert.ok(html.includes('data-view="'+id+'"'));
 // 관제 요약·판 현황은 현황의 접힘 구역이 됐다(2026-09-12). 별도 화면과 운영 메뉴 항목은 없고 옛 주소 앵커만 남는다.
 for(const id of ['boards','overview'])assert.ok(!html.includes('data-view="'+id+'"'));assert.ok(!html.includes('data-route="overview"'));assert.ok(!html.includes('data-route="boards"'));
 for(const action of ['/cards/create','/cards/update'])assert.ok(html.includes('action="'+action+'"'));
 assert.match(html,/name="token" value="fixture-token"/);assert.match(html,/name="revision" value="2"/);
 for(const other of [{center:null},{centerError:'조회 실패'}]){const bad=render([c],'',other);assert.match(bad,/id="dw-count" role="status">모름/);assert.equal(readData(bad).rows,null);}
 assert.ok(!html.includes('class="sidebar"'));assert.ok(!html.includes('시안 상태'));assert.ok(!html.includes('/api/cards'));
});
test('판·상태·ID 검색과 정렬은 전체 목록에서 작동하고 없는 보고는 양방향 모두 끝이다',()=>{
 const items=workspaceModel(center([card(),card({key:'other/card-b',id:'card-b',title:'다른 작업',board:'판-b',status:'hold',displayState:'hold'})]));
 assert.equal(filterWorkspaceRows(items,{state:'all',q:'OTHER/CARD-B'})[0].id,'card-b');
 assert.equal(filterWorkspaceRows(items,{state:'hold',board:'판-b'}).length,1);assert.equal(filterWorkspaceRows(items,{state:'hold',board:'판-a'}).length,0);
 const data=[{key:'a',reportAt:null},{key:'b',reportAt:'2020-01-01'},{key:'c',reportAt:'2021-01-01'}];
 for(const direction of ['asc','desc'])assert.equal(sortWorkspaceRows(data,'reportAt',direction).at(-1).key,'a');
});
test('마크다운은 제목·목록·표·코드를 표시하고 HTML·위험 링크·이미지 실행은 허용하지 않는다',()=>{
 const html=renderCardDocument('# 제목\n\n- **내용**\n- `코드`\n\n| 항목 | 값 |\n| --- | --- |\n| A | <img onerror=x> |\n\n```html\n<script>alert(1)</script>\n```\n\n[외부](https://example.com/doc) [악성](javascript:alert) ![사진](https://example.com/image.png)');
 assert.match(html,/<h2>제목<\/h2>/);assert.match(html,/<ul>/);assert.match(html,/<table>/);assert.match(html,/<strong>내용<\/strong>/);
 assert.ok(!html.includes('<img '));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('href="javascript:'));assert.match(html,/rel="noopener noreferrer"/);
 for(const bad of ['data:text/html,evil','//evil.test/x','https://user:pass@evil.test','https://bad\\evil.test'])assert.ok(!documentLink('링크',bad).includes('<a '));
});
test('상대 문서 주소는 원본 위치 기준 텍스트로 남기며 새 파일 URL로 바꾸지 않는다',()=>{
 const html=renderCardDocument('[결과](../results/review.md)',card());
 assert.match(html,/원본 기준: \/repo\/results\/review.md/);assert.match(html,/<code>\.\.\/results\/review.md<\/code>/);assert.ok(!html.includes('href='));
});
test('JSON 내 닫는 script와 카드 제목 HTML은 실행 가능한 마크업으로 나가지 않는다',()=>{
 const html=render([card({title:'</script><img src=x onerror=evil>',scope:'</script>'})]);
 assert.ok(!html.includes('<img src=x'));assert.equal(readData(html).rows[0].title,'</script><img src=x onerror=evil>');
 new Script(dashboardWorkspaceScript);
});
test('결과 탭은 재발령 전 보고를 현재 결과로 쓰지 않고 명시된 검수만 연결한다',()=>{
 const c=card({rallyId:'g',rallyRound:'1',rallyStep:'implementation',history:[{at,by:'작업자',noteKind:'progress',note:'과거 보고 표시 금지'}],runs:[{role:'작업자',sentAt:'2020-09-08T02:00:00Z',state:'unconfirmed'}]});
 const same=card({key:'repo/review',rallyId:'g',rallyRound:'1',rallyStep:'review',title:'연결된 검수'}),different=card({key:'repo/other',board:'다른판',rallyId:'g',rallyRound:'1',rallyStep:'review',title:'연결하면 안 됨'});
 const html=renderWorkspaceDetail(c,{center:center([c,same,different])});
 const evidence=html.match(/id="dw-panel-evidence"[\s\S]*?<\/section>/)[0];
 assert.ok(!evidence.includes('과거 보고 표시 금지'));assert.ok(evidence.includes('연결된 검수'));assert.ok(!evidence.includes('연결하면 안 됨'));
});
test('기록 탭은 변경 이유를 한 번 표시하고 실행 사건을 같은 이력에 넣는다',()=>{
 const c=card({history:[{at:sent,status:'draft',note:'초안 생성'},{at,status:'assigned',by:'감독',noteKind:'decision',note:'고유 변경 이유'}]});
 const html=renderWorkspaceDetail(c,{center:center([c])}).match(/id="dw-panel-history"[\s\S]*?<\/section>/)[0];
 assert.equal((html.match(/class="dd-history-note">고유 변경 이유</g)||[]).length,1);assert.match(html,/초안 → 배정됨/);assert.match(html,/지시 전달/);
});

function browserHarness({conflict=false,deferred=false,filterCards=null}={}) {
 const cards=filterCards||['a','b','c'].map(id=>card({key:'repo/card-'+id,id:'card-'+id}));
 const initial=readData(render(cards,'?card=repo%2Fcard-a&layout=table&state=all&refresh=0'));
 const nodes=new Map(),events=new Map(),windowEvents=new Map(),requests=[];let posts=0,reloads=0,intervals=0,renderedArticle=null,focused='';
 const make=key=>{if(!nodes.has(key))nodes.set(key,{textContent:'',innerHTML:'',hidden:false,value:'',scrollTop:0,scrollLeft:0,dataset:{},classList:{toggle(){}},getClientRects(){return this.hidden?[]:[{}]},setAttribute(){},focus(){focused=key;},matches(){return false},querySelectorAll(){return []},addEventListener(type,fn){events.set(key+':'+type,fn);}});return nodes.get(key);};
 const options=['running','waiting','unconfirmed','orphaned','failed','hold','draft','ready','assigned','done','cancelled','superseded','archived'].map(value=>({value,checked:true}));
 make('#dw-data').textContent=JSON.stringify(initial);
 const location=Object.assign(new URL('http://localhost/?card=repo%2Fcard-a&layout=table&state=all&refresh=0#detail'),{reload(){reloads++}});
 const views=['dashboard','decisions','status','ledger'].map(view=>Object.assign(make('#view-'+view),{dataset:{view}}));
 const history={state:null,replaceState(data,title,url){this.state=data;if(url)location.href=String(url)},pushState(data,title,url){this.state=data;if(url)location.href=String(url)}};
 const makeForm=(key,revision)=>({action:'http://localhost/cards/update',fields:{token:'fixture-token',key,revision:String(revision),note:'보존할 작성 내용'},matches:s=>s==='form[method="post"]',controls:[{disabled:false}],querySelectorAll(){return this.controls;}});
 const form=makeForm('repo/card-a',2);
 let currentArticle={dataset:{key:'repo/card-a',revision:'2'}},currentForm=form,detailHTML='';
 const detail=make('#dw-detail-content');
 Object.defineProperty(detail,'innerHTML',{get:()=>detailHTML,set(value){detailHTML=value;currentArticle=null;currentForm=null;}});
 detail.replaceChildren=article=>{renderedArticle=currentArticle=article;currentForm=makeForm(article.dataset.key,article.dataset.revision);detailHTML='';};
 const response=(key='repo/card-a',revision=3,title='저장한 제목')=>({ok:true,status:200,text:async()=>JSON.stringify({key,revision,title})});
 const context={URL,URLSearchParams,AbortController,structuredClone,Date,Promise,FormData:class extends Map {constructor(f){super(Object.entries(f.fields))}},
  document:{hidden:false,activeElement:null,querySelector:s=>s==='article#detail'?currentArticle:s==='details[open]'||s==='.dw-management[open]'||s==='#dw-card-heading'&&!currentArticle?null:make(s),querySelectorAll:s=>s==='[data-view]'?views:s==='[data-state-option]'?options:[],addEventListener:(type,fn)=>events.set(type,fn),importNode:x=>x},
  window:{getSelection:()=>null,addEventListener:(type,fn)=>windowEvents.set(type,fn)},matchMedia:()=>({matches:false}),requestAnimationFrame:fn=>fn(),setInterval:()=>intervals++,confirm:()=>true,location,history,
  fetch:async(url,opts)=>{if(opts.method==='POST')posts++;if(deferred)return new Promise((resolve,reject)=>requests.push({url:String(url),...opts,resolve,reject}));return conflict?{ok:false,status:409,text:async()=>'카드가 변경됨: 새로 읽고 다시 저장'}:response();},
  DOMParser:class{parseFromString(html){const {key,revision,title}=JSON.parse(html);return {querySelector:s=>s==='article#detail'?{dataset:{key,revision:String(revision)}}:s==='#dw-data'?{textContent:JSON.stringify({rows:[{...initial.rows.find(c=>c.key===key),revision,title}]})}:null};}}
 };
 runInNewContext(dashboardWorkspaceScript,context);
 const snapshot=()=>({posts,reloads,intervals,renderedArticle,currentKey:currentArticle?.dataset.key,status:make('#dw-detail-status').textContent,body:make('#dw-table-body').innerHTML,url:location.href,note:currentForm?.fields.note,detailHTML,focused,visible:views.filter(el=>!el.hidden).map(el=>el.dataset.view),title:make('#page-title').textContent});
 const flush=()=>new Promise(resolve=>setImmediate(resolve));
 return {
  preset(value){const button={dataset:{statePreset:value},classList:{contains:()=>false},hasAttribute:name=>name==='data-state-preset'};events.get('click')({target:{closest:s=>s==='button'?button:null},button:0});return snapshot();},
  selectStates(values){options.forEach(el=>{el.checked=values.includes(el.value);});events.get('#dw-state:change')({target:{matches:()=>true}});return snapshot();},
  restoreUrl(url){location.href=url;return windowEvents.get('popstate')();},
  options,
  clickLink(href,cardKey){
   let prevented=false;
   const link={href:new URL(href,location.href).href,getAttribute:name=>name==='href'?href:name==='data-card-key'?cardKey:null};
   events.get('click')({target:{closest:s=>s==='a'?link:null},button:0,preventDefault(){prevented=true}});
   if(!prevented){location.href=link.href;windowEvents.get('hashchange')();}
   return {prevented,...snapshot()};
  },
  navigate(key,top=0){location.search='?card='+encodeURIComponent(key)+'&layout=table&state=all&refresh=0';location.hash='detail';history.state={scroll:{table:{top,left:0},split:{top:0,left:0}},detailTop:top};return windowEvents.get('popstate')();},
  input(note){if(!currentForm||currentForm.controls.some(c=>c.disabled))return false;currentForm.fields.note=note;events.get('input')({target:{closest:()=>currentForm}});return true;},
  async submit(target=currentForm||form){let prevented=false;await events.get('submit')({target,preventDefault(){prevented=true}});return {prevented,...snapshot()};},
  async respond(index,key,revision=2){requests[index].resolve(response(key,revision));await flush();},
  async reject(index){requests[index].reject(new Error('늦은 조회 실패'));await flush();},
  requests,snapshot,flush,nodes,form
 };
}
for(const [view,title,shown] of [['decisions','내 결정'],['overview','현황','status'],['boards','현황','status'],['ledger','기록']])test('선택한 카드 URL에서도 #'+view+' 메뉴로 이동한다',()=>{
 const result=browserHarness().clickLink('#'+view);
 assert.equal(result.prevented,false);assert.deepEqual(result.visible,[shown||view]);assert.equal(result.title,title);
 const url=new URL(result.url);assert.equal(url.hash,'#'+view);assert.equal(url.searchParams.get('card'),'repo/card-a');
});
test('명시적인 카드 링크는 상세 선택 처리를 유지한다',()=>{
 const result=browserHarness().clickLink('?card=repo%2Fcard-a#detail');
 assert.equal(result.prevented,true);assert.deepEqual(result.visible,['dashboard']);
 const url=new URL(result.url);assert.equal(url.hash,'#detail');assert.equal(url.searchParams.get('layout'),'table');assert.equal(url.searchParams.get('state'),'all');
});
test('409 저장 실패는 폼과 작성 내용을 보존하고 문서 이동이나 자동 재시도를 하지 않는다',async()=>{
 const result=await browserHarness({conflict:true}).submit();assert.equal(result.prevented,true);assert.equal(result.posts,1);assert.equal(result.reloads,0);assert.equal(result.renderedArticle,null);assert.equal(result.note,'보존할 작성 내용');assert.match(result.status,/카드가 변경됨/);assert.equal(result.intervals,0);
});
test('저장 성공은 현재 URL을 유지하면서 새 revision 상세와 해당 목록 행을 반영한다',async()=>{
 const result=await browserHarness().submit();assert.equal(result.posts,1);assert.equal(result.renderedArticle.dataset.revision,'3');assert.match(result.body,/저장한 제목/);assert.match(result.url,/layout=table&state=all&refresh=0/);assert.equal(result.reloads,0);assert.match(result.status,/저장했습니다/);
});

test('표는 제목 원문과 전체 시각을 보존하면서 짧은 상태·시각을 보여준다',()=>{
 const c=card({displayState:'waiting',title:'card-a — 전체 원본 제목',history:[{at,by:'작업자',noteKind:'progress',note:'보고'}]});
 const html=render([c],'?state=all');
 const table=html.match(/<tbody id="dw-table-body">([\s\S]*?)<\/tbody>/)[1];
 assert.match(table,/title="card-a — 전체 원본 제목"/);assert.match(table,/결과 대기/);assert.match(table,/09\.08 10:00/);assert.match(table,/title="2020\. 9\. 8\. 10(?:시 0분 0초|:00:00)"/);
});
test('내 결정 뱃지는 별도 경로로 보존하고 결정 조회 실패는 모름이다',()=>{
 const html=render([card()],'',{decisionError:'결정 읽기 실패'});
 assert.match(html,/class="dw-decision-count"[^>]*>모름/);
 const live=render([card()],'',{decisions:[{id:'d1',status:'open',question:'범위?',recommendation:'확인',options:[],revision:1}]});
 assert.match(live,/aria-label="열린 사용자 결정 1건"/);assert.match(live,/action="\/decisions\/answer"/);assert.match(live,/name="revision" value="1"/);
});

test('다른 카드를 읽는 동안 이전 폼은 사라지고 이전 카드 저장 요청도 차단한다',async()=>{
 const h=browserHarness({deferred:true});h.clickLink('?card=repo%2Fcard-b#detail');
 assert.equal(h.snapshot().currentKey,undefined);assert.match(h.snapshot().detailHTML,/읽는 중/);assert.equal(h.input('유실되면 안 되는 입력'),false);
 const submit=h.submit(h.form);assert.equal(h.snapshot().posts,0);await submit;
 await h.respond(0,'repo/card-b');assert.equal(h.snapshot().currentKey,'repo/card-b');assert.equal(new URL(h.snapshot().url).searchParams.get('card'),'repo/card-b');
});
for(const outcome of ['success','failure'])test('B 조회 뒤 A로 돌아오면 늦은 B '+outcome+' 응답이 A 입력을 덮지 않는다',async()=>{
 const h=browserHarness({deferred:true});h.clickLink('?card=repo%2Fcard-b#detail');h.clickLink('?card=repo%2Fcard-a#detail');
 assert.equal(h.requests[0].signal.aborted,true);
 if(h.requests[1])await h.respond(1,'repo/card-a');
 assert.equal(h.input('A에서 새로 쓴 내용'),true);
 if(outcome==='success')await h.respond(0,'repo/card-b');else await h.reject(0);
 assert.equal(h.snapshot().currentKey,'repo/card-a');assert.equal(h.snapshot().note,'A에서 새로 쓴 내용');assert.doesNotMatch(h.snapshot().status,/조회 실패/);
});
test('현재 카드의 조회 실패는 모름과 재조회 버튼으로 표시한다',async()=>{
 const h=browserHarness({deferred:true});h.clickLink('?card=repo%2Fcard-b#detail');await h.reject(0);
 assert.equal(h.snapshot().currentKey,undefined);assert.match(h.snapshot().detailHTML,/상세 상태 모름/);assert.match(h.snapshot().detailHTML,/data-detail-retry/);
});
test('연속 뒤로가기는 최신 URL 카드와 스크롤만 복원하고 늦은 이전 복원을 무시한다',async()=>{
 const h=browserHarness({deferred:true});const first=h.navigate('repo/card-b',210),latest=h.navigate('repo/card-c',760);
 assert.equal(h.requests.length,2);assert.equal(h.requests[0].signal.aborted,true);
 await h.respond(1,'repo/card-c');await latest;
 assert.equal(h.snapshot().currentKey,'repo/card-c');assert.equal(h.nodes.get('#dw-scroll').scrollTop,760);assert.equal(h.nodes.get('#dw-detail').scrollTop,760);
 h.nodes.get('#dw-scroll').scrollTop=800;h.nodes.get('#dw-detail').scrollTop=900;
 await h.respond(0,'repo/card-b');await first;
 assert.equal(h.snapshot().currentKey,'repo/card-c');assert.equal(new URL(h.snapshot().url).searchParams.get('card'),'repo/card-c');assert.equal(h.nodes.get('#dw-scroll').scrollTop,800);assert.equal(h.nodes.get('#dw-detail').scrollTop,900);
});
test('저장 중 카드 선택과 뒤로가기는 저장 중인 카드와 URL을 유지한다',async()=>{
 const h=browserHarness({deferred:true});h.input('A 저장 내용');const saved=h.submit();
 assert.equal(h.input('저장 중 추가 입력'),false);assert.equal(h.snapshot().posts,1);
 h.clickLink('?card=repo%2Fcard-b#detail');await h.navigate('repo/card-b',200);
 assert.equal(h.requests.length,1);assert.equal(new URL(h.snapshot().url).searchParams.get('card'),'repo/card-a');assert.equal(h.snapshot().currentKey,'repo/card-a');
 await h.respond(0,'repo/card-a',3);await saved;
 assert.equal(h.snapshot().renderedArticle.dataset.revision,'3');assert.equal(new URL(h.snapshot().url).searchParams.get('card'),'repo/card-a');
});
test('카드 query를 포함한 원장 페이지 링크는 기본 페이지 이동을 유지한다',()=>{
 const result=browserHarness().clickLink('?card=repo%2Fcard-a&logPage=2#ledger');
 assert.equal(result.prevented,false);assert.deepEqual(result.visible,['ledger']);assert.equal(new URL(result.url).searchParams.get('logPage'),'2');
 const explicit=browserHarness().clickLink('?card=repo%2Fcard-a','repo/card-a');assert.equal(explicit.prevented,true);
});
test('요약에서 대체된 후속 카드의 명시적 링크를 제공한다',()=>{
 const html=renderWorkspaceDetail(card({replacedBy:'repo/card-next'})).match(/id="dw-panel-summary"[\s\S]*?<\/section>/)[0];
 assert.match(html,/후속 카드/);assert.match(html,/data-card-key="repo\/card-next"/);assert.match(html,/href="\?card=repo%2Fcard-next#detail"/);
});
test('현재 세션은 현재 담당과 현재 조회로만 표시하고 과거 담당 실행과 합치지 않는다',()=>{
 const c=card({role:'새 담당',runs:[{role:'옛 담당',sessionState:'alive'}]});
 const session=ctx=>renderWorkspaceDetail(c,{center:ctx}).match(/<dt>세션 상태<\/dt><dd>(.*?)<\/dd>/)[1];
 assert.equal(session({roles:[{role:'옛 담당',life:{state:'alive',pidState:'match'}}],runtimeKnown:true}),'세션 없음');
 assert.equal(session({roles:[{role:'새 담당',life:{state:'alive',pidState:'match'}}],runtimeKnown:true}),'열림');
 assert.equal(session({roles:[{role:'새 담당',life:{state:'alive',pidState:'changed'}}],runtimeKnown:true}),'PID 변경 · 확인 필요');
 assert.equal(session({roles:[],runtimeKnown:false}),'모름');assert.equal(session(undefined),'모름');
});
test('기록 탭에서 revision별 활동 변경과 이유는 단일 이력에 한 번만 표시한다',()=>{
 const first={revision:1,at:sent,status:'assigned',noteKind:'decision',note:'배정'};
 const started={revision:2,at,status:'assigned',noteKind:'progress',activity:'running',activityAt:at,note:'고유 착수 보고'};
 const waiting={...started,revision:3,at:'2020-09-08T02:00:00Z',activity:'waiting',activityAt:'2020-09-08T02:00:00Z',note:'고유 대기 보고'};
 const memo={...waiting,revision:4,at:'2020-09-08T03:00:00Z',noteKind:'question',note:'고유 질문'};
 const html=renderWorkspaceDetail(card({history:[first,started,waiting,memo]})).match(/id="dw-panel-history"[\s\S]*?<\/section>/)[0];
 assert.match(html,/작업 중 → 결과 대기/);
 for(const note of ['고유 착수 보고','고유 대기 보고','고유 질문'])assert.equal(html.split('class="dd-history-note">'+note+'<').length-1,1);
 assert.equal(html.split('작업 중 → 결과 대기').length-1,1);
});
test('기록 탭의 네 기록 종류를 한국어로 표시한다',()=>{
 const history=['decision','question','answer','progress'].map((noteKind,i)=>({revision:i+1,at,status:'assigned',noteKind}));
 const html=renderWorkspaceDetail(card({history,runs:[]})).match(/id="dw-panel-history"[\s\S]*?<\/section>/)[0];
 assert.deepEqual([...html.matchAll(/<strong>(.*?)<\/strong>/g)].map(m=>m[1]),['내부 판단','질문','내부 답변','진행 보고']);
});
test('실행 이력은 발령자와 담당을 나누며 완료·실패 기록자를 추측하지 않는다',()=>{
 const c=card({runs:['done','failed'].map(state=>({role:'실행 담당',by:'발령 감독',sentAt:sent,at,state,result:state==='done'?'ok':'failed'}))});
 const html=renderWorkspaceDetail(c).match(/id="dw-panel-history"[\s\S]*?<\/section>/)[0];
 assert.match(html,/지시 전달<\/strong><\/td><td title="발령자: 발령 감독">발령 감독/);
 for(const label of ['완료','실패'])assert.match(html,new RegExp('실행 '+label+' 기록</strong></td><td title="기록자: 모름">모름'));
 assert.match(html,/담당: 실행 담당/);assert.doesNotMatch(html,/기록자: 실행 담당/);
});
test('표는 미연결 빈 문구를 비우고 확인 필요 우선 정렬과 전체 수치 라벨을 쓴다',()=>{
 const free=card({key:'repo/free',id:'free',title:'미연결 실행',displayState:'running'});
 const attn=card({key:'repo/attn',id:'attn',title:'확인 카드',displayState:'unconfirmed',at:'2020-09-07T00:00:00Z'});
 const fail=card({key:'repo/fail',id:'fail',title:'실패 카드',displayState:'failed',at:'2020-09-09T00:00:00Z'});
 const coord=card({key:'repo/coord',id:'coord',title:'조율 카드',displayState:'done',status:'done',workType:'coordination'});
 const model=workspaceModel(center([free,coord]));
 assert.equal(model.find(c=>c.key==='repo/free').flowLabel,'');
 assert.equal(model.find(c=>c.key==='repo/free').flowPhase,'');
 assert.equal(model.find(c=>c.key==='repo/coord').flowLabel,'관리·조율');
 assert.equal(model.find(c=>c.key==='repo/coord').flowPhase,'');
 const sorted=sortWorkspaceRows([...model,...workspaceModel(center([attn,fail]))],'attention');
 assert.deepEqual(sorted.map(c=>c.key),['repo/attn','repo/fail','repo/free','repo/coord']);
 const html=render([free,attn,fail,coord]);
 assert.equal(readData(html).state.sort,'attention');
 assert.match(html,/미완료 3장 · 전체 4장/);
 const table=html.match(/<tbody id="dw-table-body">([\s\S]*?)<\/tbody>/)[1];
 assert.ok(!table.includes('라운드 미기록'));assert.ok(!table.includes('연결 정보 없음'));
 assert.equal(table.match(/<tr data-card-row="([^"]+)"/)[1],'repo/attn');
 const allHtml=render([free,attn,fail,coord],'?state=all');
 assert.match(allHtml,/전체 4장/);

test('진행 중인 카드는 현재 실행 모델을 표에 보여주고 종료 카드는 빈 칸이다',()=>{
 const models={'작업자':{harness:'codex',model:'xai/grok-4.6',effort:'xhigh',at:'2020-09-08T00:30:00Z'}};
 const active=card(),done=card({key:'repo/card-b',id:'card-b',status:'done',displayState:'done'});
 const c={...center([active,done]),models};
 const [a,b]=workspaceModel(c);
 assert.equal(a.model,'grok-4.6');assert.equal(a.effort,'xhigh');assert.match(a.modelTitle,/xai\/grok-4\.6 · 강도 xhigh/);
 assert.equal(b.model,'');assert.equal(b.modelTitle,'');
 const table=workspaceRowsHtml([a,b],'table','');
 assert.match(table,/data-column="model"[^>]*><strong>grok-4\.6<\/strong><small>강도 xhigh<\/small>/);
 assert.equal(filterWorkspaceRows([a,b],{q:'grok'}).length,1);
 assert.equal(filterWorkspaceRows([a,b],{q:'모델'}).length,0);
});

test('업무 행은 책임 감독의 현재 모델을 보여준다',()=>{
 const c={...center([]),models:{'감독':{harness:'codex',model:'anthropic/claude-opus-5',effort:'xhigh',at:'2020-09-08T00:30:00Z'}}};
 const works=[{key:'work:repo/w1',workKey:'repo/w1',kind:'work',workType:'business',owner:'감독',state:'running',stateLabel:'진행 중',stored:'open',title:'업무',originalTitle:'업무',board:'판',repo:'repo',at,revision:1,executions:[]}];
 const html=renderDashboardWorkspace({center:c,briefs:null,centerError:null,url:new URL('http://localhost/'),detail:()=>'',works,workError:null,workDetail:()=>''});
 assert.match(html,/claude-opus-5/);assert.match(html,/강도 xhigh/);
});

test('상세는 진행 중 카드의 실행 도구·강도를 보여주고 종료 카드는 숨긴다',()=>{
 const models={'작업자':{harness:'codex',model:'xai/grok-4.6',effort:'xhigh',at:'2020-09-08T00:30:00Z'}};
 const active=card(),done=card({key:'repo/card-b',id:'card-b',status:'done',displayState:'done'});
 const html=renderWorkspaceDetail(active,{center:{...center([active]),models}});
 assert.match(html,/실행 도구/);assert.match(html,/grok-4\.6 · 강도 xhigh/);
 const doneHtml=renderWorkspaceDetail(done,{center:{...center([done]),models}});
 assert.doesNotMatch(doneHtml,/실행 도구/);
});
 const allTable=allHtml.match(/<tbody id="dw-table-body">([\s\S]*?)<\/tbody>/)[1];
 assert.match(allTable,/관리·조율/);
 assert.ok(!allTable.includes('라운드 미기록'));
});

test('실행 표는 카드 상태 열을 중복해 두지 않고 업무 표에서만 업무 상태를 따로 보여준다',()=>{
 const c=card({status:'hold',displayState:'hold'});
 const works=[{key:'work:repo/w1',workKey:'repo/w1',kind:'work',workType:'business',owner:'감독',state:'running',stateLabel:'진행 중',stored:'open',title:'업무',originalTitle:'업무',board:'판',repo:'repo',at,revision:1,executions:[]}];
 const view=(collection,list)=>renderDashboardWorkspace({center:center([c]),briefs:null,centerError:null,url:new URL('http://localhost/?collection='+collection+'&state=all'),detail:()=>'',works:list,workError:null,workDetail:()=>''});
 const exec=view('executions',works),work=view('work',works);
 const headers=html=>{const m=html.match(/<thead><tr>([\s\S]*?)<\/tr><\/thead>/);return m?[...m[1].matchAll(/data-column="([^"]+)"/g)].map(x=>x[1]):[];};
 assert.deepEqual(headers(exec).includes('stateLabel'),false);
 assert.ok(headers(exec).includes('healthLabel'));
 assert.ok(!readData(exec).columns.some(([key])=>key==='stateLabel'));
 assert.ok(headers(work).includes('stateLabel'));
 assert.match(work,/>업무 상태</);
 assert.deepEqual(headers(render([c],'?collection=executions&state=all')).includes('stateLabel'),false);
});
test('종료 카드는 실행 흐름 설명·중복 신호 문구·현재 차례를 표에서 반복하지 않는다',()=>{
 const cells=(html,key)=>{const m=html.match(new RegExp('<td data-column="'+key+'"[^>]*>([^]*?)</td>'));return m?m[1]:'';};
 const done=card({status:'done',displayState:'done',runs:[]});
 const table=render([done],'?state=all').match(/<tbody id="dw-table-body">([\s\S]*?)<\/tbody>/)[1];
 assert.equal(cells(table,'healthLabel'),'<span class="execution-health eh-closed" title="실행을 마친 카드입니다.">완료</span>');
 assert.equal(cells(table,'signalAt'),'<strong>신호 없음</strong>');
 assert.equal(cells(table,'turnLabel'),'');
 assert.doesNotMatch(workspaceRowsHtml([done],'split',''),/현재 차례/);
 const live=card({displayState:'running',runs:[{role:'작업자',state:'unconfirmed',sessionState:'alive',sentAt:sent,at:sent}],history:[{by:'작업자',role:'작업자',noteKind:'progress',note:'배포 확인 중',at}]});
 const liveTable=render([live],'?state=all').match(/<tbody id="dw-table-body">([\s\S]*?)<\/tbody>/)[1];
 assert.match(cells(liveTable,'healthLabel'),/작업 중/);
 assert.match(cells(liveTable,'healthLabel'),/<small>배포 확인 중<\/small>/);
 assert.match(cells(liveTable,'signalAt'),/<strong>09\.08 10:00<\/strong><small>진행 보고<\/small>/);
 assert.match(cells(liveTable,'turnLabel'),/<strong>작업자<\/strong>/);
});
test('실행 모델 열은 원장 문자열의 인용부호를 걷어내고 값이 없으면 머리글까지 지운다',()=>{
 const active=card();
 const view=models=>renderDashboardWorkspace({center:{...center([active]),...(models?{models}:{})},briefs:null,centerError:null,url:new URL('http://localhost/?state=all'),detail:()=>'',works:null,workError:null,workDetail:()=>''});
 const withModel=view({'작업자':{harness:'codex',model:"kimi/k3[1m]'",effort:'max',at:sent}});
 assert.match(withModel,/data-column="model"[^>]*><strong>k3\[1m\]<\/strong><small>강도 max<\/small>/);
 const headers=html=>{const m=html.match(/<thead><tr>([\s\S]*?)<\/tr><\/thead>/);return m?[...m[1].matchAll(/data-column="([^"]+)"/g)].map(x=>x[1]):[];};
 assert.ok(headers(withModel).includes('model'));
 assert.deepEqual(headers(view()).includes('model'),false);
});
test('작업 표 기본 열은 여섯이며 폭 합계가 1000px 안쪽이다',()=>{
 const c=card({displayState:'running',runs:[{role:'작업자',state:'unconfirmed',sessionState:'alive',sentAt:sent,at}],history:[{by:'작업자',role:'작업자',noteKind:'progress',note:'진행 중',at}]});
 const works=[{key:'work:repo/w1',workKey:'repo/w1',kind:'work',workType:'business',owner:'감독',state:'running',stateLabel:'진행 중',stored:'open',title:'업무',originalTitle:'업무',board:'판',repo:'repo',at,revision:1,executions:[]}];
 const headers=html=>{const m=html.match(/<thead><tr>([\s\S]*?)<\/tr><\/thead>/);return m?[...m[1].matchAll(/data-column="([^"]+)"/g)].map(x=>x[1]):[];};
 const view=(collection,cards,list,models)=>renderDashboardWorkspace({center:{...center(cards),...models},briefs:null,centerError:null,url:new URL('http://localhost/?collection='+collection+'&state=all'),detail:()=>'',works:list,workError:null,workDetail:()=>''});
 assert.deepEqual(headers(view('executions',[c],null,{models:{'작업자':{harness:'codex',model:'xai/grok-4.6',effort:'xhigh',at:sent}}})),['title','healthLabel','signalAt','flowLabel','turnLabel','model']);
 assert.deepEqual(headers(view('work',[],works,{models:{'감독':{harness:'codex',model:'xai/grok-4.6',effort:'xhigh',at:sent}}})),['title','stateLabel','healthLabel','flowLabel','turnLabel','model']);
 for(const [name,set] of [['실행',workspaceColumnSets.execution],['업무',workspaceColumnSets.work]]){
  const width=set.reduce((sum,column)=>sum+column[2],0);
  assert.ok(width<=1000,name+' 표 기본 폭 합계 '+width);
 }
});
test('상태 필터 요약은 고른 개수가 아니라 뜻으로 표시한다',()=>{
 const keys=Object.keys(stateText);
 assert.equal(workspaceStateLabel(''),'미완료');
 assert.equal(workspaceStateLabel('all'),'전체');
 assert.equal(workspaceStateLabel(keys.join(',')),'전체');
 assert.equal(workspaceStateLabel(keys.filter(key=>key!=='done').join(',')),'완료 제외');
 assert.equal(workspaceStateLabel(keys.filter(key=>!['done','cancelled'].includes(key)).join(',')),'완료·취소 제외');
 assert.equal(workspaceStateLabel('running'),'작업 중');
 assert.equal(workspaceStateLabel('running,waiting'),'작업 중·결과 대기');
 assert.equal(workspaceStateLabel('none'),'선택 없음');
 assert.equal(workspaceStateLabel(['draft','ready','hold','failed'].join(',')),'상태 4개');
});
test('상태 빠른 선택 칩은 뜻과 개수를 보여주고 주소의 상태 값과 같다',()=>{
 const cards=[
  card({key:'repo/running',id:'running',displayState:'running'}),
  card({key:'repo/draft',id:'draft',displayState:'draft',status:'draft'}),
  card({key:'repo/done',id:'done',displayState:'done',status:'done',runs:[]})
 ];
 const model=workspaceModel(center(cards));
 assert.deepEqual(workspacePresetCounts(model,{collection:''}),{'':2,'running,waiting':1,'draft,ready':1,'assigned,unconfirmed,orphaned,failed':0,done:1,all:3});
 const chips=html=>[...html.matchAll(/data-state-preset="([^"]*)" aria-pressed="([^"]*)" title="[^"]*"><span>([^<]*)<\/span><span class="dw-preset-count" data-preset-count="[^"]*">([0-9]+)</g)].map(m=>({value:m[1],pressed:m[2],label:m[3],count:Number(m[4])}));
 const all=chips(render(cards,'?state=all'));
 assert.deepEqual(all.map(c=>c.label),['미완료','진행 중·대기','발령 전','확인 필요','완료','전체']);
 assert.deepEqual(all.map(c=>c.count),[2,1,1,0,1,3]);
 assert.deepEqual(all.filter(c=>c.pressed==='true').map(c=>c.label),['전체']);
 assert.deepEqual(chips(render(cards,'')).filter(c=>c.pressed==='true').map(c=>c.label),['미완료']);
});
test('실행 흐름·묶음 빠른 필터는 그 값만 남기고 선택지에 개수를 보여준다',()=>{
 const rows=[{key:'a',healthLabel:'작업 중',flowTitle:'묶음 하나'},{key:'b',healthLabel:'결과 대기',flowTitle:'묶음 하나'},{key:'c',healthLabel:'작업 중',flowTitle:''}];
 assert.deepEqual(filterWorkspaceRows(rows,{health:'작업 중'}).map(c=>c.key),['a','c']);
 assert.deepEqual(filterWorkspaceRows(rows,{rally:'묶음 하나'}).map(c=>c.key),['a','b']);
 assert.deepEqual(filterWorkspaceRows(rows,{health:'작업 중',rally:'묶음 하나'}).map(c=>c.key),['a']);
 const live=card({displayState:'running',runs:[{role:'작업자',state:'unconfirmed',sessionState:'alive',sentAt:sent,at}],history:[{by:'작업자',role:'작업자',noteKind:'progress',note:'진행 중',at}]});
 const html=render([live],'?state=all&board='+encodeURIComponent('판-a'));
 assert.match(html,/id="dw-health"/);assert.match(html,/id="dw-rally"/);
 assert.match(html,/>작업 중 \(1\)<\/option>/);
 assert.match(html,/선택한 판|판-a/);
});


test('상태 다중 필터는 합집합이며 검색·판 조건과 함께 적용하고 모두 제외는 0장이다',()=>{
 const rows=[{key:'a',state:'running',title:'같은 제목',board:'a'},{key:'b',state:'waiting',title:'같은 제목',board:'a'},{key:'c',state:'done',title:'같은 제목',board:'a'},{key:'d',state:'waiting',title:'다른 제목',board:'b'}];
 assert.deepEqual(filterWorkspaceRows(rows,{state:'running,waiting',board:'a',q:'같은'}).map(c=>c.key),['a','b']);
 assert.equal(filterWorkspaceRows(rows,{state:'none'}).length,0);
 assert.equal(filterWorkspaceRows(rows,{state:'all'}).length,4);
 assert.equal(filterWorkspaceRows(rows,{}).length,3);
 assert.deepEqual(filterWorkspaceRows(rows,{state:'done'}).map(c=>c.key),['c']);
});
test('서버 렌더는 다중 상태·선택 없음 URL의 목록과 체크 표시를 복원한다',()=>{
 const cards=['running','waiting','done'].map(state=>card({key:'repo/'+state,id:state,displayState:state}));
 for(const [value,expected] of [['running,waiting',['running','waiting']],['none',[]],['done',['done']]]){
  const html=render(cards,'?state='+encodeURIComponent(value));
  const body=html.match(/<tbody id="dw-table-body">([\s\S]*?)<\/tbody>/)[1];
  assert.equal((body.match(/<tr data-card-row=/g)||[]).length,expected.length);
  assert.deepEqual([...html.matchAll(/data-state-option value="([^"]+)" checked/g)].map(m=>m[1]),expected);
  assert.equal(readData(html).state.state,value);
 }
});
test('브라우저 전체 선택·제외·미완료와 개별 선택은 URL·목록·뒤로 가기에 함께 반영된다',async()=>{
 const h=browserHarness({filterCards:['running','waiting','done'].map(state=>card({key:'repo/'+state,id:state,displayState:state}))});
 const count=()=> (h.snapshot().body.match(/<tr data-card-row=/g)||[]).length;
 h.preset('none');assert.equal(count(),0);assert.ok(h.options.every(el=>!el.checked));assert.equal(new URL(h.snapshot().url).searchParams.get('state'),'none');
 h.selectStates(['running','waiting']);assert.equal(count(),2);const multiUrl=h.snapshot().url;
 assert.equal(new URL(multiUrl).searchParams.get('state'),'running,waiting');
 h.preset('all');assert.equal(count(),3);assert.ok(h.options.every(el=>el.checked));
 await h.restoreUrl(multiUrl);assert.equal(count(),2);assert.deepEqual(h.options.filter(el=>el.checked).map(el=>el.value),['running','waiting']);
 h.preset('');assert.equal(count(),2);assert.equal(new URL(h.snapshot().url).searchParams.has('state'),false);assert.equal(h.options.find(el=>el.value==='done').checked,false);
 h.selectStates([]);assert.equal(count(),0);assert.equal(new URL(h.snapshot().url).searchParams.get('state'),'none');
});

test('09-24 브라우저로 보내는 스크립트만으로 카드 월·관계도를 모든 기준으로 그릴 수 있다(빠진 도우미 없음)', async () => {
  const vm = await import('node:vm');
  const {dashboardWorkspaceScript} = await import('../src/dashboard-workspace-client.mjs');
  // 마지막 줄(화면 스크립트 실행)을 빼고 정의만 실행한다 — 실제로 보내는 문자열 그대로다.
  const cut = dashboardWorkspaceScript.lastIndexOf('(function workspaceClient');
  assert.ok(cut > 0);
  const rows = [
    {key:'work:r/w', kind:'work', workKey:'r/w', title:'업무', flowPhase:'구현', owner:'감독'},
    {key:'r/a', id:'a', kind:'execution', title:'실행 A', parentWorkKey:'r/w', healthKind:'running', rallyStep:'implementation', owner:'작업자', turnLabel:'작업자 차례', model:'m'},
    {key:'r/b', id:'b', kind:'execution', title:'실행 B', healthKind:'mystery', owner:'검수자'},
  ];
  const context = vm.createContext({rows, Intl, Date, encodeURIComponent, Number, Map, Set, JSON});
  vm.runInContext(dashboardWorkspaceScript.slice(0, cut), context);
  const html = vm.runInContext(`[workspaceWallHtml(rows,'r/a','status'),workspaceWallHtml(rows,'r/a','step'),workspaceMapHtml(rows,'r/a','work',null,rows),workspaceMapHtml(rows,'r/a','role',{'작업자':'감독','검수자':'감독','감독':'@user'},rows)]`, context);
  assert.match(html[0], /data-wall-column="running"[\s\S]*실행 A/);
  assert.match(html[0], /data-wall-column="attention"[\s\S]*실행 B/);
  assert.match(html[1], /data-wall-column="implementation"[\s\S]*실행 A/);
  assert.match(html[2], /업무[\s\S]*실행 A/);
  assert.match(html[3], /감독[\s\S]*작업자[\s\S]*실행 A/);
});
