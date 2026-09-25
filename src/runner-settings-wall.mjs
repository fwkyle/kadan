// 대시보드 '실행 모델' 화면 — 역할별 실행기·모델·강도와 활성 프리셋(2단계), 역할별 폴백 순서(3단계)를 고른다(2026-09-23 [kyle]).
// 선택지는 runnerChoices에서만 온다. 저장 검사는 서버의 setRole·setActivePreset·setFallback이 맡고, 화면 스크립트는 선택지만 좁힌다.
import {launchFor, launchForFallback, readSettings, runnerChoices, PROFILE_ROLES} from './runner-settings.mjs';

const e=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const stamp=x=>x?new Date(x).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}):'모름';
export const RUNNER_ROLE_LABELS={worker:'작업자',reviewer:'검수자',conductor:'일반감독',super:'슈퍼감독'};
const actionLabels={init:'처음 만듦',set:'역할 값',preset:'프리셋 전환',runner:'실행기 틀',model:'실측 모델',block:'정책 차단',fallback:'폴백 순서'};
export const FALLBACK_WHEN='내려가는 조건: 원인이 확인된 막힘(쿼터·429·로그인 실패·모델 이름 오류)만. 원인을 모르면 멈추고 보고';
const APPLY_NOTE='다음 발령부터 적용, 떠 있는 세션은 그대로';

const choice=v=>v&&typeof v==='object'&&v.runner?[v.runner,v.model,v.effort].filter(Boolean).join(' / '):null;
const numbered=list=>Array.isArray(list)&&list.length?list.map((v,i)=>`${i+1}. ${choice(v)}`).join('; '):null;
// 원장 runner-settings 사건 한 건을 '무엇을'과 '전→후'로 푼다.
function describe(x){
 const what=x.action==='set'||x.action==='fallback'?`${x.preset??''} ${RUNNER_ROLE_LABELS[x.role]??x.role??''}`.trim()
  :x.action==='runner'?`실행기 ${x.runner??''}`:x.action==='model'?`${x.runner??''} 모델`:'';
 const from=x.action==='fallback'?numbered(x.before):x.action==='set'?choice(x.before):x.action==='preset'?x.before:x.action==='runner'?x.before?.spawn:x.action==='model'?x.before&&`${x.before.model} (${(x.before.efforts??[]).join(',')})`:null;
 const to=x.action==='fallback'?numbered(x.after)??'비움':x.action==='set'?choice(x.after):x.action==='preset'?x.after:x.action==='runner'?x.after?.spawn:x.action==='model'?x.after&&`${x.after.model} (${(x.after.efforts??[]).join(',')})`
  :x.action==='block'?x.after&&`${x.after.model} 차단 (${x.after.roles?.map(r=>RUNNER_ROLE_LABELS[r]??r).join(',')||'모든 역할'})`:x.action==='init'?`revision ${x.revision}`:null;
 return {what:[actionLabels[x.action]??x.action,what].filter(Boolean).join(' · '),change:`${from??'없음'} → ${to??'모름'}`};
}

// 실행기별 선택지. 목록을 못 읽은 실행기는 오류만 담아 화면 전체를 막지 않는다.
function catalog(settings,options){
 return Object.fromEntries(Object.entries(settings.runners).map(([runner,spec])=>{
  const needsEffort=String(spec?.spawn??'').includes('{effort}');
  try{return [runner,{needsEffort,models:[...runnerChoices(settings,runner,options)].map(([model,efforts])=>({model,efforts}))}];}
  catch(error){return [runner,{needsEffort,models:[],error:error.message}];}
 }));
}
const blockedFor=(settings,model,role)=>(settings.blocked??[]).find(b=>b.model===model&&(!b.roles||b.roles.includes(role)));
const option=(value,text,{selected=false,disabled=false}={})=>`<option value="${e(value)}"${selected?' selected':''}${disabled?' disabled':''}>${e(text)}</option>`;

// 실행기 → 모델 → 강도 선택 칸. current가 없으면 첫 실행기에서 모델을 고르게 한다.
function pickers(settings,runners,role,current){
 const runner=current&&runners[current.runner]?current.runner:Object.keys(runners)[0];
 const spec=runners[runner]??{models:[],needsEffort:false};
 const model=spec.models.find(m=>m.model===current?.model);
 const models=[option('',current?.model&&!model&&current.runner===runner?`지금 값이 목록에 없음: ${current.model}`:'모델 고르기',{selected:!model,disabled:true}),
  ...(spec.error?[option('',`모델 목록을 읽을 수 없음: ${spec.error}`,{disabled:true})]:[]),
  ...spec.models.map(m=>{const b=blockedFor(settings,m.model,role);return option(m.model,b?`${m.model} — 차단: ${b.reason}`:m.model,{selected:m===model,disabled:Boolean(b)});})].join('');
 const efforts=!spec.needsEffort?option('','해당 없음'):model?.efforts.length?model.efforts.map(v=>option(v,v,{selected:v===current?.effort})).join(''):option('','모델을 먼저 고르세요',{selected:true,disabled:true});
 return `<div class="rs-pick"><label>실행기<select name="runner">${Object.keys(runners).map(r=>option(r,r,{selected:r===runner})).join('')}</select></label><label>모델<select name="model">${models}</select></label><label>추론 강도<select name="effort"${spec.needsEffort?'':' disabled'}>${efforts}</select></label></div>`;
}
const hiddenFields=(settings,role,token)=>`<input type="hidden" name="token" value="${e(token)}"><input type="hidden" name="revision" value="${settings.revision}"><input type="hidden" name="role" value="${e(role)}">`;

function roleForm(settings,runners,role,token){
 const current=settings.presets[settings.activePreset].roles[role]??null;
 let launch;try{launch=launchFor(settings,role)?.cmd??null}catch(error){launch='모름: '+error.message}
 return `<form method="post" action="/runners/set" class="edit rs-row" data-role="${e(role)}" data-launch="${e(launch??'')}">${hiddenFields(settings,role,token)}
<h3>${e(RUNNER_ROLE_LABELS[role])} <small class="muted">${e(role)}</small></h3><p>지금: ${e(choice(current)??'비어 있음 — 발령 때 --cmd 필요')}</p>
${pickers(settings,runners,role,current)}
<label>바꾸는 이유 (필수)<input name="reason" required maxlength="500"></label><button>저장</button>
<p class="muted">지금 채워질 실행 명령: <code>${e(launch??'없음')}</code></p><p class="rs-preview" hidden>바뀔 명령: <code class="rs-before">${e(launch??'없음')}</code> → <code class="rs-after"></code></p></form>`;
}

// 역할별 폴백 순서(3단계). 버튼 한 번이 서버 저장 한 번이다: 추가·삭제·위로·아래로. 판정은 서버가 한다.
function fallbackForm(settings,runners,role,token){
 const list=settings.presets[settings.activePreset].fallback?.[role]??[];
 const cmd=i=>{try{return launchForFallback(settings,role,i).cmd}catch(error){return '모름: '+error.message}};
 const rows=list.map((item,i)=>`<li><span>${i+1}번 ${e(choice(item))}</span> <code>${e(cmd(i+1))}</code> <span class="rs-ops"><button name="op" value="up:${i+1}"${i===0?' disabled':''}>위로</button><button name="op" value="down:${i+1}"${i===list.length-1?' disabled':''}>아래로</button><button name="op" value="remove:${i+1}">삭제</button></span></li>`).join('');
 return `<form method="post" action="/runners/fallback" class="edit rs-row rs-fallback" data-role="${e(role)}">${hiddenFields(settings,role,token)}
<h4>${e(RUNNER_ROLE_LABELS[role])} 폴백 순서</h4>${list.length?`<ol>${rows}</ol><p class="muted">발령: <code>kadan start &lt;역할&gt; --profile ${e(role)} --fallback N --reason &lt;이유&gt;</code></p>`:'<p>폴백 없음</p>'}
${pickers(settings,runners,role,null)}
<p class="rs-preview" hidden>추가될 명령: <code class="rs-after"></code></p><label>바꾸는 이유 (필수)<input name="reason" required maxlength="500"></label><button name="op" value="add">폴백 추가</button></form>`;
}

function presetForm(settings,token){
 const names=Object.keys(settings.presets);
 const label=name=>settings.presets[name]?.label&&settings.presets[name].label!==name?`${name} — ${settings.presets[name].label}`:name;
 if(names.length<2)return `<p>활성 프리셋: <strong>${e(label(settings.activePreset))}</strong> · 전환할 다른 프리셋이 없습니다.</p>`;
 return `<form method="post" action="/runners/preset" class="edit rs-preset"><input type="hidden" name="token" value="${e(token)}"><input type="hidden" name="revision" value="${settings.revision}"><p>활성 프리셋: <strong>${e(label(settings.activePreset))}</strong></p><label>바꿀 프리셋<select name="preset">${names.map(n=>option(n,label(n),{selected:n===settings.activePreset,disabled:n===settings.activePreset})).join('')}</select></label><label>바꾸는 이유 (필수)<input name="reason" required maxlength="500"></label><button>프리셋 전환</button></form>`;
}

// 화면 스크립트는 실행기를 바꾸면 모델을, 모델을 바꾸면 강도를 좁힌다. 틀린 값은 서버가 다시 거부한다.
const script=`(()=>{const data=JSON.parse(document.getElementById('rs-data').textContent);
const opt=(v,t,sel,dis)=>{const o=document.createElement('option');o.value=v;o.textContent=t;o.selected=Boolean(sel);o.disabled=Boolean(dis);return o;};
const blocked=(m,role)=>data.blocked.find(b=>b.model===m&&(!b.roles||b.roles.includes(role)));
function effort(f){const r=data.runners[f.runner.value],m=r&&r.models.find(x=>x.model===f.model.value),s=f.effort,prev=s.value;s.replaceChildren();
 if(!r||!r.needsEffort){s.append(opt('','해당 없음'));s.disabled=true;return;}s.disabled=false;
 if(!m||!m.efforts.length){s.append(opt('',m?'고를 강도 없음':'모델을 먼저 고르세요',true,true));return;}m.efforts.forEach(v=>s.append(opt(v,v,v===prev)));}
function model(f){const r=data.runners[f.runner.value],s=f.model;s.replaceChildren(opt('','모델 고르기',true,true));
 if(r&&r.error)s.append(opt('','모델 목록을 읽을 수 없음: '+r.error,false,true));
 (r?r.models:[]).forEach(m=>{const b=blocked(m.model,f.dataset.role);s.append(opt(m.model,b?m.model+' — 차단: '+b.reason:m.model,false,b));});effort(f);}
// 고르는 즉시 바뀔 명령을 보인다. 서버와 같은 규칙: 실행기 틀의 {model}·{effort}를 바꿔 끼운다.
function preview(f){const box=f.querySelector&&f.querySelector('.rs-preview');if(!box)return;const tpl=data.spawns[f.runner.value];
 if(!tpl||!f.model.value){box.hidden=true;return;}const cmd=tpl.split('{model}').join(f.model.value).split('{effort}').join(f.effort.disabled?'':(f.effort.value||''));
 box.querySelector('.rs-after').textContent=cmd;box.hidden=cmd===(f.dataset.launch||null);}
document.querySelectorAll('form.rs-row').forEach(f=>{f.runner.addEventListener('change',()=>{model(f);preview(f);});f.model.addEventListener('change',()=>{effort(f);preview(f);});f.effort.addEventListener('change',()=>preview(f));});
// 요약표의 바꾸기는 그 역할의 변경 칸을 펼쳐 보여 준다. 펼친 칸은 새로 읽어도 다시 펼친다(2026-09-25: 새로고침하면 고르기 칸이 접혀 사라진 것처럼 보였다).
const openKey='kadan.runners.open',edits=[...document.querySelectorAll('details.rs-edit')];
let opened=[];try{opened=JSON.parse(sessionStorage.getItem(openKey)||'[]');}catch{}
edits.forEach(d=>{if(opened.includes(d.id))d.open=true;d.addEventListener('toggle',()=>{try{sessionStorage.setItem(openKey,JSON.stringify(edits.filter(x=>x.open).map(x=>x.id)));}catch{}});});
document.querySelectorAll('[data-rs-open]').forEach(b=>b.addEventListener('click',()=>{const d=document.getElementById('rs-edit-'+b.dataset.rsOpen);if(!d)return;d.open=true;d.scrollIntoView({block:'start'});d.querySelector('select')?.focus({preventScroll:true});}));})();`;

export const runnerSettingsStyle='.rs-summary th[scope=row]{white-space:nowrap}.rs-summary code{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.rs-edit{border:1px solid #d8ded8;border-radius:8px;padding:8px 14px;margin:8px 0}.rs-edit>summary{cursor:pointer;font-weight:600}.rs-edit .rs-row:first-of-type{border-top:0;margin-top:6px}.rs-preview{font-size:12.5px;background:#fff6e3;border-radius:6px;padding:6px 10px}.rs-preview code{overflow-wrap:anywhere}.rs-fallback ol{padding-left:20px}.rs-fallback li{margin:6px 0}.rs-ops button{margin-left:6px}.rs-row{border-top:1px solid #d8ded8;padding-top:12px;margin-top:12px}.rs-pick{display:flex;flex-wrap:wrap;gap:10px}.rs-pick label{flex:1 1 180px;min-width:0}.rs-pick select{display:block;width:100%;max-width:100%;min-width:0}.rs-row code{overflow-wrap:anywhere}';

export function renderRunnerSettings({home,entries=[],token='',saved=null,readCodexModels}={}){
 const head='<section class="panel" id="runner-settings" data-view="runner-settings"><h2>실행 모델</h2><p class="muted">역할별 실행기·모델·추론 강도입니다. '+APPLY_NOTE+'입니다.</p>';
 let settings=null,error=home?null:'설정 위치 모름';
 if(home)try{settings=readSettings(home)}catch(err){error=err.message}
 const events=entries.filter(x=>x?.kind==='runner-settings').slice(-10).reverse();
 const history=`<h3>최근 변경 ${events.length}건</h3><div class="scroll"><table><thead><tr><th>시각</th><th>누가</th><th>무엇을</th><th>전 → 후</th><th>이유</th></tr></thead><tbody>${events.map(x=>{const d=describe(x);return `<tr><td>${e(stamp(x.t))}</td><td>${e(x.by||'모름')}</td><td>${e(d.what)}</td><td>${e(d.change)}</td><td>${e(x.reason??'')}</td></tr>`}).join('')||'<tr><td colspan="5">기록 없음</td></tr>'}</tbody></table></div>`;
 if(error)return head+`<p role="alert">모름: ${e(error)}</p>${history}</section>`;
 if(!settings)return head+`<p role="alert">실행 모델 설정 파일이 없습니다. <code>kadan runners init --reason 이유</code>를 먼저 실행하세요.</p>${history}</section>`;
 const runners=catalog(settings,readCodexModels?{readCodexModels}:{});
 const data=JSON.stringify({runners,blocked:settings.blocked??[],spawns:Object.fromEntries(Object.entries(settings.runners||{}).map(([k,v])=>[k,v.spawn]))}).replaceAll('<','\\u003c');
 // 기본은 읽기 전용 요약표. 편집 틀은 역할별 '변경'을 펼쳐야 보인다(2026-09-24 UX 검토: 들어가자마자 입력 틀 8개가 열려 실수로 바꾸기 쉬웠다).
 const summaryRow=role=>{const current=settings.presets[settings.activePreset].roles[role]??null;let launch;try{launch=launchFor(settings,role)?.cmd??null}catch(error){launch='모름: '+error.message}
  const fallbacks=(settings.presets[settings.activePreset].fallback?.[role]??[]).length;
  return `<tr><th scope="row">${e(RUNNER_ROLE_LABELS[role])}<br><small class="muted">${e(role)}</small></th><td>${e(choice(current)??'비어 있음')}</td><td><code>${e(launch??'없음')}</code></td><td>${fallbacks}개</td><td><button type="button" data-rs-open="${e(role)}">바꾸기</button></td></tr>`;};
 const summaryTable=`<div class="scroll"><table class="rs-summary"><thead><tr><th>역할</th><th>지금 값</th><th>발령 때 채워질 명령</th><th>폴백</th><th><span class="dw-sr">바꾸기</span></th></tr></thead><tbody>${Object.keys(PROFILE_ROLES).map(summaryRow).join('')}</tbody></table></div>`;
 const editors=Object.keys(PROFILE_ROLES).map(role=>`<details class="rs-edit" id="rs-edit-${e(role)}"><summary>${e(RUNNER_ROLE_LABELS[role])} 값·폴백 변경</summary>${roleForm(settings,runners,role,token)}${fallbackForm(settings,runners,role,token)}</details>`).join('');
 const notice=saved!=null&&Number(saved)===settings.revision?`<p role="status"><strong>저장했습니다(revision ${settings.revision}). ${APPLY_NOTE}.</strong></p>`:'';
 return head+notice+`<p class="muted">화면을 읽은 설정 revision ${settings.revision} · 그사이 다른 곳에서 바뀌면 저장을 거부합니다. 저장은 사람 명의로 원장에 남습니다.</p>
<h3>지금 설정 (프리셋 ${e(settings.activePreset)})</h3>${summaryTable}
<h3>바꾸기</h3><p role="note"><strong>${FALLBACK_WHEN}.</strong> 자동 전환은 없습니다. 사람이나 감독이 번호를 골라 발령합니다. 고르는 즉시 바뀔 명령을 보여 주고, 저장은 이유를 적어야 됩니다.</p>${editors}
<h3>프리셋</h3>${presetForm(settings,token)}${history}
<script type="application/json" id="rs-data">${data}</script><script>${script}</script></section>`;
}
