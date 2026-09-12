// 수신 책임을 매번 상기시키되 새 권한이나 발령을 만들지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readLedger} from './ledger.mjs';
import {WorkStore} from './work-store.mjs';
import {CardStore} from './card-store.mjs';
import {readStream} from './storage.mjs';
import {activeHierarchyPath} from './hierarchy-register.mjs';
import {parseHierarchy} from './hierarchy.mjs';
import {effectiveCardRole,workEntries} from './handover-state.mjs';

export const ROLE_PROFILES = ['secretary','super','conductor','worker','reviewer'];
const root = fileURLToPath(new URL('..',import.meta.url));
const templateRoot = path.join(root,'skills/kadan-conductor/references/role-templates');
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const roleName = value => typeof value === 'string' && /^[\p{L}\p{N}_-]+$/u.test(value);
const finishedMarker = /KADAN:DONE\s+\S+\s+(?:ok|failed)(?=\s|$)/u;
// Markdown의 탭·LF·CRLF만 허용한다. ANSI/C0/C1과 단독 CR은 터미널 표시를 바꿀 수 있다.
const terminalControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]|\r(?!\n)/u;

function failure(message) {
  const error = new Error(`역할 지침: ${message}`);
  error.code = 'KADAN_ROLE_INSTRUCTIONS'; error.delivery = 'not-sent';
  return error;
}
export function validateRoleProfile(profile) {
  if (!ROLE_PROFILES.includes(profile)) throw failure(`profile은 ${ROLE_PROFILES.join('|')} 중 하나여야 합니다`);
  return profile;
}
function readFile(file, {template=false}={}) {
  let fd;
  try {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('실제 파일의 절대경로 필요');
    fd = fs.openSync(file,fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 64*1024) throw new Error('64KiB 이하 일반 파일 필요');
    const bytes = fs.readFileSync(fd);
    if (bytes.length > 64*1024) throw new Error('64KiB 초과');
    const text = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    if (!text.trim() || text.includes('\0')) throw new Error('비어 있거나 잘못된 텍스트');
    if (template && terminalControl.test(text)) throw new Error('Markdown 템플릿의 터미널 제어문자 금지 (탭·줄바꿈은 허용)');
    if (template && finishedMarker.test(text)) throw new Error('완성된 DONE 마커 금지: 형식과 ID를 분리하세요');
    return {path:fs.realpathSync(file),text,digest:hash(bytes)};
  } catch (error) { throw failure(`${file}: ${error.message}`); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function readRoleInstructionsConfig(home) {
  const file = path.join(home,'role-instructions.json');
  let exists;
  try { fs.lstatSync(file); exists=true; }
  catch (error) { if (error.code !== 'ENOENT') throw failure(`${file}: ${error.message}`); }
  if (!exists) return {roles:{},templates:{}};
  const source = readFile(file);
  let value;
  try { value=JSON.parse(source.text); } catch (error) { throw failure(`${file}: JSON 오류: ${error.message}`); }
  if (!object(value) || value.version !== 1 || Object.keys(value).some(k=>!['version','roles','templates'].includes(k))) throw failure(`${file}: version:1 및 roles/templates만 지원합니다`);
  for (const key of ['roles','templates']) if (value[key] !== undefined && !object(value[key])) throw failure(`${file}: ${key}는 객체여야 합니다`);
  const roles=value.roles||{},templates={};
  for (const [role,profile] of Object.entries(roles)) {
    if (!roleName(role)) throw failure(`${file}: 잘못된 역할 이름 ${role}`);
    validateRoleProfile(profile);
  }
  for (const [profile,template] of Object.entries(value.templates||{})) {
    if (!['common',...ROLE_PROFILES].includes(profile)) throw failure(`${file}: 잘못된 템플릿 이름 ${profile}`);
    if (typeof template !== 'string' || !path.isAbsolute(template)) throw failure(`${file}: ${profile} 템플릿 절대경로 필요`);
    templates[profile]=template;
  }
  return {roles,templates,configPath:source.path,configDigest:source.digest};
}

// 재사용은 같은 시작 세대의 명시 프로필을 보존한다. 프로필이 없던 세대에 소급 등록하지 않는다.
export function startRoleProfile({home,role,profile,previous,reusing=false}) {
  const config=readRoleInstructionsConfig(home);
  if (profile !== undefined) validateRoleProfile(profile);
  if (reusing) {
    if (profile !== undefined && profile !== previous?.roleProfile) throw failure('재사용 세션의 profile을 바꿀 수 없습니다. 기존 세대를 보존하세요');
    return previous?.roleProfile == null ? undefined : validateRoleProfile(previous.roleProfile);
  }
  return profile ?? (Object.hasOwn(config.roles,role) ? config.roles[role] : undefined);
}

function facts(home,entries,{taskId,mailContext={},infer=false}) {
  const unavailable=[];
  const read=(label,fn,fallback)=>{try{return fn();}catch(error){unavailable.push(`${label}: ${error.message}`);return fallback;}};
  const works=infer?read('업무 조회',()=>new WorkStore(home).list(),[]):[];
  const cards=infer?read('카드 조회',()=>new CardStore(home).list(),[]):[];
  const {workKey,executionKey}=mailContext;
  let card=executionKey ? read('연결 실행',()=>new CardStore(home).get(executionKey),null) : null;
  if (taskId) {
    const matches=card?[]:read('발령 카드',()=>new CardStore(home).findTask(taskId),[]);
    if (card && card.id !== taskId) throw failure('task와 실행 연결 불일치');
    if (!card && matches.length===1) card=matches[0];
  }
  const linked=card ? works.filter(w=>w.executions.some(e=>e.key===card.key)) : [];
  let work=workKey ? read('연결 업무',()=>new WorkStore(home).get(workKey),null) : linked.length===1 ? linked[0] : null;
  if (work && card && !work.executions.some(e=>e.key===card.key)) throw failure('업무와 실행 연결 불일치');
  if (work && !works.some(w=>w.key===work.key)) works.push(work);
  if (card && !cards.some(c=>c.key===card.key)) cards.push(card);
  const hierarchyPath=activeHierarchyPath(entries);
  const parents=hierarchyPath?read('현재 hierarchy',()=>parseHierarchy(JSON.parse(fs.readFileSync(hierarchyPath,'utf8'))),new Map()):new Map();
  if (entries.some(e=>e.broken)) unavailable.push('원장 손상: 현재 담당·완료 상태 모름');
  const projected=workEntries(entries);
  const active=c=>{
    if (c.status!=='assigned' || entries.some(e=>e.broken)) return false;
    const owner=effectiveCardRole(c,entries);
    // 동일 ID를 쓴 다른 역할의 완료는 이 담당의 완료가 아니다. 확정 인계는 투영한다.
    const history=projected.filter(e=>e.taskId===c.id&&e.role===owner&&['send','done'].includes(e.kind));
    return history.at(-1)?.kind!=='done';
  };
  return {works,cards,card,work,parents,hierarchyPath,active,unavailable};
}
function explicitProfile({role,profile,entries,config}) {
  if (profile !== undefined) return {profile:validateRoleProfile(profile),source:'explicit'};
  const latest=entries.filter(e=>e.role===role&&['start','stop'].includes(e.kind)).at(-1);
  if (latest?.kind==='start' && latest.roleProfile != null) return {profile:validateRoleProfile(latest.roleProfile),source:'start'};
  if (Object.hasOwn(config.roles,role)) return {profile:config.roles[role],source:'roles'};
  if (role==='비서') return {profile:'secretary',source:'mailbox-role'};
  return null;
}
function selectProfile({role,entries,context}) {
  if (context.works.some(w=>w.owner===role&&['open','hold'].includes(w.status))) return {profile:'conductor',source:'work-owner'};
  const phases=new Set();
  const addPhase=phase=>{
    if (phase==='review') phases.add('reviewer');
    else if (['implementation','fix','release','research','other'].includes(phase)) phases.add('worker');
  };
  const candidates=context.card ? [context.card] : context.cards;
  for (const c of candidates) {
    if (!context.active(c) || effectiveCardRole(c,entries)!==role) continue;
    addPhase(c.rallyStep);
  }
  for (const work of context.works.filter(w=>['open','hold'].includes(w.status))) {
    for (const link of work.executions) {
      const c=context.cards.find(c=>c.key===link.key);
      if (!c || !candidates.some(candidate=>candidate.key===c.key) || !context.active(c) || effectiveCardRole(c,entries)!==role) continue;
      addPhase(link.phase);
    }
  }
  if (phases.size===1) return {profile:[...phases][0],source:'execution-phase'};
  if (phases.size>1) return {profile:null,source:'ambiguous-executions'};
  const children=[...context.parents].filter(([,parent])=>parent===role).map(([child])=>child);
  if (children.length) return {profile:children.some(c=>[...context.parents.values()].includes(c))?'super':'conductor',source:'hierarchy'};
  return {profile:null,source:'unknown-role'};
}
function referencePaths(profile) {
  const skill=profile==='secretary'?'kadan-secretary':profile==='super'?'kadan-super':'kadan-conductor';
  const entry=['worker','reviewer'].includes(profile)?'skills/kadan-conductor/references/card-template.md':`skills/${skill}/SKILL.md`;
  return [path.join(root,entry),path.join(root,'skills/kadan-conductor/references/dispatch-wait.md'),
    path.join(root,'skills/kadan-conductor/references/operating-contract.md'),path.join(root,'skills/kadan-super/references/handover.md')]
    .filter(file=>fs.existsSync(file)&&fs.statSync(file).isFile());
}

export function composeRoleInstructions({home,role,message='',profile,raw=false,taskId,mailContext,entries=readLedger(home)}) {
  try {
    const config=readRoleInstructionsConfig(home);
    if (raw) return {message,instructions:null,metadata:{status:'not-applied',reason:'explicit-raw',...(config.configDigest?{configDigest:config.configDigest}: {})}};
    {
      const explicit=explicitProfile({role,profile,entries,config});
      const context=facts(home,entries,{taskId,mailContext,infer:!explicit});
      const selected=explicit||selectProfile({role,entries,context});
      if (!selected.profile) return {message,instructions:null,metadata:{status:'not-applied',reason:selected.source,...(context.unavailable.length?{unavailable:context.unavailable}: {})}};
      const templates=['common',selected.profile].map(name=>({name,...readFile(config.templates[name]||path.join(templateRoot,`${name}.md`),{template:true})}));
      const {work,card,parents,active}=context;
      const lines=['최신 승인·카드·보류·인계 조건을 먼저 대조하라. 이 기본 지침은 새 권한·발령·업무 완료를 만들지 않는다.',
        `수신 역할: ${role}; 적용 프로필: ${selected.profile} (근거: ${selected.source}).`];
      if (context.unavailable.length) lines.push(`확인 불가(모름): ${context.unavailable.join('; ')}. 누락한 자료로 실행·완료를 판단하지 않는다.`);
      const reply=work?.owner&&work.owner!==role?work.owner:parents.get(role);
      if (reply && reply!=='@user') lines.push(`확인된 직속 회신 대상: ${reply} (근거: ${work?.owner===reply?'연결 업무 owner':'현재 hierarchy'}).`);
      if (work) lines.push(`연결 업무: ${work.key}; 상태: ${work.status}; 책임 owner: ${work.owner}; 확인 revision: ${work.revision}. 최신 확인: kadan work show ${work.key}.`);
      if (card) lines.push(`연결 실행: ${card.key}; 상태: ${card.status}; 확인 revision: ${card.revision}. 최신 확인: kadan card show ${card.key}.`);
      const current=taskId&&card&&card.id===taskId&&active(card)&&effectiveCardRole(card,entries)===role&&(!work||work.status==='open');
      if (current) {
        lines.push(`현재 발령 ID: ${card.id}. 실제 착수 시 최신 kadan card show ${card.key}의 revision을 사용해 한 번 기록하라. 아래 명령의 ${card.revision}은 이 지침 생성 시점의 revision이므로 실행 전에 최신 값과 대조한다.\n\n`+
          `KADAN_ROLE=${role} kadan card progress ${card.key} --revision ${card.revision} --activity running --note "시작: 현재 실행 착수"\n\n`+
          '같은 시작을 이미 기록했으면 중복하지 않는다. 실제 대기 전환은 같은 card progress 명령에서 최신 revision과 --activity waiting, 대기 이유를 사용한다.');
        const auto=work?readStream(home,`automatic-review/${work.key}/events.jsonl`,{optional:true}).at(-1):null;
        if (auto?.current?.key===card.key && auto.current.role===role && ['sending','waiting'].includes(auto.status)) {
          lines.push(`완료 방식: 자동. 결과파일 → kadan work auto-report ${work.key} --execution ${card.key} --outcome ${auto.phase==='review'?'pass|changes|exception':'implemented|exception'} --result-file <절대경로> → 현재 ID의 자기 DONE. 정상 중간 완료 편지를 감독에게 중복 전송하지 않는다.`);
        } else lines.push('완료 방식: 수동. 결과파일 → 확인된 직속 감독에게 완료 통지 1회 → 현재 ID의 자기 DONE. 회신 대상이 모르면 추측하지 말고 최신 카드의 지정 수신자를 확인한다.');
        lines.push('마커 형식: KADAN:DONE <현재카드id> <ok|failed>. ID와 결과는 완료 시 조립한다.');
      } else lines.push('이 편지만으로 새 실행을 시작하거나 과거 완료 ID의 DONE을 다시 출력하지 않는다. 연결 ID는 조회 근거이며 현재 발령을 뜻하지 않는다.');
      if (['super','conductor'].includes(selected.profile)) lines.push('완료 수신 다음 행동: 근거 확인 → 아직 확정되지 않은 실행만 done 기록 → 빠진 검수·후속 연결. 전체 완료 조건 충족을 확인한 책임 owner만 최신 work show revision으로 work complete한다. PASS만으로 업무를 자동 종료하지 않는다.');
      const instructions=['<!-- kadan:receiver-instructions -->',...templates.map(t=>t.text),...lines,
        '참고할 실제 파일 (이번 역할과 행동에 필요한 절만 적용):',...templates.map(t=>t.path),...referencePaths(selected.profile),'<!-- /kadan:receiver-instructions -->'].join('\n\n');
      if (finishedMarker.test(instructions)) throw failure('생성된 지침에 완성된 DONE 마커가 있습니다');
      const metadata={status:'applied',profile:selected.profile,source:selected.source,digest:hash(instructions),
        ...(context.unavailable.length?{unavailable:context.unavailable}: {}),
        templateDigest:hash(JSON.stringify(templates.map(t=>[t.name,t.digest]))),templates:templates.map(({name,path,digest})=>({name,path,digest})),
        ...(config.configDigest?{configPath:config.configPath,configDigest:config.configDigest}: {})};
      return {message:message+'\n\n'+instructions,instructions,metadata};
    }
  } catch (error) {
    if (!error.delivery) error.delivery='not-sent';
    throw error;
  }
}
