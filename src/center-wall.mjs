import {operationsFlowSummaries} from './operations-flow.mjs';
import {WorkStore} from './work-store.mjs';
import {renderOperationsFlow,operationsFlowStyle,operationsFlowScript} from './operations-flow-view.mjs';
import {workDashboardModel,renderWorkDetail,renderWorkCreate,workDashboardStyle} from './work-dashboard.mjs';
import {uiFoundationStyle} from './ui-foundation.mjs';
import {activityGuide,activityGuideStyle} from './activity-guide.mjs';
import {watchOverviewStyle} from './watch-overview-wall.mjs';
import {buildHumanBrief} from './human-brief.mjs';
import {renderDashboardWorkspace,renderWorkspaceDetail} from './dashboard-workspace.mjs';
import {readActiveHierarchy} from './hierarchy-register.mjs';
import {dashboardWorkspaceStyle} from './dashboard-workspace-style.mjs';
import {dashboardWorkspaceScript} from './dashboard-workspace-client.mjs';
import {dashboardStyle} from './dashboard-home.mjs';
import {renderDashboardStatus,dashboardStatusStyle} from './dashboard-status.mjs';
import {statusPaletteCss} from './board-progress.mjs';
import {decisionCommand} from './decisions.mjs';
import {renderDecisions,renderActivity} from './decision-wall.mjs';
import { randomBytes } from 'node:crypto';
import { CardStore } from './card-store.mjs';
export const htmlEscape=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const e=htmlEscape;
const labels={archived:'과거 자료·미분류',running:'작업 중',waiting:'결과 대기',draft:'초안',ready:'발령 가능',assigned:'배정',hold:'보류',done:'완료',cancelled:'취소',superseded:'대체됨',unconfirmed:'발령됨',orphaned:'세션 없음·미완료',failed:'실패',planned:'계획', 'needs-check':'확인 필요'};
const label=x=>labels[x]??x;
const stamp=x=>x?new Date(x).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}):'모름';
const pill=x=>`<span class="state ${e(x)}">${e(label(x))}</span>`;
export function renderCenterWall({center,centerError,collectedAt,error,resources,decisions=[],decisionError=null,entries=[],ledgerLines=0,home}, {token='',url=new URL('http://localhost')}={}) {
 if(centerError)center=null;
 const briefs=buildHumanBrief(center,home);
 let works=home?[]:null,workError=null;
 if(home)try{const registered=new WorkStore(home).list();works=workDashboardModel(registered,center,entries,operationsFlowSummaries(home,registered))}catch(error){works=null;workError=error.message;}
 const workDetail=w=>renderWorkDetail(w,{token,center,models:works||[],home,url});
 // 관계도에 쓰는 직속 상위. 읽기 실패는 모름(null)으로 두고 화면이 담당별 묶음으로 내려간다.
 const hierarchy=home?readActiveHierarchy(entries):null;
 const options=(values,current)=>values.map(([value,name])=>`<option value="${e(value)}"${current===value?' selected':''}>${e(name)}</option>`).join('');
 const hidden=c=>`<input type="hidden" name="token" value="${e(token)}"><input type="hidden" name="key" value="${e(c.key)}"><input type="hidden" name="revision" value="${c.revision}">`;
 const management=c=>`<form method="post" action="/cards/update" class="edit">${hidden(c)}<h3>기록 남기기</h3><label>기록 종류<select name="noteKind">${options([['decision','내부 판단'],['question','감독에게 질문'],['answer','내부 답변']], 'decision')}</select></label><label>현재 차례 변경 (바꿀 때만 입력)<input name="turnOwner" maxlength="160" placeholder="예: 제품-감독 · 검수자 · 사용자"><small>이 카드에서 다음에 행동할 사람입니다. 기록만 남기며 메시지를 보내지는 않습니다.</small></label><label>변경 이유 / 기록 내용 (상태를 바꿀 때는 이유를 적어주세요)<textarea name="note" required rows="3"></textarea></label>
 <details><summary>카드 구체화 · 상태 변경</summary><label>카드 종류<select name="workType">${options([['execution','실행 작업'],['coordination','관리·조율']],c.workType||'execution')}</select></label><label>티키타카 묶음 ID<input name="rallyId" value="${e(c.rallyId)}" placeholder="예: product-tags"></label><label>묶음 제목<input name="rallyTitle" value="${e(c.rallyTitle)}"></label><label>라운드 (조사는 0)<input name="rallyRound" type="number" min="0" max="999" value="${e(c.rallyRound)}"></label><label>연결 단계<select name="rallyStep">${options([['','미연결'],['implementation','구현'],['fix','수정'],['review','검수'],['research','관련 조사']],c.rallyStep||'')}</select></label><label>제목<input name="title" value="${e(c.title)}" required></label><label>상태<select name="status">${options(['draft','ready','assigned','hold','done','cancelled','superseded','archived'].map(s=>[s,label(s)]),c.status)}</select></label><label>대체된 후속 카드<input name="replacedBy" value="${e(c.replacedBy)}" placeholder="저장소/후속카드"></label><label>현재 상태 이유 (보완할 때 입력)<textarea name="statusReason" rows="2" placeholder="비워두면 상태 전환 때 적은 변경 이유를 사용합니다"></textarea></label><label>후속 담당<input name="resolutionOwner" value="${e(c.resolutionOwner)}" placeholder="예: 제품-감독"></label><label>다음 행동·해소 조건<textarea name="nextAction" rows="2">${e(c.nextAction)}</textarea></label><label>허용한 작업 범위<textarea name="scope" rows="3">${e(c.scope)}</textarea></label><label>판 이름<input name="board" value="${e(c.board)}"></label><label>담당 역할<input name="role" value="${e(c.role)}"></label></details><button>저장</button><p class="muted">저장은 기록만 남깁니다. 우편 발송이나 실행 재개는 하지 않습니다.</p></form>`;
 const detail=c=>{
  const parent=works?.find(w=>w.executions.some(x=>x.key===c.key));
  const html=renderWorkspaceDetail(c,{brief:briefs?.get(c.key),center,decisions,decisionError,form:management(c),collectedAt,entries,home,url});
  return parent?html.replace('<header>',`<p class="bw-parent-link">업무 ${`<a data-card-key="${e(parent.key)}" href="?card=${encodeURIComponent(parent.key)}#detail">${e(parent.title)}</a>`} · 이 화면은 업무 안의 실행입니다.</p><header>`):html;
 };
 return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>카단 · 카드와 작업</title><style>
 *{box-sizing:border-box}body{margin:0}a{color:#176849;text-underline-offset:3px}a:hover{text-decoration-thickness:2px}input,select,textarea{border:1px solid #acb7af;border-radius:5px;padding:8px;background:white;color:#202824}textarea{resize:vertical;width:100%}:focus-visible{outline:3px solid #b07712;outline-offset:3px}header.top{background:#fff;border-bottom:1px solid #d8ded8;padding:22px 32px;display:flex;gap:16px;align-items:center;justify-content:space-between}h1{margin:0;font-size:23px}h2{font-size:18px;margin:0 0 15px}h3{font-size:15px;margin:22px 0 10px}p{margin:8px 0}.muted,small,dt{color:#5e6b62}nav{display:flex;gap:18px;flex-wrap:wrap}main{max-width:1480px;margin:24px auto;padding:0 28px}.stats{display:flex;gap:25px;flex-wrap:wrap;padding:16px 0 24px}.stats strong{font-size:24px;display:block}.panel,.card-detail{background:white;border:1px solid #d8ded8;border-radius:9px;padding:22px;margin-bottom:20px}.toolbar{display:flex;gap:12px;align-items:end;flex-wrap:wrap;margin-bottom:18px}label{display:flex;flex-direction:column;gap:5px}input[name=q]{min-width:230px}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;text-align:left}th{color:#5e6b62;font-weight:500;font-size:12px;border-bottom:1px solid #bfc8c1;white-space:nowrap}th,td{padding:12px 10px;vertical-align:top}td{border-bottom:1px solid #e6eae5}td:first-child{min-width:220px}.state{display:inline-block;padding:2px 7px;border-radius:4px;background:#edf0ed;white-space:normal;overflow-wrap:anywhere;font-size:12px}.cols{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(340px,1fr);gap:22px}.cols>*{min-width:0}details{margin:12px 0}summary{cursor:pointer;color:#245c44}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:500px;overflow:auto;background:#f6f7f5;padding:16px;font-size:12px}dd{margin:0 0 9px;overflow-wrap:anywhere}.history{padding-left:22px}.history li{margin-bottom:18px}.history p{white-space:pre-wrap;overflow-wrap:anywhere}.history span{font-size:12px;color:#5e6b62}.edit{border-top:1px solid #d8ded8}.edit label{margin:10px 0}.error{background:#fff0d0;padding:18px;border:1px solid #b07712;border-radius:7px;margin-bottom:20px}.empty{padding:25px 0;color:#5e6b62}.row-title{font-weight:600;display:block}footer{color:#5e6b62;padding:12px 0 30px}@media(max-width:800px){header.top{padding:18px;display:block}nav{margin-top:12px}main{padding:0 14px;margin-top:14px}.panel,.card-detail{padding:16px}.cols{display:flex;flex-direction:column}.cols>.card-detail{order:-1}.toolbar label{flex:1;min-width:110px}.toolbar input{min-width:0;width:100%}.stats{gap:20px}.stats strong{font-size:21px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}

 [hidden]{display:none!important}.sidebar{position:fixed;inset:0 auto 0 0;width:218px;background:#fff;border-right:1px solid #d8ded8;padding:28px 18px;display:flex;flex-direction:column;z-index:5}.brand{font-size:27px;font-weight:750;text-decoration:none;color:#1b3025}.sidebar p{color:#667469;margin:0 0 30px}.sidebar nav{display:flex;flex-direction:column;gap:5px}.sidebar nav a{padding:11px 13px;border-radius:7px;color:#526359;text-decoration:none}.sidebar nav a.active{background:#e5f1e9;color:#155d42;font-weight:650}.sidebar small{margin-top:auto;padding:18px 12px;color:#6c7a70}.badge{background:#236e50;color:#fff;border-radius:10px;padding:0 6px;font-size:11px}.app-shell{margin-left:218px}.app-shell main{max-width:1440px}.board-progress{padding:22px 0;border-bottom:1px solid #e2e7e3}.board-progress:last-child{border-bottom:0}.board-heading{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:12px}.board-heading strong{font-size:16px}.board-heading>span:last-child{margin-left:auto;font-size:12px}.progress-track{height:12px;border-radius:9px;overflow:hidden;display:flex;background:#edf0ed}.progress-track span{height:100%}.progress-legend{display:flex;gap:13px;flex-wrap:wrap;color:#5e6b62;font-size:12px;margin-top:9px}.progress-legend i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px}#decisions form{display:grid;gap:12px;max-width:720px}#decisions article{padding:12px 0 24px}@media(max-width:800px){.sidebar{width:138px;padding:20px 9px}.sidebar .brand{font-size:22px}.sidebar nav a{padding:10px 8px;font-size:13px}.sidebar small{padding:8px}.app-shell{margin-left:138px}.board-heading>span:last-child{margin-left:0}.board-heading .muted{overflow-wrap:anywhere}.stats{gap:16px}.app-shell main{padding:0 10px}.panel,.card-detail{padding:12px}header.top{padding:16px 12px}h1{font-size:21px}.toolbar label{min-width:100%;}.scroll{max-width:100%}}
 .status-help{font-size:12px;margin:12px 0 0}.status-help summary{display:list-item;width:fit-content}.status-help[open]{background:#f6f8f5;border:1px solid #dce4dd;border-radius:6px;padding:12px}.status-help dl{margin:10px 0;display:grid;gap:7px}.status-help dl>div{display:grid;grid-template-columns:85px minmax(0,1fr);gap:8px}.status-help dt{font-weight:600}.status-help dd{margin:0}.status-help i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px}.status-help p{color:#5e6b62}@media(max-width:600px){.status-help dl>div{grid-template-columns:1fr;gap:2px}}
 ${activityGuideStyle}
 .record-tabs{display:flex;gap:8px;margin-bottom:20px}
 ${watchOverviewStyle}
${statusPaletteCss}
${dashboardStyle}
 ${dashboardStatusStyle}
${dashboardWorkspaceStyle}
 ${workDashboardStyle}
 ${uiFoundationStyle}
 ${operationsFlowStyle}
 </style></head><body><div class="dw-shell"><header class="dw-top"><a class="dw-brand" href="#status">카단 라이트</a><span class="dw-sr" id="page-title">현황</span><nav aria-label="주 메뉴"><a href="#status" data-route="status">현황</a><a href="#dashboard" data-route="dashboard">작업</a><a href="#decisions" data-route="decisions">내 결정 <span class="dw-decision-count" aria-label="열린 사용자 결정 ${decisionError?'모름':decisions.filter(d=>d.status==='open').length+'건'}">${decisionError?'모름':decisions.filter(d=>d.status==='open').length}</span></a><a href="#ledger" data-route="ledger">기록</a><a href="#operations-flow" data-route="operations-flow">운영 흐름</a></nav><details class="dw-more"><summary>운영 메뉴</summary><nav aria-label="운영 메뉴">${[['sessions','담당자 세션'],['mailbox','우편함'],['runs','작업별 실행'],['work-create','새 업무 만들기'],['create','별도 실행 등록']].map(([id,title])=>`<a href="#${id}" data-route="${id}">${title}</a>`).join('')}</nav></details></header><main>

 ${centerError||error?`<div class="error" role="alert">상태 모름: ${e(centerError||error)}</div>`:''}
 ${renderDashboardStatus({center,works,workError,decisions,decisionError,collectedAt,briefs,entries,ledgerLines})}
 ${renderDashboardWorkspace({center,briefs,centerError,url,detail,works,workError,workDetail,hierarchy})}
 ${renderOperationsFlow()}
 ${renderWorkCreate(token)}
 ${renderDecisions(decisions,decisionError,token)}
 <section class="panel" id="create" data-view="create"><h2>새 카드 만들기</h2><form method="post" action="/cards/create" class="edit"><input type="hidden" name="token" value="${e(token)}"><label>저장소 이름<input name="repo" required placeholder="my-repo"></label><label>저장소 절대경로<input name="repoPath" required></label><label>카드 ID<input name="id" required placeholder="card-product-search"></label><label>제목<input name="title" required></label><label>작업 내용<textarea name="body" rows="5" required></textarea></label><button>초안으로 저장</button></form></section>
 <section class="panel" id="sessions" data-view="sessions"><h2>담당자 세션</h2>${activityGuide('sessions')}${center&&!center.runtimeKnown?'<p role="alert">현재 세션 상태 모름</p>':''}<p class="muted">생존 여부와 카드 완료 여부는 별개입니다.</p><div class="scroll"><table><thead><tr><th>역할</th><th>생존</th><th>실행 도구 / 모델</th></tr></thead><tbody>${(center?.roles??[]).filter(r=>r.life.state==='alive').map(r=>`<tr><td>${e(r.role)}</td><td>${!center.runtimeKnown?'모름':r.life.pidState==='match'?'열려 있음':'PID 변경 — 확인 필요'}</td><td>${e([r.harness,r.model].filter(Boolean).join(' / ')||'모름')}</td></tr>`).join('')}</tbody></table></div></section>
 ${renderActivity({center,entries,ledgerLines,error,home},url)}
 <details class="panel" data-view="runs"><summary>중앙 카드에 연결되지 않은 실행 ${center?(center.unregistered??[]).length+'건':'모름'}</summary><p>등록 전의 과거 실행도 보존합니다. 같은 카드 ID가 여러 저장소에 있으면 자동 연결하지 않습니다.</p><div class="scroll"><table><thead><tr><th>카드 ID</th><th>역할</th><th>상태</th><th>기록 연결</th><th>판</th></tr></thead><tbody>${(center?.unregistered??[]).map(r=>`<tr><td>${e(r.taskId)}</td><td>${e(r.role)}</td><td>${pill(r.state)}</td><td title="${e(r.connectionReason||'')}">${e(r.connectionLabel||'중앙 카드 미등록')}</td><td>${e(r.board||'미분류')}</td></tr>`).join('')}</tbody></table></div></details>
 </main><footer><span>수집 ${e(stamp(collectedAt))}</span><span id="dw-refresh-status" role="status">갱신 상태 확인 중</span><button type="button" data-refresh>새로 읽기</button></footer><script>
 ${dashboardWorkspaceScript}
 ${operationsFlowScript}
 </script></div></body></html>`;
}

export function createCenterHandler(home, {notify}={}) {
 const token=randomBytes(24).toString('hex'),store=new CardStore(home),works=new WorkStore(home);
 return {token,async handle(req,res,url) {
  if(req.method!=='POST'||!['/cards/update','/cards/create','/decisions/answer',...['create','update','link','unlink','execute','mail','complete','cancel','reopen'].map(x=>'/works/'+x)].includes(url.pathname))return false;
  const fail=(status,message)=>{res.writeHead(status,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});res.end(message)};
  if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`){fail(403,'다른 사이트에서 저장할 수 없습니다');return true;}
  if(req.headers['content-type']?.split(';')[0]!=='application/x-www-form-urlencoded'){fail(415,'폼 입력만 지원합니다');return true;}
  let bytes=0;const chunks=[];
  try {
   for await(const chunk of req){bytes+=chunk.length;if(bytes>1024*1024)throw new Error('입력이 너무 큽니다');chunks.push(chunk);}
   const f=Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
   if(f.token!==token){fail(403,'화면을 새로 읽은 뒤 저장하세요');return true;}
   if(url.pathname==='/decisions/answer') {
     decisionCommand(['answer',f.id],{revision:f.revision,text:f.text,choice:f.choice},{home,by:'사람',notify});
     res.writeHead(303,{location:'/#decision-'+encodeURIComponent(f.id),'cache-control':'no-store'});res.end();return true;
   }
   if(url.pathname.startsWith('/works/')){
    const action=url.pathname.slice(7);let work;
    if(action==='create')work=works.create({...f,by:'사람'});
    else {
     if(!f.key?.startsWith('work:'))throw new Error('업무 주소 확인 필요');
     const fields={};
     for(const field of ['title','goal','scope','acceptance','owner','board','progress','nextAction','turnOwner','status','execution','phase','round','body','mail','result'])if(f[field]!==undefined)fields[field]=f[field];
     if(action==='update'&&fields.turnOwner===works.get(f.key.slice(5)).turnOwner)delete fields.turnOwner;
     work=works.change(f.key.slice(5),action,fields,{revision:f.revision,by:'사람',note:f.note});
    }
    res.writeHead(303,{location:`/?collection=work&card=${encodeURIComponent('work:'+work.key)}&detail=1#detail`,'cache-control':'no-store'});res.end();return true;
   }
   const card=url.pathname.endsWith('create')?store.create({...f,by:'사람'}):store.update(f.key,{...(f.turnOwner?.trim()?{turnOwner:f.turnOwner.trim()}:{}),...(f.replacedBy?{replacedBy:f.replacedBy}:{}),...(f.rallyId!==undefined?{rallyId:f.rallyId,rallyTitle:f.rallyTitle,rallyRound:f.rallyRound,rallyStep:f.rallyStep}:{}),title:f.title,status:f.status,scope:f.scope,...(f.statusReason?{statusReason:f.statusReason}:{}),...(f.resolutionOwner!==undefined?{resolutionOwner:f.resolutionOwner||null}:{}),...(f.nextAction!==undefined?{nextAction:f.nextAction||null}:{}),...(f.workType?{workType:f.workType}:{}),board:f.board||null,role:f.role||null},{revision:f.revision,by:'사람',noteKind:f.noteKind,note:f.note});
   res.writeHead(303,{location:`/?card=${encodeURIComponent(card.key)}#detail`,'cache-control':'no-store'});res.end();
  }catch(error){fail(409,error.message)}
  return true;
 }};
}
