import {taskIdentity} from './task-identity.mjs';
import {assertWritable,storageMode,transaction,readStream,appendStream,listStreams} from './storage.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readLedger } from './ledger.mjs';
import { effectiveCardRole } from './handover-state.mjs';
const slug = value => typeof value === 'string' && /^[\p{L}\p{N}_-]+$/u.test(value);
// 카드 본문 '읽고 시작할 것'에 적힌 절대경로. 양식의 예시 문구(<>·…)는 세지 않는다.
export function readFirstPaths(body) {
  const lines=String(body??'').split('\n');
  const start=lines.findIndex(line=>/^#{1,6}\s*읽고 시작할 것\s*$/.test(line.trim()));
  if(start===-1)return [];
  const found=[];
  for(const line of lines.slice(start+1)) {
    if(/^#{1,6}\s/.test(line))break;
    if(/[<>…]/.test(line))continue;
    for(const match of line.matchAll(/(?:^|\s)(\/[^\s`'"]+)/g)) {
      const candidate=match[1].replace(/[.,;:]+$/,'');
      if(candidate.split('/').filter(Boolean).length>=2)found.push(candidate);
    }
  }
  return [...new Set(found)];
}
export class CardStore {
  constructor(home) { this.home=home; this.root=path.join(home,'cards'); }
  dir(key) {
    const parts=String(key).split('/');
    if(parts.length!==2||!parts.every(slug))throw new Error('카드 주소는 저장소/카드ID');
    return path.join(this.root,...parts);
  }
  get(key) {
    const dir=this.dir(key);
    const history=readStream(this.home,`cards/${key}/events.jsonl`);
    if(!history.length||history.some((e,i)=>e.revision!==i+1||e.key!==key))throw new Error('카드 이력 손상');
    return {...history.at(-1),history,body:fs.readFileSync(path.join(dir,'card.md'),'utf8'),path:path.join(dir,'card.md')};
  }
  list() {
    if(storageMode(this.home)==='sqlite')return transaction(this.home,()=>listStreams(this.home,'cards/').filter(s=>s.endsWith('/events.jsonl')).map(s=>this.get(s.slice(6,-13))),{readOnly:true});
    if(!fs.existsSync(this.root))return [];
    const result=[];
    for(const repo of fs.readdirSync(this.root,{withFileTypes:true}).filter(x=>x.isDirectory()&&!x.name.startsWith('.'))) {
      for(const card of fs.readdirSync(path.join(this.root,repo.name),{withFileTypes:true}).filter(x=>x.isDirectory()))result.push(this.get(`${repo.name}/${card.name}`));
    }
    return result;
  }
  locked(fn) {
    assertWritable(this.home);
    if(storageMode(this.home)==='sqlite')return transaction(this.home,fn);
    fs.mkdirSync(this.root,{recursive:true,mode:0o700});
    const lock=path.join(this.root,'.lock');
    try{fs.mkdirSync(lock)}catch{throw new Error('카드 저장 중: 잠시 뒤 상태를 다시 확인');}
    try{return fn()}finally{fs.renameSync(lock,path.join(this.root,`.released-${randomUUID()}`))}
  }
  create({repo,id,repoPath,sourcePath,title,body,workType='execution',by='사람'}) {
    return this.locked(()=>{
      if(!['execution','coordination'].includes(workType))throw new Error('잘못된 카드 종류');
      const key=`${repo}/${id}`,target=this.dir(key),dir=path.join(this.root,`.creating-${randomUUID()}`);
      if(fs.existsSync(target))throw new Error(`카드가 이미 있음: ${key}`);
      if(!path.isAbsolute(repoPath)||!fs.statSync(repoPath).isDirectory())throw new Error('저장소 절대경로 필요');
      if(sourcePath&&(!path.isAbsolute(sourcePath)||!fs.statSync(sourcePath).isFile()))throw new Error('원본 파일 절대경로 필요');
      const text=sourcePath?fs.readFileSync(sourcePath,'utf8'):body;
      if(typeof text!=='string'||!text.trim())throw new Error('카드 내용 필요');
      fs.mkdirSync(dir,{recursive:true,mode:0o700});
      fs.writeFileSync(path.join(dir,'card.md'),text,{flag:'wx',mode:0o600});
      const entry={key,repo,id,repoPath,sourcePath:sourcePath??null,title:title||text.match(/^#\s+(.+)$/m)?.[1]||id,
        status:'draft',workType,scope:'',board:null,role:null,revision:1,by,at:new Date().toISOString(),note:'중앙 등록',noteKind:'decision'};
      if(storageMode(this.home)==='jsonl')fs.writeFileSync(path.join(dir,'events.jsonl'),JSON.stringify(entry)+'\n',{flag:'wx',mode:0o600});
      fs.mkdirSync(path.dirname(target),{recursive:true});fs.renameSync(dir,target);
      if(storageMode(this.home)==='sqlite')appendStream(this.home,`cards/${key}/events.jsonl`,entry);
      return this.get(key);
    });
  }
  update(key,patch,{revision,by='사람',noteKind='decision',note,manual=false}={}) {
    return this.locked(()=>{
      const current=this.get(key);
      current.role=effectiveCardRole(current,readLedger(this.home),this.list());
      if(Number(revision)!==current.revision)throw new Error('카드가 변경됨: 새로 읽고 다시 저장');
      if(!note?.trim())throw new Error('변경 이유/질문/답변을 적어야 한다');
      if(!['decision','question','answer','progress'].includes(noteKind))throw new Error('잘못된 기록 종류');
      const allowed=new Set(['title','status','scope','board','role','activity','workType','resolutionOwner','nextAction','statusReason','rallyId','rallyTitle','rallyRound','rallyStep','replacedBy','turnOwner']);
      for(const k of Object.keys(patch))if(!allowed.has(k)||!(typeof patch[k]==='string'||patch[k]===null))throw new Error('잘못된 수정 항목');
      const {history,body,path:bodyPath,...previous}=current;
      const next={...previous,...patch,revision:current.revision+1,by,at:new Date().toISOString(),noteKind,note};
      if(next.status!==current.status||(patch.activity!==undefined&&patch.activity!==current.activity)){
        next.statusReason=patch.statusReason?.trim()||note;next.resolutionOwner=patch.resolutionOwner??null;next.nextAction=patch.nextAction??null;
      }
      if(['rallyId','rallyTitle','rallyRound','rallyStep'].some(k=>Object.hasOwn(patch,k))){
        if(['rallyId','rallyTitle','rallyRound','rallyStep'].every(k=>Object.hasOwn(patch,k)&&!patch[k])){for(const k of ['rallyId','rallyTitle','rallyRound','rallyStep'])next[k]=null;}
        else if(!slug(next.rallyId)||!next.rallyTitle?.trim()||next.rallyTitle.length>160||!['implementation','fix','review','research'].includes(next.rallyStep)||!/^([1-9]\d*|0)$/.test(next.rallyRound??'')||Number(next.rallyRound)>999||((next.rallyStep==='research')!==(next.rallyRound==='0')))throw new Error('묶음 ID·제목·라운드·단계를 함께 확인하세요. 조사는 0라운드입니다.');
      }
      if(next.status==='superseded'){
        if(!next.replacedBy||next.replacedBy===key)throw new Error('대체할 후속 카드가 필요합니다');
        const seen=new Set([key]);let target=next.replacedBy;
        while(target){if(seen.has(target))throw new Error('대체 카드 순환 연결');seen.add(target);target=this.get(target).replacedBy;}
      }else if(next.replacedBy){if(patch.replacedBy)throw new Error('후속 연결은 대체됨 상태에서만 가능합니다');next.replacedBy=null;}
      if(next.workType!==undefined&&!['execution','coordination'].includes(next.workType))throw new Error('잘못된 카드 종류');
      if(!['draft','ready','assigned','hold','done','cancelled','superseded','archived'].includes(next.status))throw new Error('잘못된 카드 상태');
      if(['ready','assigned'].includes(next.status)&&!next.scope?.trim())throw new Error('발령 가능한 범위를 먼저 적어야 한다');
      if(next.status==='assigned'&&(!slug(next.board)||!slug(next.role)))throw new Error('판과 담당 역할이 필요하다');
      if(next.status==='assigned'&&current.status!=='assigned'&&next.workType==='execution'&&!next.rallyId)throw new Error('실행 카드 수동 발령에는 티키타카 묶음 정보가 필요하다. --rally-id --rally-title --rally-round --rally-step을 함께 적어라(작은 작업은 1싸이클 구현 라운드: --rally-round 1 --rally-step implementation). 업무 안의 실행은 work execute·자동 전달 경로를 쓴다.');
      // worktree 작업자는 상위 폴더 지침이 자동으로 걸리지 않는다. 읽을 문서를 카드가 직접 알려주게 한다.
      if(manual&&next.status==='assigned'&&current.status!=='assigned'&&next.workType==='execution'&&readFirstPaths(body).length===0)throw new Error("실행 카드 수동 발령에는 카드 본문 '읽고 시작할 것'에 읽을 문서를 절대경로로 최소 1개 적어야 한다. worktree는 저장소 루트 밑이 아닌 경우가 많아 작업자가 위로 올라가며 찾는 지침이 하나도 안 걸린다. 예: '## 읽고 시작할 것' 아래에 '- /절대경로/저장소/AGENTS.md — 저장소 공통 규칙'. 양식의 예시 문구(<>·…)는 적힌 것으로 보지 않는다.");
      if(patch.activity!==undefined){
        if(!['running','waiting','unknown'].includes(patch.activity)||next.status!=='assigned'||by!==next.role)throw new Error('진행 보고는 배정된 역할에서만 가능');
        next.activityAt=next.at;next.activityRole=by;
      }
      if(next.status==='ready'){next.board=null;next.role=null;}
      if(Object.hasOwn(patch,'turnOwner')){
        const owner=patch.turnOwner?.trim()||null;
        if(owner&&(!slug(owner)||owner.length>160))throw new Error('현재 차례는 역할 이름 또는 사람 이름으로 적어주세요');
        next.turnOwner=owner;next.turnAt=next.at;next.turnBy=by;next.turnRevision=next.revision;
      }else if(next.status!==current.status||next.role!==current.role||patch.activity!==undefined){
        next.turnOwner=null;next.turnAt=null;next.turnBy=null;next.turnRevision=null;
      }
      appendStream(this.home,`cards/${key}/events.jsonl`,next);
      return this.get(key);
    });
  }
  link(key) {
    return this.locked(()=>{
      const card=this.get(key),source=card.sourcePath;
      if(!source)throw new Error('연결할 기존 경로 없음');
      if(fs.realpathSync(source)===fs.realpathSync(card.path))return card;
      if(fs.readFileSync(source,'utf8')!==card.body)throw new Error('가져온 뒤 원본 변경: 연결 중단');
      const backup=path.join(this.dir(key),`original-${randomUUID()}.md`);
      fs.renameSync(source,backup);
      try{fs.symlinkSync(card.path,source)}catch(error){fs.renameSync(backup,source);throw error;}
      return card;
    });
  }
  // Why: 감독이 등록 뒤 원본 카드 파일을 고쳤을 때(예: '읽고 시작할 것' 보완) 아직 발령 전(draft·담당 없음)이면
  // 중앙 사본만 다시 읽는다. link는 원본을 심볼릭 링크로 바꿔 문서 저장소를 더럽히므로 여기서는 쓰지 않는다.
  refresh(key,{by='사람'}={}) {
    return this.locked(()=>{
      const card=this.get(key),source=card.sourcePath;
      card.role=effectiveCardRole(card,readLedger(this.home),this.list());
      if(!source)throw new Error('다시 읽을 원본 경로 없음');
      if(card.status!=='draft'||card.role)throw new Error(`발령 전 초안만 다시 읽을 수 있다: ${card.status}, 담당 ${card.role??'없음'}`);
      const text=fs.readFileSync(source,'utf8');
      if(!text.trim())throw new Error('카드 내용 필요');
      if(text===card.body)return card;
      fs.writeFileSync(card.path,text,{mode:0o600});
      const {history,body,path:bodyPath,...previous}=card;
      appendStream(this.home,`cards/${key}/events.jsonl`,{...previous,revision:card.revision+1,by,at:new Date().toISOString(),noteKind:'decision',note:'원본 카드 파일 다시 읽음(발령 전)'});
      return this.get(key);
    });
  }
  findTask(id) {return this.list().filter(c=>id.includes('/')?c.key===id:c.id===id);}
  checkSend(id,role,cards=this.list()) {
    const identity=taskIdentity(cards),found=identity.resolve(id);
    identity.write(id);
    if(!found.card)return null;
    const c=found.card;c.role=effectiveCardRole(c,readLedger(this.home),identity);
    if(c.status!=='assigned'||c.role!==role||!c.scope.trim())throw new Error(`중앙 카드 발령 불가: ${c.key} (${c.status}, 담당 ${c.role??'미배정'})`);
    return c;
  }
}
