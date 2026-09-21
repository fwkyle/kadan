import test from 'node:test';import assert from 'node:assert/strict';
import {cycleStatus,watchVerdict,buildCycleEntry,cycleRecordDue,CYCLE_RECORD_MS} from '../src/watch-cycle.mjs';
import {readWatchProfile,applyWatchProfile,watchStartupWarnings} from '../src/watch-profile.mjs';
const now=Date.parse('2026-09-12T11:00:00Z');
const at=minutesAgo=>new Date(now-minutesAgo*60_000).toISOString();
const cycle=(minutesAgo,extra={})=>({kind:'watch-cycle',by:'watch',pid:7,t:at(minutesAgo),hierarchy:'/h.json',judge:true,ok:true,...extra});
const worker={pid:7,startedAt:at(600)};

test('주기 기록은 5분마다 한 번이고 설정·대상 수를 함께 남긴다',()=>{
 assert.equal(cycleRecordDue(null,now),true);assert.equal(cycleRecordDue(now-CYCLE_RECORD_MS+1,now),false);assert.equal(cycleRecordDue(now-CYCLE_RECORD_MS,now),true);
 const entry=buildCycleEntry({pid:7,hierarchyPath:'/h.json',hierarchyHash:'abc',judge:'bash judge.sh',profile:'/p.json',intervalMs:60000,sessions:['a','b'],supervisorSessions:['s'],ok:true});
 assert.deepEqual(entry,{kind:'watch-cycle',by:'watch',pid:7,hierarchy:'/h.json',hierarchyHash:'abc',judge:true,profile:'/p.json',intervalMs:60000,sessions:2,supervisorSessions:1,ok:true});
 assert.equal(buildCycleEntry({pid:7}).sessions,null);
});
test('마지막 주기·설정·공백을 현재 감시기 기준으로 읽고 기록이 없으면 모름이다',()=>{
 const ok=cycleStatus([cycle(4)],worker,now);
 assert.equal(ok.state,'ok');assert.deepEqual(ok.settings,{hierarchy:'/h.json',judge:true,profile:null,intervalMs:null});assert.deepEqual(ok.gaps,[]);assert.equal(ok.gapMinutes,0);
 assert.equal(cycleStatus([cycle(20)],worker,now).state,'stale');
 assert.equal(cycleStatus([cycle(3,{ok:false})],worker,now).state,'error');
 assert.equal(cycleStatus([cycle(3,{pid:6})],worker,now).state,'unknown');
 assert.equal(cycleStatus([cycle(3,{pid:7,t:at(700)})],worker,now).state,'unknown');
 assert.equal(cycleStatus([],{pid:7,startedAt:at(1)},now).state,'starting');
 const none=cycleStatus([],worker,now);assert.equal(none.state,'unknown');assert.equal(none.gaps,null);assert.equal(none.gapMinutes,null);
 assert.equal(cycleStatus([{broken:'x'}],worker,now).state,'unknown');
 const absent=cycleStatus([cycle(120)],null,now);assert.equal(absent.state,'absent');assert.equal(absent.lastAt,at(120));assert.equal(absent.gaps.length,1);assert.equal(absent.gaps[0].minutes,120);
});
test('공백은 첫 기록 이후 15분 넘게 비어 있는 구간만 세고 기록 이전 시간은 공백으로 꾸미지 않는다',()=>{
 const entries=[cycle(400),cycle(395),cycle(200),cycle(195),cycle(3)];
 const s=cycleStatus(entries,worker,now);
 assert.deepEqual(s.gaps.map(g=>g.minutes),[195,192]);assert.equal(s.gapMinutes,387);
 assert.equal(s.gaps[0].from,at(395));assert.equal(s.gaps[0].to,at(200));
 const old=[cycle(30*60),cycle(30*60-5)];
 assert.equal(cycleStatus(old,worker,now).gaps[0].minutes,24*60);
});
test('한 줄 판정은 설정 빠짐·없음·지연·정상을 구분하고 정식 명령을 알려준다',()=>{
 const base={process:{state:'running',instances:[{pid:7}]},configuration:{state:'matched',reason:'지문 일치'},profilePath:'/home/watch-profile.json'};
 const ok=watchVerdict({...base,cycle:cycleStatus([cycle(2)],worker,now)},now);
 assert.equal(ok.level,'ok');assert.match(ok.text,/^감시 정상 · 관계 파일 반영 · AI 판정 켜짐 · 마지막 주기 2분 전$/);
 const bare=watchVerdict({...base,configuration:{state:'missing',reason:'없음'},cycle:cycleStatus([cycle(2,{hierarchy:null,judge:false})],worker,now)},now);
 assert.equal(bare.level,'warn');assert.match(bare.text,/감시 설정 빠짐 · 관계 파일 없음 · AI 판정 꺼짐/);assert.match(bare.hints[0],/kadan watch --profile \/home\/watch-profile.json/);
 const stale=watchVerdict({...base,cycle:cycleStatus([cycle(40)],worker,now)},now);
 assert.equal(stale.level,'warn');assert.match(stale.text,/감시 주기 지연 · 마지막 주기 40분 전/);assert.match(stale.text,/공백 40분/);
 const absent=watchVerdict({...base,process:{state:'absent',instances:[]},cycle:cycleStatus([cycle(130)],null,now)},now);
 assert.equal(absent.level,'bad');assert.match(absent.text,/^감시기 없음 · 마지막 주기 \d{2}:\d{2} \(2시간 10분 전\) · 최근 24시간 공백 2시간 10분/);
 const old=watchVerdict({...base,configuration:{state:'missing',reason:'기록 없음'},cycle:cycleStatus([],worker,now)},now);
 assert.equal(old.level,'warn');assert.match(old.text,/감시기 설정 확인 불가 · 주기 기록 없음/);
 assert.equal(watchVerdict({...base,process:{state:'duplicate',instances:[{pid:7},{pid:8}]},cycle:cycleStatus([],null,now)},now).level,'bad');
 assert.equal(watchVerdict({...base,process:{state:'unknown',instances:[],error:'ps 실패'},cycle:cycleStatus([],null,now)},now).level,'unknown');
 assert.equal(watchVerdict({...base,profilePath:null,configuration:{state:'missing'},cycle:cycleStatus([cycle(1,{hierarchy:null})],worker,now)},now).hints[0],'정식 명령에 --hierarchy와 --judge-cmd를 붙여 다시 띄우세요');
});
test('감시 프로필은 빈 옵션만 채우고 직접 준 옵션·환경을 덮지 않으며 형식 오류는 거부한다',()=>{
 const text=JSON.stringify({flags:{route:['p=p-감독'],super:'슈퍼감독',hierarchy:'rel.json','judge-cmd':'bash judge.sh','start-report-after':5,'user-notify':true},env:{KADAN_JUDGE_MODEL:'m1'}});
 const p=readWatchProfile('/tmp/kadan-profile/watch-profile.json',()=>text);
 assert.equal(p.flags.hierarchy,'/tmp/kadan-profile/rel.json');assert.deepEqual(p.flags.route,['p=p-감독']);assert.equal(p.flags['start-report-after'],'5');assert.equal(p.flags['user-notify'],true);
 const flags={hierarchy:'/mine.json'},env={KADAN_JUDGE_MODEL:''};
 const applied=applyWatchProfile(flags,p,env);
 assert.equal(flags.hierarchy,'/mine.json');assert.equal(flags.super,'슈퍼감독');assert.equal(env.KADAN_JUDGE_MODEL,'m1');
 assert.deepEqual(applied,['--route','--super','--judge-cmd','--start-report-after','--user-notify','KADAN_JUDGE_MODEL']);
 assert.deepEqual(applyWatchProfile({},{flags:{},env:{KADAN_JUDGE_MODEL:'m2'}},{KADAN_JUDGE_MODEL:'keep'}),[]);
 assert.throws(()=>readWatchProfile('/x.json',()=>'{'),/읽기 실패/);
 assert.throws(()=>readWatchProfile('/x.json',()=>'[]'),/형식 오류/);
 assert.throws(()=>readWatchProfile('/x.json',()=>JSON.stringify({flags:{port:1}})),/모르는 옵션: --port/);
 assert.throws(()=>readWatchProfile('/x.json',()=>JSON.stringify({flags:{'user-notify':'yes'}})),/true만 허용/);
 assert.throws(()=>readWatchProfile('/x.json',()=>JSON.stringify({env:{A:1}})),/문자열이어야/);
});
test('시작 경고는 관계 파일·AI 판정 누락과 저장된 프로필을 알린다',()=>{
 const lines=watchStartupWarnings({},{defaultProfile:'/home/watch-profile.json',exists:()=>true});
 assert.equal(lines.length,3);assert.match(lines[0],/--hierarchy 없음/);assert.match(lines[1],/--judge-cmd 없음/);assert.match(lines[2],/kadan watch --profile \/home\/watch-profile.json/);
 assert.deepEqual(watchStartupWarnings({hierarchy:'/h.json','judge-cmd':'x'},{defaultProfile:'/home/watch-profile.json',exists:()=>true}),[]);
 assert.equal(watchStartupWarnings({},{profileFile:'/home/watch-profile.json',defaultProfile:'/home/watch-profile.json',exists:()=>true}).length,2);
 assert.equal(watchStartupWarnings({},{defaultProfile:'/home/watch-profile.json',exists:()=>false}).length,2);
});
test('감시 루프는 첫 주기와 5분마다 watch-cycle을 남기고 관계 파일·AI 판정 유무를 그대로 적는다',async()=>{
 const {runWatch}=await import('./helpers/watch-runner.mjs');
 const os=await import('node:os');const oldLoad=os.default.loadavg;os.default.loadavg=()=>[0,0,0];
 const start={kind:'start',role:'p-작업자',session:'kadan-p-작업자',panePid:1,t:'2026-09-12T00:00:00.000Z'};
 let cycle=0;const records=[],end=new Error('end');const t0=Date.parse(start.t);
 try{
  await assert.rejects(()=>runWatch({floor:{list:()=>[{session:start.session,pid:1}],read:()=>'ok'},readEntries:()=>[start],record:e=>records.push(e),sendAlert:()=>{},
   intervalMs:60_000,stallN:100,routes:{},superRole:null,hierarchyPath:'/h.json',profilePath:'/p.json',now:()=>t0+cycle*60_000,print:()=>{},
   spawn:command=>{if(command==='sleep'&&++cycle===8)throw end;if(command==='memory_pressure')return{status:0,stdout:'System-wide memory free percentage: 80%'};if(command==='sysctl')return{status:0,stdout:'total = 0M used = 0M free = 0M'};return{status:0,stdout:''};}}),e=>e===end);
 }finally{os.default.loadavg=oldLoad;}
 const cycles=records.filter(r=>r.kind==='watch-cycle');
 assert.equal(cycles.length,2);
 assert.deepEqual(cycles.map(c=>[c.pid,c.hierarchy,c.judge,c.profile,c.intervalMs,c.ok]),[[process.pid,'/h.json',false,'/p.json',60_000,true],[process.pid,'/h.json',false,'/p.json',60_000,true]]);
 assert.equal(cycles[0].sessions,null);
});
