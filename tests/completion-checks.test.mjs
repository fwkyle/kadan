import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {CardStore} from '../src/card-store.mjs';
import {appendLedger,readLedger} from '../src/ledger.mjs';
import {checkLines,denyReason,parseCheck,runChecks,summarize} from '../src/completion-checks.mjs';

const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
const rally={rallyId:'r1',rallyTitle:'묶음',rallyRound:'1',rallyStep:'implementation'};
const git=(cwd,...args)=>spawnSync('git',['-c','user.email=t@example.test','-c','user.name=t',...args],{cwd,encoding:'utf8'});

function repoDir() {
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'kadan-cc-repo-')));
 git(dir,'init','-q','-b','main');fs.writeFileSync(path.join(dir,'a.txt'),'hello\n');
 git(dir,'add','a.txt');git(dir,'commit','-q','-m','first');
 return dir;
}
function fixture(section) {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-cc-home-')),repo=repoDir(),store=new CardStore(home);
 const body=`# 검사 카드\n\n## 범위\n로컬\n${section===undefined?'':`\n## 완료 검사\n${section}\n\n## 다음 절\n- command ls stdout~/nothing/\n`}`;
 const created=store.create({repo:'repo',id:'card-a',repoPath:repo,body,by:'사람'});
 const card=store.update(created.key,{status:'assigned',scope:'로컬 구현만',board:'b',role:'p-작업자',...rally},{revision:1,note:'배정'});
 appendLedger({kind:'start',role:'p-작업자',session:'kadan-p-작업자',t:new Date().toISOString()},home);
 const run=(...args)=>spawnSync(process.execPath,[cli,...args],{env:{...process.env,KADAN_HOME:home,KADAN_LITE_HOME:'',KADAN_ROLE:'p-감독'},encoding:'utf8',timeout:30000});
 return {home,repo,store,key:card.key,run,done:(...a)=>run('done','p-작업자','card-a','ok',...a),doneRows:()=>readLedger(home).filter(e=>e.kind==='done')};
}
const memos=f=>f.store.get(f.key).history.filter(e=>String(e.note).startsWith('완료 검사:'));

test('검사 절이 없는 카드: 출력·기록·종료 코드가 지금과 같다',()=>{
 const f=fixture();const before=f.store.get(f.key).revision;
 const r=f.done();
 assert.equal(r.status,0,r.stderr);
 assert.equal(r.stdout.trim().split('\n').length,1);assert.match(r.stdout,/^완료 확정: 역할=p-작업자 카드=card-a 결과=ok/);
 assert.doesNotMatch(r.stdout+r.stderr,/완료 검사/);
 assert.equal(f.store.get(f.key).revision,before);
 const again=f.done();assert.equal(again.status,2);assert.match(again.stderr,/이미 완료 확정됨/);assert.doesNotMatch(again.stdout+again.stderr,/완료 검사/);
});

test('검사 절이 있는 카드: 통과·실패·읽지 못함 줄이 보이고 카드 메모에 남지만 done은 그대로 확정된다',()=>{
 const f=fixture(['- command git rev-parse HEAD stdout~/^[0-9a-f]{40}$/','- command git rev-parse HEAD stdout~/^zzz$/','- file a.txt exists','- 이건 검사 문법이 아님','- command node -e 1'].join('\n'));
 const r=f.done();
 assert.equal(r.status,0,r.stderr);
 assert.match(r.stdout,/완료 확정: 역할=p-작업자 카드=card-a 결과=ok/);
 assert.match(r.stdout,/완료 검사 \(기준: 카드 저장소 본문\(card\.md\)\): 통과 2·실패 1·읽지 못함 2/);
 assert.match(r.stdout,/\[통과\] command git rev-parse HEAD stdout~\/\^\[0-9a-f\]\{40\}\$\//);
 assert.match(r.stdout,/\[실패\] command git rev-parse HEAD stdout~\/\^zzz\$\//);
 assert.match(r.stdout,/\[읽지 못함\] 이건 검사 문법이 아님/);
 assert.match(r.stdout,/\[허용 안 됨\] command node -e 1 — 허용 안 됨: node/);
 assert.doesNotMatch(r.stdout,/nothing/); // 다음 절은 읽지 않는다
 assert.equal(f.doneRows().length,1);
 const notes=memos(f);assert.equal(notes.length,1);assert.equal(notes[0].noteKind,'progress');
 assert.match(notes[0].note,/^완료 검사: 통과 2·실패 1·읽지 못함 2/);
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

const spy=(impl)=>{const calls=[];const fn=(...a)=>{calls.push(a);return impl?impl(...a):{status:0,stdout:''};};fn.calls=calls;return fn;};
const card=(repoPath)=>({repoPath});

test('허용 안 된 프로그램·git 쓰기·옵션 우회는 실행하지 않고 거절한다 (spawn 호출 0회)',async()=>{
 const repo=repoDir();
 const lines=['command node -e 1','command sh -c ls','command bash -c ls','command npm test','command /bin/ls','command git push origin main',
  'command git -c alias.x=!ls x','command git -C /tmp status','command git commit -m x','command git branch newname','command git branch -D old',
  'command git diff --output=/tmp/x','command rg --pre cat foo','command rg -z foo','command git ls-remote --upload-pack=x origin'];
 const spawn=spy();
 const report=await runChecks(card(repo),lines,{spawn});
 assert.equal(spawn.calls.length,0);
 assert.deepEqual(report.results.map(r=>r.status),lines.map(()=>'denied'));
 assert.match(report.results[0].detail,/허용 안 됨: node/);assert.match(report.results[5].detail,/git push/);
 assert.equal(denyReason(['git','branch','--list','feat/*']),null);
 for(const ok of [['git','status'],['git','log','-1'],['git','rev-parse','HEAD'],['git','ls-remote','origin','x'],['rg','-n','foo'],['ls'],['test','-f','a']])assert.equal(denyReason(ok),null,ok.join(' '));
});

test('git diff·show·log에는 외부 diff 우회를 끄는 옵션이 붙고 셸 없이 argv로 돈다',async()=>{
 const repo=repoDir();const spawn=spy();
 await runChecks(card(repo),['command git diff --stat'],{spawn});
 const [file,args,opts]=spawn.calls[0];
 assert.equal(file,'git');assert.deepEqual(args,['diff','--stat','--no-ext-diff','--no-textconv']);
 assert.equal(opts.shell,undefined);assert.equal(opts.cwd,repo);assert.equal(opts.timeout,30000);assert.equal(opts.stdio[0],'ignore');
});

test('범위 밖 경로는 거절한다: .., 심볼릭 링크, 등록 안 된 worktree',async()=>{
 const repo=repoDir(),outside=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'kadan-cc-out-')));
 fs.writeFileSync(path.join(outside,'secret.txt'),'x');
 fs.symlinkSync(outside,path.join(repo,'link'));
 const stray=repoDir();
 const spawn=spy((file,args)=>file==='git'&&args.includes('worktree')?spawnSync(file,args,{encoding:'utf8'}):{status:0,stdout:''});
 const report=await runChecks(card(repo),['file ../x exists','file link/secret.txt exists',`file ${outside}/secret.txt exists`,`command ls in ${stray}`,'command ls in /tmp/../tmp','file a.txt exists'],{spawn});
 assert.deepEqual(report.results.map(r=>r.status),['denied','denied','denied','denied','denied','pass']);
 assert.ok(!spawn.calls.some(c=>c[0]==='ls'),'ls는 불리지 않아야 한다');
});

test('등록된 worktree는 실행 폴더와 file 경로로 받는다',async()=>{
 const repo=repoDir(),wt=path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'kadan-cc-wt-'))),'wt');
 assert.equal(git(repo,'worktree','add','-q','-b','side',wt).status,0);
 fs.writeFileSync(path.join(wt,'b.txt'),'bee');
 const sha=spawnSync('shasum',['-a','256',path.join(wt,'b.txt')],{encoding:'utf8'}).stdout.split(' ')[0];
 const report=await runChecks(card(repo),[`command git rev-parse --abbrev-ref HEAD stdout~/^side$/ in ${wt}`,`file ${wt}/b.txt sha256=${sha}`,`file ${wt}/b.txt sha256=${'0'.repeat(64)}`]);
 assert.deepEqual(report.results.map(r=>r.status),['pass','pass','fail']);
});

test('시간 초과: 검사당 상한과 전체 상한(넘으면 나머지는 건너뜀)',async()=>{
 const repo=repoDir();let clock=0;
 const slow=spy(()=>{clock+=70_000;return {status:0,stdout:''};});
 const total=await runChecks(card(repo),['command ls','command ls','command ls','file a.txt exists','bad line'],{spawn:slow,now:()=>clock});
 assert.deepEqual(total.results.map(r=>r.status),['pass','pass','skipped','skipped','unreadable']);
 assert.equal(slow.calls[1][2].timeout,30000);
 assert.equal(summarize(total.results),'통과 2·실패 0·읽지 못함 1·건너뜀 2');
 const hung=spy(()=>({error:{code:'ETIMEDOUT'},status:null}));
 const per=await runChecks(card(repo),['command ls','command ls'],{spawn:hung,perMs:25});
 assert.deepEqual(per.results.map(r=>r.status),['timeout','timeout']);assert.equal(hung.calls[0][2].timeout,25);
 const fetchFn=(url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))));
 const net=await runChecks(card(repo),['url https://example.test/a status=200'],{fetchFn,perMs:20});
 assert.equal(net.results[0].status,'timeout');
});

test('url: 가짜 fetch로 상태 숫자를 비교하고 리디렉션을 따르지 않는다',async()=>{
 const seen=[];
 const fetchFn=async(url,opts)=>{seen.push([url,opts.redirect,opts.method]);return {status:url.endsWith('/ok')?200:404};};
 const report=await runChecks(card(repoDir()),['url https://example.test/ok status=200','url http://example.test/gone status=200','url ftp://x status=200'],{fetchFn});
 assert.deepEqual(report.results.map(r=>r.status),['pass','fail','unreadable']);
 assert.deepEqual(seen[0],['https://example.test/ok','manual','GET']);
});

test('문법이 틀린 줄은 읽지 못함으로 보인다',()=>{
 for(const bad of ['hello','command','file a.txt','file a.txt sha256=abc','url https://x status=2000','command ls stdout~/(/','url file:///etc/passwd status=200'])assert.ok(parseCheck(bad).error,bad);
 assert.deepEqual(checkLines('# t\n## 완료 검사\n- `command ls`\n\n```\nfile a exists\n```\n## 끝\n- command rg x'),['command ls','file a exists']);
 assert.deepEqual(checkLines('# t\n## 범위\n없음'),[]);
});
