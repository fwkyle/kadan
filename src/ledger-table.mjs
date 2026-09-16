import {escapeHtml as e} from './card-content.mjs';
import {readTaskLedger,readMailLedger,readSystemLedger,classifyLedgerEntry} from './ledger.mjs';
import {projectLedger} from './ledger-domains.mjs';
import {watchAILabel} from './watch-report.mjs';

export const ledgerViews=[['all','전체 · 호환 조회'],['tasks','작업원장'],['mail','우편원장'],['system','시스템원장']];
export function ledgerView(entries,home,domain='all'){
 if(!['tasks','mail','system'].includes(domain))return entries;
 if(home)return {tasks:readTaskLedger,mail:readMailLedger,system:readSystemLedger}[domain](home);
 // 저장소 없는 렌더 fixture도 코어의 과거 호환 분류 규칙을 재사용한다.
 return projectLedger({legacy:entries,ordered:[]},domain);
}
const kinds={dispatch:'작업 발령','mail-cancel':'질문 취소',start:'세션 시작',send:'메시지 전달',done:'실행 결과',stop:'세션 종료',plan:'카드 계획',alert:'감시 알림',handover:'담당 인계','mail-read':'우편 확인','hierarchy-loaded':'책임 관계 읽음','progress-judgment':'진행 판단','watch-scope':'감시 대상 설정'};
const text=value=>typeof value==='string'?value:'';
function eventLabel(entry){
 if(entry.completion)return '실행 결과 통지';
 if(entry.kind==='send'&&classifyLedgerEntry(entry).dispatch)return classifyLedgerEntry(entry).dispatch==='legacy'?'작업 지시 · 과거 겸용':'작업 지시 · 우편 연결';
 if(entry.kind==='done')return entry.result==='ok'?'실행 완료':entry.result==='failed'?'실행 실패':'실행 결과';
 if(entry.kind?.startsWith('watch-ai-'))return watchAILabel(entry.source);
 return kinds[entry.kind]||text(entry.kind)||'종류 모름';
}
function eventSummary(entry){
 const parts=[text(entry.completion?entry.executionKey||entry.completionTaskId:entry.taskId)];
 if(entry.kind?.startsWith('watch-ai-')){
  const step={'watch-ai-request':'호출 시작','watch-ai-report':'판정 기록','watch-ai-delivery':'보고 전달','watch-ai-call':'호출 종료','watch-ai-retired':'감시 제외'}[entry.kind]||entry.kind;
  const reason={reported:'보고 완료',timeout:'시간 초과',cancelled:'호출 취소','call-failed':'호출 실패','report-missing':'보고 누락','report-incomplete':'전달 기록 미완료','report-error':'보고 경로 오류'}[entry.reason]||entry.reason;
  return [step,entry.verdict,reason,entry.delivery,entry.taskId].filter(Boolean).join(' · ');
 }
 if(entry.preview)parts.push(text(entry.preview));
 else if(entry.kind==='alert')parts.push([entry.alertKind,entry.level,entry.resolved===true?'해소 기록':'',entry.recipient?'알림 대상 '+entry.recipient:''].filter(Boolean).join(' · '));
 else if(entry.kind==='handover')parts.push([entry.from&&entry.to?`${entry.from} → ${entry.to}`:'',entry.phase].filter(Boolean).join(' · '));
 else parts.push(text(entry.note)||text(entry.reason)||text(entry.result)||[entry.harness,entry.model].filter(Boolean).join(' · '));
 return parts.filter(Boolean).join(' · ')||'상세 내용은 원문에서 확인';
}
function stamp(value,short=false){
 if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))return '시각 모름';
 if(!short)return new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false});
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)).map(p=>[p.type,p.value]));
 return `${parts.month}.${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
export function renderLedgerTable(entries){
 return `<div class="lg-scroll" id="lg-scroll" tabindex="0" aria-label="사건 기록 표 · 좌우로 스크롤 가능"><table class="lg-table"><caption class="dw-sr">사건별 시각, 종류, 기록하거나 보낸 사람, 대상과 원문</caption><colgroup><col><col><col><col><col><col></colgroup><thead><tr><th scope="col">시각</th><th scope="col">사건</th><th scope="col">기록자·보낸 사람</th><th scope="col">대상</th><th scope="col">카드·내용</th><th scope="col">원문</th></tr></thead><tbody>${entries.map((entry,i)=>{
  const id='lg-original-'+i,label=eventLabel(entry),by=text(entry.by)||'모름',target=text(entry.role)||text(entry.to)||text(entry.board)||'모름',summary=eventSummary(entry);
  return `<tr data-ledger-row="${id}"><td title="${e(stamp(entry.t))}">${e(stamp(entry.t,true))}</td><td title="${e(entry.kind)}">${e(label)}</td><td title="${e(by)}">${e(by)}</td><td title="${e(target)}">${e(target)}</td><td title="${e(summary)}">${e(summary)}</td><td><button type="button" data-ledger-toggle aria-expanded="false" aria-controls="${id}" aria-label="${e(stamp(entry.t,true)+' '+label+' 원문')}" title="기록 원문 펼치기">펼치기</button></td></tr><tr class="lg-original-row" id="${id}" hidden><td colspan="6"><div class="lg-original"><div class="lg-original-heading"><strong>${e(label)} · 기록 원문</strong><button type="button" data-ledger-close="${id}">접기</button></div><pre>${e(JSON.stringify(entry,null,2))}</pre></div></td></tr>`;
 }).join('')||'<tr><td colspan="6" class="lg-empty">아직 기록된 사건이 없습니다.</td></tr>'}</tbody></table></div>`;
}

// 카드 상세의 펼침 상태와 독립적으로 사건 원문을 읽는다.
export function installLedgerTable(onActivity=()=>{}){
 const scroll=()=>document.querySelector('#lg-scroll');
 const rows=()=>[...document.querySelectorAll('[data-ledger-row]')];
 function toggle(row){
  const button=row.querySelector('[data-ledger-toggle]'),open=button.getAttribute('aria-expanded')!=='true';
  for(const r of rows()){
   r.classList.remove('selected');const b=r.querySelector('[data-ledger-toggle]');b.setAttribute('aria-expanded','false');b.textContent='펼치기';
   document.getElementById(r.dataset.ledgerRow).hidden=true;
  }
  if(open){row.classList.add('selected');button.setAttribute('aria-expanded','true');button.textContent='접기';document.getElementById(row.dataset.ledgerRow).hidden=false;}
  onActivity();
 }
 document.addEventListener('click',event=>{
  const close=event.target.closest('[data-ledger-close]');
  if(close){const row=rows().find(r=>r.dataset.ledgerRow===close.dataset.ledgerClose);if(row){toggle(row);row.querySelector('[data-ledger-toggle]').focus({preventScroll:true});}return;}
  const row=event.target.closest('[data-ledger-row]');
  if(row&&event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey&&!event.target.closest('a')&&(event.target.closest('button')||!window.getSelection()?.toString()))toggle(row);
 });
 scroll()?.addEventListener('scroll',onActivity,{passive:true});
 return {paused:()=>Boolean(document.querySelector('[data-ledger-toggle][aria-expanded="true"]')||scroll()?.scrollTop>0||scroll()?.scrollLeft>0)};
}

export const ledgerTableStyle=`
#ledger.lg-panel{height:100%;min-height:0;display:flex;flex-direction:column;margin:0;padding:16px 18px;gap:10px}#ledger .lg-top{display:flex;align-items:center;gap:20px;flex-wrap:wrap}#ledger h2,#ledger h3,#ledger .record-tabs{margin:0}#ledger .record-tabs{gap:4px}#ledger .lg-heading{display:flex;align-items:center;gap:12px;flex-wrap:wrap}#ledger .lg-heading span{font-size:12px;color:#606b65}#ledger .lg-help{margin:0 0 0 auto;font-size:12px;position:relative}#ledger .lg-help>.activity-guide{position:absolute;z-index:8;top:22px;right:0;width:min(540px,calc(100vw - 52px));box-shadow:0 4px 16px #20272415;border:1px solid #dce2de;margin:0;max-height:50vh;overflow:auto}#ledger .lg-caption{margin:0;font-size:12px;color:#606b65}
.lg-scroll{flex:1;min-height:0;max-width:100%;overflow:auto;overscroll-behavior:contain;border:1px solid #dce2de;border-radius:6px}.lg-scroll:focus-visible{outline-offset:-3px}.lg-table{width:100%;min-width:1080px;border-collapse:separate;border-spacing:0;table-layout:fixed;font-size:12px;line-height:18px}.lg-table col:nth-child(1){width:128px}.lg-table col:nth-child(2){width:115px}.lg-table col:nth-child(3),.lg-table col:nth-child(4){width:170px}.lg-table col:nth-child(6){width:70px}.lg-table th,.lg-table td{padding:0 10px;height:var(--ds-record-row-height);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:middle;border-bottom:1px solid #e6eae7}.lg-table th{position:sticky;top:0;z-index:3;background:#f1f4f2;border-bottom-color:#cbd5ce;font-size:12px}.lg-table th:first-child,.lg-table [data-ledger-row]>td:first-child{position:sticky;left:0;box-shadow:1px 0 #dce2de}.lg-table th:first-child{z-index:4}.lg-table [data-ledger-row]{--row-bg:#fff;cursor:pointer}.lg-table [data-ledger-row]:nth-of-type(4n+3){--row-bg:#f8faf9}.lg-table [data-ledger-row]:hover{--row-bg:#f0f5f2}.lg-table [data-ledger-row].selected{--row-bg:#eaf3ed}.lg-table [data-ledger-row]>td{background:var(--row-bg)}.lg-table [data-ledger-row]>td:first-child{z-index:1;font-variant-numeric:tabular-nums}.lg-table .lg-original-row>td{padding:10px;white-space:normal;overflow:visible;background:#f6f8f6}.lg-original{position:sticky;left:10px;max-width:calc(100vw - 116px)}.lg-original-heading{display:flex;justify-content:space-between;align-items:center;gap:10px}.lg-original pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;margin:8px 0 0;padding:10px;max-height:400px;border:1px solid #e1e7e3;border-radius:4px;background:white}.lg-table .lg-empty{padding:25px;color:#606b65}#ledger>.lg-pagination nav{justify-content:center;align-items:center;font-size:12px;gap:16px}
@media(max-width:799px){#ledger.lg-panel{padding:12px;border-radius:0;border-inline:0;gap:8px}#ledger .lg-top{gap:8px}#ledger h2{font-size:17px}#ledger .record-tabs{margin:0}#ledger h3{font-size:13px}#ledger .lg-caption{font-size:11px}.lg-original{max-width:calc(100vw - 48px)}}
`;
