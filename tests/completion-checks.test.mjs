import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {CardStore} from '../src/card-store.mjs';
import {appendLedger,readLedger} from '../src/ledger.mjs';
import * as cc from '../src/completion-checks.mjs';

const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
const templatePath=fileURLToPath(new URL('../skills/kadan-conductor/references/card-template.md',import.meta.url));
const rally={rallyId:'r1',rallyTitle:'묶음',rallyRound:'1',rallyStep:'implementation'};
const git=(cwd,...args)=>spawnSync('git',['-c','user.email=t@example.test','-c','user.name=t',...args],{cwd,encoding:'utf8'});
const tmp=prefix=>fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),prefix)));
const headOf=dir=>git(dir,'rev-parse','HEAD').stdout.trim();

function repoDir() {
 const dir=tmp('kadan-cc-repo-');
 git(dir,'init','-q','-b','main');fs.writeFileSync(path.join(dir,'a.txt'),'hello\n');
 git(dir,'add','a.txt');git(dir,'commit','-q','-m','first');
 return dir;
}
function fixture(section) {
 const home=tmp('kadan-cc-home-'),repo=repoDir(),store=new CardStore(home);
 const body=`# 검사 카드\n\n## 범위\n로컬\n${section===undefined?'':`\n## 완료 검사\n${section}\n\n## 다음 절\n- file next-section.txt exists\n`}`;
 const created=store.create({repo:'repo',id:'card-a',repoPath:repo,body,by:'사람'});
 const card=store.update(created.key,{status:'assigned',scope:'로컬 구현만',board:'b',role:'p-작업자',...rally},{revision:1,note:'배정'});
 appendLedger({kind:'start',role:'p-작업자',session:'kadan-p-작업자',t:new Date().toISOString()},home);
 const run=(...args)=>spawnSync(process.execPath,[cli,...args],{env:{...process.env,KADAN_HOME:home,KADAN_LITE_HOME:'',KADAN_ROLE:'p-감독'},encoding:'utf8',timeout:30000});
 return {home,repo,store,key:card.key,run,done:(...a)=>run('done','p-작업자','card-a','ok',...a),doneRows:()=>readLedger(home).filter(e=>e.kind==='done')};
}
const memos=f=>f.store.get(f.key).history.filter(e=>String(e.note).startsWith('완료 검사:'));
const card=repoPath=>({repoPath});
// 실제 git은 그대로 부르고 호출만 기록한다. 이름 붙은 하위 명령은 가짜 결과로 바꾼다.
const recording=(fake={})=>{
 const calls=[];
 const fn=(file,args,opts)=>{
  calls.push({file,args,opts});
  const sub=args.find(a=>['rev-parse','ls-remote','status','check-ref-format','worktree'].includes(a));
  if(fake[sub])return fake[sub](args);
  return spawnSync(file,args,opts);
 };
 fn.calls=calls;return fn;
};
const statuses=r=>r.results.map(x=>x.status);

test('검사 절이 없는 카드: 출력·기록·종료 코드가 지금과 같다',()=>{
 const f=fixture();const before=f.store.get(f.key).revision;
 const r=f.done();
 assert.equal(r.status,0,r.stderr);
 assert.equal(r.stdout.trim().split('\n').length,1);assert.match(r.stdout,/^완료 확정: 역할=p-작업자 카드=card-a 결과=ok/);
 assert.doesNotMatch(r.stdout+r.stderr,/완료 검사/);
 assert.equal(f.store.get(f.key).revision,before);
 const again=f.done();assert.equal(again.status,2);assert.match(again.stderr,/이미 완료 확정됨/);assert.doesNotMatch(again.stdout+again.stderr,/완료 검사/);
});

test('고정 검사 4종이 보이고 카드 메모에 남지만 done은 그대로 확정된다 (막지 않음)',()=>{
 const f=fixture(['- file a.txt exists','- file nope.txt exists',`- git head . = ${'0'.repeat(40)}`,'- git tidy .','- 이건 검사 문법이 아님'].join('\n'));
 assert.deepEqual(f.store.get(f.key).completionChecks.length,5);
 const r=f.done();
 assert.equal(r.status,0,r.stderr);
 assert.match(r.stdout,/완료 확정: 역할=p-작업자 카드=card-a 결과=ok/);
 assert.match(r.stdout,/완료 검사 \(기준: 발령 때 저장한 검사 줄\): 통과 2·실패 2·읽지 못함 1/);
 assert.match(r.stdout,/\[통과\] file a\.txt exists/);
 assert.match(r.stdout,/\[실패\] file nope\.txt exists — 파일 없음/);
 assert.match(r.stdout,/\[실패\] git head \. — sha 다름/);
 assert.match(r.stdout,/\[통과\] git tidy \./);
 assert.match(r.stdout,/\[읽지 못함\] 줄 5 — 형식 오류/);
 assert.doesNotMatch(r.stdout,/next-section/); // 다음 절은 읽지 않는다
 assert.equal(f.doneRows().length,1);
 const notes=memos(f);assert.equal(notes.length,1);assert.equal(notes[0].noteKind,'progress');
 assert.equal(f.store.get(f.key).status,'assigned');
});

test('이미 완료 확정된 실행에도 검사 결과가 보이고, 같은 결과는 메모를 다시 적지 않으며, 종료 코드는 그대로다',()=>{
 const f=fixture('- file a.txt exists');
 assert.equal(f.done().status,0);const rev=f.store.get(f.key).revision;
 const again=f.done();
 assert.equal(again.status,2);assert.match(again.stderr,/이미 완료 확정됨/);
 assert.match(again.stdout,/완료 검사 .*: 통과 1·실패 0·읽지 못함 0/);
 assert.equal(f.store.get(f.key).revision,rev);assert.equal(memos(f).length,1);assert.equal(f.doneRows().length,1);
 fs.rmSync(path.join(f.repo,'a.txt'));
 const changed=f.done();assert.equal(changed.status,2);assert.match(changed.stdout,/통과 0·실패 1/);
 assert.equal(memos(f).length,2);
});

test('--close-card는 검사 뒤에도 카드를 닫고, 검사가 실패해도 막지 않는다',()=>{
 const f=fixture('- file nope.txt exists');
 const r=f.done('--close-card');
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/실패 1/);assert.match(r.stdout,/카드 닫기: 카드=repo\/card-a 상태=done/);
 assert.equal(f.store.get(f.key).status,'done');
});

test('kadan card check: 다시 돌려 보이고 같은 방식으로 기록한다',()=>{
 const f=fixture('- file a.txt exists');
 const r=f.run('card','check',f.key);
 assert.equal(r.status,0,r.stderr);
 const out=JSON.parse(r.stdout);assert.equal(out.summary,'통과 1·실패 0·읽지 못함 0');assert.equal(out.recorded,'recorded');
 assert.equal(JSON.parse(f.run('card','check',f.key).stdout).recorded,'same');
 const plain=fixture();assert.equal(JSON.parse(plain.run('card','check',plain.key).stdout).checks,0);
});

// ── 검수 탐침(PR #322 독립 검수 evidence)과 대응하는 시험 ──

test('outside-file-to-note: 범위 밖 file은 거절하고, 예전 command 줄로 밖의 파일을 읽지 못하며 메모에 내용이 없다',()=>{
 const f=fixture('x');const outside=tmp('kadan-cc-out-');
 const secret=path.join(outside,'FAKE_PRIVATE_FILENAME');fs.writeFileSync(secret,'FAKE_OUTSIDE_SECRET_8A15\n');
 const f2=fixture([`- file ${secret} sha256=${'a'.repeat(64)}`,`- file ${secret} exists`,`- command rg . ${secret} stdout~/^never$/`,`- command ls ${outside} stdout~/^never$/`].join('\n'));
 const r=f2.done();
 assert.equal(r.status,0,r.stderr);
 const notes=f2.store.get(f2.key).history.map(e=>String(e.note)).join('\n');
 // 파일 내용은 어디에도 없고, 화면·메모에는 밖 경로(파일 이름)도 적지 않는다. 저장된 검사 줄은 감독이 적은 데이터라 제외한다.
 assert.doesNotMatch(r.stdout+r.stderr+notes,/FAKE_OUTSIDE_SECRET|FAKE_PRIVATE_FILENAME/);
 assert.doesNotMatch(JSON.stringify(f2.store.get(f2.key).history),/FAKE_OUTSIDE_SECRET/);
 assert.match(r.stdout,/\[거절\] file \(저장소 밖 경로\) — 범위 밖/);
 assert.match(r.stdout,/읽지 못함 2·거절 2/);
 assert.ok(f);
});

test('git-content-output·git-upload-option-exec·git-dashdash-external-diff: 문법 밖 줄(command·url)은 읽지 못함이고 spawn 호출이 0회다',async()=>{
 const repo=repoDir();const marker=path.join(tmp('kadan-cc-marker-'),'ran');
 const lines=['command ls','command git show HEAD:a.txt','command git log -p --format=','command git ls-remote --upload-p=x .','command git diff -- a.txt',
  'command rg FAKE a.txt','command node -e 1','url https://example.test/a status=200','url http://127.0.0.1/ status=200','url http://169.254.169.254/ status=200',
  `command git status --porcelain stdout~/^$/ in ${repo}`];
 const spawn=recording();
 const report=await cc.runChecks(card(repo),lines,{spawn,fetchFn:()=>{fs.writeFileSync(marker,'x');return {status:200};}});
 assert.equal(spawn.calls.length,0);assert.equal(fs.existsSync(marker),false);
 assert.deepEqual(statuses(report),lines.map(()=>'unreadable'));
 assert.ok(report.results.every(r=>r.detail==='형식 오류'&&/^줄 \d+$/.test(r.label)),'줄 내용은 화면에 되풀이하지 않는다');
});

test('git-fsmonitor-exec: 남긴 고정 인자(core.fsmonitor·core.pager)가 감시 데몬과 pager를 띄우지 않는다',async()=>{
 const repo=repoDir(),dir=tmp('kadan-cc-hook-'),marker=path.join(dir,'ran');
 const prog=path.join(dir,'fake-prog');fs.writeFileSync(prog,`#!/bin/sh\necho x >> "${marker}"\n`,{mode:0o755});
 for(const [k,v] of [['core.fsmonitor',prog],['core.pager',prog]])git(repo,'config',k,v);
 const sha=headOf(repo);
 const report=await cc.runChecks(card(repo),['git tidy .',`git head . = ${sha}`],{});
 assert.equal(fs.existsSync(marker),false,'표식 프로그램이 실행됨');
 assert.deepEqual(statuses(report),['pass','pass']);
});

test('local-remote-and-overrides: 로컬 경로 원격(file 전송)·사용자 프록시 설정을 덮지 않는다 (고정 인자는 둘뿐)',async()=>{
 const repo=repoDir(),dir=tmp('kadan-cc-remote-'),bare=path.join(dir,'origin.git');
 git(dir,'init','-q','--bare',bare);git(repo,'remote','add','origin',bare);git(repo,'push','-q','origin','main');
 const report=await cc.runChecks(card(repo),['git pushed . main'],{});
 assert.deepEqual(statuses(report),['pass'],'로컬 경로 원격에 대한 push 확인이 실패함');
 assert.deepEqual(cc.GIT_FRONT_ARGS,['-c','core.fsmonitor=false','-c','core.pager=cat']);
 assert.equal(cc.gitEnv().GIT_ALLOW_PROTOCOL,undefined);
});

test('git-env-exec·path-exec: 환경의 GIT_CONFIG_*·PATH 앞의 가짜 git은 쓰이지 않고, git에는 최소 환경만 간다',async()=>{
 const repo=repoDir(),dir=tmp('kadan-cc-path-'),marker=path.join(dir,'ran');
 fs.writeFileSync(path.join(dir,'git'),`#!/bin/sh\necho x >> "${marker}"\nexit 0\n`,{mode:0o755});
 const prog=path.join(dir,'fake-prog');fs.writeFileSync(prog,`#!/bin/sh\necho y >> "${marker}"\n`,{mode:0o755});
 const saved={...process.env};
 Object.assign(process.env,{PATH:`${dir}:${process.env.PATH}`,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.fsmonitor',GIT_CONFIG_VALUE_0:prog,GIT_EXTERNAL_DIFF:prog,GIT_ALLOW_PROTOCOL:'ext',RIPGREP_CONFIG_PATH:prog});
 const spawn=recording();
 try {
  const report=await cc.runChecks(card(repo),['git tidy .'],{spawn});
  assert.equal(report.results[0].status,'pass');
 } finally { for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved); }
 assert.equal(fs.existsSync(marker),false,'가짜 git 또는 설정 프로그램이 실행됨');
 assert.ok(spawn.calls.length>0);
 for(const c of spawn.calls){
  assert.ok(path.isAbsolute(c.file)&&!c.file.startsWith(dir),`git 실행 파일: ${c.file}`);
  assert.deepEqual(Object.keys(c.opts.env).sort(),['GIT_OPTIONAL_LOCKS','GIT_TERMINAL_PROMPT','HOME','PATH']);
  assert.equal(c.opts.env.PATH,'/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin');assert.equal(c.opts.env.GIT_ALLOW_PROTOCOL,undefined);assert.equal(c.opts.env.GIT_CONFIG_NOSYSTEM,undefined);
  assert.deepEqual(c.args.slice(0,cc.GIT_FRONT_ARGS.length),cc.GIT_FRONT_ARGS);
  assert.equal(c.opts.shell,undefined);assert.equal(c.opts.stdio[0],'ignore');
 }
 assert.equal(cc.GIT_FRONT_ARGS.join(' '),'-c core.fsmonitor=false -c core.pager=cat');
 assert.ok(spawn.calls.some(c=>c.args.includes('worktree')),'worktree 목록도 같은 실행기를 지난다');
});

test('memo-growth: 검사는 20개까지만 돌리고 메모 길이에 상한이 있으며 생략 수를 보인다 (100줄 입력)',async()=>{
 const repo=repoDir();
 const lines=Array.from({length:100},(_,i)=>`file ${'long-name-'.repeat(12)}${i}.txt exists`);
 const spawn=recording();
 const report=await cc.runChecks(card(repo),lines,{spawn});
 assert.equal(report.results.length,20);assert.equal(report.omitted,80);
 assert.match(cc.formatReport(report),/20개 상한으로 80개 생략/);
 const f=fixture(lines.join('\n'));
 assert.equal(f.store.get(f.key).completionChecks.length,21); // 20개 + 넘침 표시 1줄
 const r=f.done();assert.equal(r.status,0,r.stderr);
 const [note]=memos(f);
 assert.ok(note.note.length<=cc.MAX_NOTE_CHARS,`메모 ${note.note.length}자`);
 assert.match(note.note,/20개 상한으로 80개 생략/);
});

test('assigned-source-mutation: 발령 뒤 바뀐 card.md는 무시한다 (발령 때 저장한 줄 기준)',()=>{
 const f=fixture('- file a.txt exists');
 const bodyPath=f.store.get(f.key).path;
 fs.writeFileSync(bodyPath,fs.readFileSync(bodyPath,'utf8').replace('file a.txt exists','file missing.txt exists'));
 const r=f.done();
 assert.equal(r.status,0,r.stderr);
 assert.match(r.stdout,/통과 1·실패 0/);assert.match(r.stdout,/\[통과\] file a\.txt exists/);
 assert.doesNotMatch(r.stdout,/missing/);
});

test('template-heading-mismatch: 카드 양식의 제목 그대로 쓴 절을 읽는다',()=>{
 const template=fs.readFileSync(templatePath,'utf8');
 const block=template.slice(template.indexOf('```markdown'));
 const heading=block.split('\n').find(l=>/^#{1,6}\s*완료 검사/.test(l));
 assert.ok(heading,'양식에 완료 검사 제목이 있다');
 assert.deepEqual(cc.checkLines(`# 카드\n\n${heading}\n- file a.txt exists\n\n## 다음\n- file b.txt exists\n`),['file a.txt exists']);
 assert.deepEqual(cc.checkLines('# t\n## 완료 검사\n- `file a exists`\n\n```\nfile b exists\n```\n<!-- 주석 -->\n## 끝\n- file c exists'),['file a exists']);
 assert.deepEqual(cc.checkLines('# t\n## 범위\n없음'),[]);
});

test('file-per-check-timeout-missing: 큰 파일은 읽지 않고 크기 초과로 실패한다 (상한을 작게 줘서 가짜 크기로 확인)',async()=>{
 const repo=repoDir();fs.writeFileSync(path.join(repo,'big.bin'),'0123456789');
 const readSpy=[];const realRead=fs.readFileSync;
 fs.readFileSync=(file,...rest)=>{if(String(file).endsWith('big.bin'))readSpy.push(file);return realRead.call(fs,file,...rest);};
 try {
  const report=await cc.runChecks(card(repo),[`file big.bin sha256=${'a'.repeat(64)}`,'file big.bin exists'],{maxFileBytes:4});
  assert.deepEqual(statuses(report),['fail','pass']);assert.equal(report.results[0].detail,'크기 초과');
  assert.equal(readSpy.length,0,'큰 파일 내용을 읽었다');
 } finally { fs.readFileSync=realRead; }
 assert.equal(cc.MAX_FILE_BYTES,64*1024*1024);
});

// ── 4종 각각의 통과·실패와 범위 ──

test('file: exists·sha256 통과와 실패',async()=>{
 const repo=repoDir();
 const sha=spawnSync('shasum',['-a','256',path.join(repo,'a.txt')],{encoding:'utf8'}).stdout.split(' ')[0];
 const report=await cc.runChecks(card(repo),['file a.txt exists','file nope exists',`file a.txt sha256=${sha}`,`file a.txt sha256=${'0'.repeat(64)}`,'file . sha256='+sha]);
 assert.deepEqual(statuses(report),['pass','fail','pass','fail','unreadable'].map((s,i)=>i===4?'fail':s));
 assert.deepEqual(report.results.map(r=>r.detail),['','파일 없음','','sha 다름','파일 없음']);
});

test('git head: 앞부분 일치 통과, 다르면 sha 다름, 폴더가 아니면 실패',async()=>{
 const repo=repoDir(),sha=headOf(repo);
 const report=await cc.runChecks(card(repo),[`git head . = ${sha}`,`git head . = ${sha.slice(0,7).toUpperCase()}`,`git head . = ${'1'.repeat(40)}`,`git head a.txt = ${sha}`,'git head . = xyz','git head . = abc']);
 assert.deepEqual(statuses(report),['pass','pass','fail','fail','unreadable','unreadable']);
 assert.equal(report.results[2].detail,'sha 다름');
});

test('git pushed: 고정 argv로 원격 끝과 로컬 HEAD를 비교하고, 없거나 다르면 이유를 적는다 (예외로 끝나지 않음)',async()=>{
 const repo=repoDir(),sha=headOf(repo);
 let remote=`${sha}\trefs/heads/feat/x\n`;
 const spawn=recording({'ls-remote':()=>({status:0,stdout:remote,stderr:''})});
 const one=async()=>(await cc.runChecks(card(repo),['git pushed . feat/x'],{spawn})).results[0];
 assert.equal((await one()).status,'pass');
 const call=spawn.calls.find(c=>c.args.includes('ls-remote'));
 assert.deepEqual(call.args,[...cc.GIT_FRONT_ARGS,'ls-remote','origin','refs/heads/feat/x']);
 remote=`${'2'.repeat(40)}\trefs/heads/feat/x\n`;
 assert.deepEqual([(await one()).status,(await one()).detail],['fail','sha 다름']);
 remote='';
 assert.deepEqual([(await one()).status,(await one()).detail],['fail','원격에 없음']);
 remote=`${sha}\trefs/heads/other/feat/x\n`; // 같은 이름 꼬리 다른 ref는 같은 브랜치가 아니다
 assert.equal((await one()).detail,'원격에 없음');
 const broken=recording({'ls-remote':()=>({status:128,stdout:'FATAL secret detail',stderr:'x'})});
 const failed=(await cc.runChecks(card(repo),['git pushed . feat/x'],{spawn:broken})).results[0];
 assert.deepEqual([failed.status,failed.detail],['fail','실행 실패']);assert.doesNotMatch(JSON.stringify(failed),/secret/);
 const hung=recording({'ls-remote':()=>({error:{code:'ETIMEDOUT'},status:null})});
 assert.equal((await cc.runChecks(card(repo),['git pushed . feat/x'],{spawn:hung})).results[0].status,'timeout');
});

test('git pushed: 형식 검사를 통과한 브랜치 이름만 받고, 나쁜 이름은 원격을 부르지 않는다',async()=>{
 const repo=repoDir();const spawn=recording({'ls-remote':()=>({status:0,stdout:''})});
 const bad=['-x','--upload-pack=x','a..b','a;b','a b','a/','a.lock','@{-1}','a@{u}','refs/../x','a~1','a:b','a*','a?'];
 const report=await cc.runChecks(card(repo),bad.map(b=>`git pushed . ${b}`),{spawn});
 assert.ok(report.results.every(r=>r.status==='unreadable'),JSON.stringify(report.results));
 assert.equal(spawn.calls.length,0);
});

test('git tidy: 깨끗하면 통과, 바뀐 파일·새 파일이 있으면 변경 있음 (파일 이름은 남기지 않음)',async()=>{
 const repo=repoDir();
 assert.equal((await cc.runChecks(card(repo),['git tidy .'])).results[0].status,'pass');
 fs.writeFileSync(path.join(repo,'SECRET_NEW_FILE.txt'),'x');
 const dirty=(await cc.runChecks(card(repo),['git tidy .'])).results[0];
 assert.deepEqual([dirty.status,dirty.detail],['fail','변경 있음']);assert.doesNotMatch(JSON.stringify(dirty),/SECRET_NEW_FILE/);
 fs.rmSync(path.join(repo,'SECRET_NEW_FILE.txt'));fs.appendFileSync(path.join(repo,'a.txt'),'more');
 assert.equal((await cc.runChecks(card(repo),['git tidy .'])).results[0].detail,'변경 있음');
});

test('범위 밖 경로는 거절한다: .., 심볼릭 링크, 등록 안 된 worktree·저장소 (git도 부르지 않음)',async()=>{
 const repo=repoDir(),outside=tmp('kadan-cc-out-');
 fs.writeFileSync(path.join(outside,'secret.txt'),'x');
 fs.symlinkSync(outside,path.join(repo,'link'));
 const stray=repoDir();
 const spawn=recording();
 const report=await cc.runChecks(card(repo),['file ../x exists','file link/secret.txt exists',`file ${outside}/secret.txt exists`,`git tidy ${stray}`,`git head ${stray} = ${headOf(stray)}`,'git tidy /tmp/../tmp','file a.txt exists'],{spawn});
 assert.deepEqual(statuses(report),['denied','denied','denied','denied','denied','denied','pass']);
 assert.ok(report.results.slice(0,6).every(r=>r.detail==='범위 밖'&&!r.label.includes(outside)&&!r.label.includes(stray)));
 assert.ok(!spawn.calls.some(c=>c.args.includes('status')||c.args.includes('rev-parse')),'범위 밖 폴더에서 git이 불렸다');
});

test('등록된 worktree는 file·git 경로로 받는다',async()=>{
 const repo=repoDir(),wt=path.join(tmp('kadan-cc-wt-'),'wt');
 assert.equal(git(repo,'worktree','add','-q','-b','side',wt).status,0);
 fs.writeFileSync(path.join(wt,'b.txt'),'bee');
 const report=await cc.runChecks(card(repo),[`file ${wt}/b.txt exists`,`git head ${wt} = ${headOf(wt)}`,`git tidy ${wt}`]);
 assert.deepEqual(statuses(report),['pass','pass','fail']); // b.txt가 새 파일이라 깨끗하지 않다
 assert.equal(report.results[2].detail,'변경 있음');assert.match(report.results[0].label,/^file wt:b\.txt exists$/);
});

test('시간 초과: 검사당 상한과 전체 상한(넘으면 나머지는 건너뜀)',async()=>{
 const repo=repoDir();let clock=0;
 const slow=recording({status:()=>{clock+=70_000;return {status:0,stdout:''};}});
 const total=await cc.runChecks(card(repo),['git tidy .','git tidy .','git tidy .','file a.txt exists','bad line'],{spawn:slow,now:()=>clock});
 assert.deepEqual(statuses(total),['timeout','timeout','skipped','skipped','unreadable']); // 70초 걸린 검사는 마감을 넘겼으니 통과로 치지 않는다
 assert.equal(slow.calls.filter(c=>c.args.includes('status'))[1].opts.timeout,30000); // 두 번째 검사: 검사당 30초, 전체 남은 50초 중 이른 쪽
 assert.equal(cc.summarize(total.results),'통과 0·실패 2·읽지 못함 1·건너뜀 2');
 const hung=recording({status:()=>({error:{code:'ETIMEDOUT'},status:null})});
 const per=await cc.runChecks(card(repo),['git tidy .','git tidy .'],{spawn:hung,perMs:25});
 assert.deepEqual(statuses(per),['timeout','timeout']);{const t=hung.calls.find(c=>c.args.includes('status')).opts.timeout;assert.ok(t>0&&t<=25,`timeout ${t}`);}
 assert.equal(cc.PER_CHECK_MS,30000);assert.equal(cc.TOTAL_MS,120000);
});

test('문법: 네 종류만 읽고 나머지는 형식 오류',()=>{
 for(const ok of ['file a exists','file a sha256='+'a'.repeat(64),'git head . = abcdef1','git pushed . feat/x','git tidy /abs/path'])assert.ok(!cc.parseCheck(ok).error,ok);
 for(const bad of ['hello','command ls','url https://x status=200','file a','file a sha256=abc','git head . = zz','git head .','git pushed .','git tidy','git status','git head . abc1234 extra'])assert.ok(cc.parseCheck(bad).error,bad);
});

// ---- 3라운드: 위협 범위(카드 글은 막고 저장소 설정은 작업자와 같은 신뢰) 뒤의 남은 버그 ----

test('credential-helper-compatibility: 고정 앞 인자·환경에서도 사용자의 인증 도우미가 인증을 돌려준다',()=>{
 const repo=repoDir(),dir=tmp('kadan-cc-cred-');
 const helper=path.join(dir,'helper');fs.writeFileSync(helper,'#!/bin/sh\necho username=fake-user\necho password=fake-pass\n',{mode:0o755});
 git(repo,'config','credential.helper',`!${helper}`);
 const r=spawnSync(cc.gitBinary(),[...cc.GIT_FRONT_ARGS,'credential','fill'],{cwd:repo,env:{...cc.gitEnv(),HOME:dir},input:'protocol=https\nhost=example.test\n\n',encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/password=fake-pass/);
 const keys=cc.GIT_FRONT_ARGS.filter((_,i)=>i%2===1).map(a=>a.split('=')[0]);
 for(const gone of ['credential.helper','core.sshCommand'])assert.ok(!keys.includes(gone),`${gone}를 덮어쓰면 정상 인증·ssh 설정이 깨진다`);
 for(const kept of ['core.fsmonitor','core.pager'])assert.ok(keys.includes(kept),kept);
 assert.equal(cc.gitEnv().GIT_TERMINAL_PROMPT,'0');assert.equal(cc.gitEnv().GIT_OPTIONAL_LOCKS,'0');
});

test('fence-state: 본문 첫 줄부터 코드 블록 상태를 추적한다 (outer-fence-heading·tilde-fence·여닫는 길이)',()=>{
 // 다른 절의 예제 펜스 안에 든 제목은 절이 아니다
 assert.deepEqual(cc.checkLines('# t\n## 예시\n```markdown\n## 완료 검사\nfile a.txt exists\n```\n'),[]);
 assert.deepEqual(cc.checkLines('# t\n## 예시\n~~~\n## 완료 검사\nfile a.txt exists\n~~~\n\n## 완료 검사\n- file real.txt exists\n'),['file real.txt exists']);
 // 절 안의 ~~~ 펜스도 건너뛴다
 assert.deepEqual(cc.checkLines('## 완료 검사\n- file a exists\n~~~\nfile b exists\n~~~\n- file c exists\n'),['file a exists','file c exists']);
 // 닫는 줄은 같은 글자에 같거나 긴 길이만: 짧은 ```는 ```` 를 닫지 못하고, 펜스 안의 제목은 절을 끝내지 못한다
 assert.deepEqual(cc.checkLines('## 완료 검사\n````\n```\nfile b exists\n```\n## 가짜\n````\n- file c exists\n'),['file c exists']);
 // 다른 글자는 닫지 못한다
 assert.deepEqual(cc.checkLines('## 완료 검사\n```\n~~~\nfile b exists\n~~~\n```\n- file c exists\n'),['file c exists']);
 // 닫히지 않은 펜스는 끝까지 무시한다
 assert.deepEqual(cc.checkLines('## 완료 검사\n- file a exists\n```\nfile b exists\n'),['file a exists']);
});

test('time-budget: git을 부르기 직전마다 남은 시간을 다시 계산하고, 마감을 넘기면 시간 초과다',async()=>{
 const repo=repoDir(),sha=headOf(repo);
 let clock=0;
 const adv=(ms,make)=>args=>{clock+=ms;return make(args);};
 // (a) pushed: 하위 명령마다 20초. 검사당 30초 안에서 남은 시간만 넘기고, 마감 뒤에는 다음 명령을 부르지 않는다
 const spawn=recording({
  'rev-parse':adv(20_000,()=>({status:0,stdout:`${sha}\n`})),
  'check-ref-format':adv(20_000,args=>({status:0,stdout:`${args.at(-1)}\n`})),
  'ls-remote':adv(20_000,args=>({status:0,stdout:`${sha}\t${args.at(-1)}\n`})),
 });
 const a=await cc.runChecks(card(repo),['git pushed . main'],{spawn,now:()=>clock});
 assert.deepEqual(statuses(a),['timeout']);
 const timeoutOf=sub=>spawn.calls.find(c=>c.args.includes(sub))?.opts.timeout;
 assert.ok(timeoutOf('rev-parse')<=30_000);assert.ok(timeoutOf('check-ref-format')<=10_000,`check-ref-format ${timeoutOf('check-ref-format')}ms`);
 assert.equal(spawn.calls.filter(c=>c.args.includes('ls-remote')).length,0,'마감 뒤에 원격을 불렀다');
 // (b) 마지막 하위 명령이 마감을 넘겨 돌아와도 통과로 치지 않는다
 clock=0;
 const b=await cc.runChecks(card(repo),['git tidy .'],{spawn:recording({status:adv(31_000,()=>({status:0,stdout:''}))}),now:()=>clock});
 assert.deepEqual(statuses(b),['timeout']);
 // (c) worktree 목록 조회도 전체 120초 예산에 든다
 clock=0;
 const c=recording({worktree:adv(115_000,()=>({status:0,stdout:''})),status:adv(0,()=>({status:0,stdout:''}))});
 const res=await cc.runChecks(card(repo),['git tidy .'],{spawn:c,now:()=>clock,perMs:200_000});
 assert.deepEqual(statuses(res),['pass']);
 const wt=c.calls.find(x=>x.args.includes('worktree')).opts.timeout,st=c.calls.find(x=>x.args.includes('status')).opts.timeout;
 assert.ok(wt<=120_000);assert.ok(st<=5_000,`status ${st}ms (worktree 조회 뒤 남은 전체 시간은 5초)`);
});

test('time-budget: worktree 조회가 마감을 넘기면 그 검사는 시간 초과이고 git 검사는 돌지 않는다',async()=>{
 const repo=repoDir();let clock=0;
 const spawn=recording({worktree:()=>{clock+=40_000;return {error:{code:'ETIMEDOUT'},status:null,stdout:''};}});
 const res=await cc.runChecks(card(repo),['git tidy .','file a.txt exists'],{spawn,now:()=>clock});
 assert.equal(res.results[0].status,'timeout');
 assert.equal(spawn.calls.filter(c=>c.args.includes('status')).length,0);
});

test('count-and-cap: 발령 때 전체 줄 수를 저장해 생략 수가 정확하고, 메모는 생략 안내를 더해도 상한을 넘지 않는다',async()=>{
 const f=fixture(Array.from({length:100},(_,i)=>`file f${i}.txt exists`).join('\n'));
 const stored=f.store.get(f.key);
 assert.equal(stored.completionChecks.length,21);assert.equal(stored.completionChecksTotal,100);
 const r=f.done();assert.equal(r.status,0,r.stderr);
 assert.match(r.stdout,/20개 상한으로 80개 생략/);assert.match(memos(f)[0].note,/20개 상한으로 80개 생략/);
 // 긴 줄 25개: 본문을 자른 뒤 안내를 덧붙이면 4000자를 넘던 경우
 const g=fixture('- file a.txt exists'),repo=g.repo,sha=headOf(repo);
 const lines=Array.from({length:25},(_,i)=>`git pushed . ${'b'.repeat(190)}${String(i).padStart(2,'0')}`);
 const spawn=recording({
  'rev-parse':()=>({status:0,stdout:`${sha}\n`}),
  'check-ref-format':args=>({status:0,stdout:`${args.at(-1)}\n`}),
  'ls-remote':args=>({status:0,stdout:`${sha}\t${args.at(-1)}\n`}),
 });
 const report=await cc.runChecks(card(repo),lines,{spawn,total:25});
 assert.equal(report.omitted,5);
 assert.equal(cc.recordReport(g.store,g.key,report,'p-감독'),'recorded');
 const note=memos(g)[0].note;
 assert.ok(note.length<=cc.MAX_NOTE_CHARS,`메모 ${note.length}자`);assert.match(note,/메모 길이 상한으로 생략/);
});
