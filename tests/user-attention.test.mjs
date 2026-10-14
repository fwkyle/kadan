import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Mailbox } from '../src/mailbox.mjs';
import { readLedger } from '../src/ledger.mjs';
import { CardStore } from '../src/card-store.mjs';
import { DecisionStore } from '../src/decisions.mjs';
import { userAttention, actOnUserMail } from '../src/user-attention.mjs';
import { userAlertRequired, userMailRequired } from '../src/user-notification-policy.mjs';
import { isPeerSuperMail } from '../src/peer-mail.mjs';
import { registerStartedRole } from '../src/hierarchy-register.mjs';
import { decisionsData } from '../src/dashboard/settings.mjs';
import { notifyUser } from '../src/watch-system.mjs';

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-user-attention-'));
const decision = {question:'진행할까요?',options:['진행','보류'],recommendation:'보류',
  reason:'확인 경로 없음: 방침 결정'};

test('사용자가 확인하고 답하는 한 화면: 일반 보고 제외, 읽음과 답변을 구분, 타인 우편 조작 거절', () => {
  const h=home(), box=new Mailbox(h,'@user');
  box.send({by:'p-슈퍼감독',message:'일상 보고'});
  const info=box.send({by:'p-슈퍼감독',message:'확인할 결과',category:'request'});
  const question=box.send({by:'p-슈퍼감독',message:'정책 질문',category:'request',expectReply:true});
  const privateMail=new Mailbox(h,'p-감독').send({by:'p-슈퍼감독',message:'감독만 볼 것',category:'request'});
  const get=()=>userAttention(readLedger(h),h);
  assert.equal(get().length,2);
  assert.throws(()=>actOnUserMail(h,privateMail.mailId),/대상/);
  assert.throws(()=>actOnUserMail(h,question.mailId),/답변/);
  actOnUserMail(h,info.mailId);
  assert.deepEqual(get().map(x=>x.id),[question.mailId]);
  const result=actOnUserMail(h,question.mailId,{reply:true,text:'보류합니다'});
  assert.equal(result.status,'stored');
  assert.equal(get().length,0);
  assert.equal(new Mailbox(h,'p-슈퍼감독').read(result.mailId).body,'보류합니다');
  assert.throws(()=>actOnUserMail(h,question.mailId,{reply:true,text:'중복 답변'}),/이미/);
});

test('과거 일상 감시 67건은 사용자 확인에 안 섞이고 재시작·해소된 장애는 사라진다', () => {
  const entries=Array.from({length:67},(_,i)=>({kind:'alert',id:`routine-${i}`,alertKind:i%2?'완료후보':'시작보고누락',
    recipient:'@user',level:'RED',t:'2026-09-01T00:00:00Z'}));
  entries.push({kind:'alert',id:'dead',alertKind:'죽음',recipient:'@user',role:'p',t:'2026-10-01T00:00:00Z'});
  assert.deepEqual(userAttention(entries,home()).map(x=>x.id),['dead']);
  entries.push({kind:'start',role:'p',t:'2026-10-02T00:00:00Z'});
  assert.equal(userAttention(entries,home()).length,0);
  entries.push({kind:'alert',id:'config',alertKind:'설정',recipient:'@user'});
  entries.push({kind:'alert',id:'config',alertKind:'설정',resolved:true,recipient:'@user'});
  assert.equal(userAttention(entries,home()).length,0);
});

test('사용자 알림은 내용 종류로 선별하며 창을 활성화하지 않는다', () => {
  for(const kind of ['시작보고누락','완료후보','놀고 있음','정체','조정','모름']) {
    assert.equal(userAlertRequired({kind,level:'RED'}),false);
    assert.equal(userAlertRequired({kind:'전달실패',sourceKind:kind}),false);
  }
  assert.equal(userAlertRequired({kind:'죽음'}),true);
  assert.equal(userAlertRequired({kind:'전달실패',sourceKind:'설정'}),true);
  assert.equal(userMailRequired({by:'watch',mailKind:'request'}),false);
  assert.equal(userMailRequired({by:'감독',mailKind:'report'}),false);
  assert.equal(userMailRequired({by:'감독',replyFinal:true}),true);
  const calls=[];
  notifyUser('결정 필요',(...args)=>{calls.push(args);return {status:0};});
  assert.match(calls[0][1][1],/^display notification /);
  assert.doesNotMatch(calls[0][1][1],/activate|open|frontmost|set_focus/);
});

test('슈퍼 프로필은 상위 이동과 독립이며 명시 일반감독을 사용자 직속만으로 슈퍼로 보지 않는다', () => {
  const entries=[{kind:'start',role:'repo-a',roleProfile:'super'},
    {kind:'start',role:'repo-b',roleProfile:'super'}, {kind:'start',role:'boss',roleProfile:'conductor'}];
  const parents=new Map([['repo-a','비서'],['repo-b','통합'],['통합','@user'],['boss','@user']]);
  assert.equal(isPeerSuperMail(entries,parents,'repo-a','repo-b'),true);
  assert.equal(isPeerSuperMail(entries,parents,'비서','repo-b'),true);
  assert.equal(isPeerSuperMail(entries,parents,'boss','repo-a'),false);
});

test('새 슈퍼는 사용자 직속, 기존 등록 관계는 변경하지 않는다', () => {
  const h=home(), file=path.join(h,'hierarchy.json');
  fs.writeFileSync(file,JSON.stringify({'비서':'@user','기존-슈퍼감독':'비서'}));
  const entries=[{kind:'hierarchy-loaded',path:file}];
  assert.equal(registerStartedRole({home:h,entries,role:'새-슈퍼감독',creator:'비서',profile:'super'}).parent,'@user');
  registerStartedRole({home:h,entries,role:'기존-슈퍼감독',creator:'비서',profile:'super'});
  assert.equal(JSON.parse(fs.readFileSync(file))['기존-슈퍼감독'],'비서');
});

test('임시 총괄 비서의 결정도 기존 저장소에 남고 새 요청만 한 번 알린다', () => {
  const h=home(), notifications=[];
  new CardStore(h).create({repo:'repo',id:'card',repoPath:h,body:'# 임시 총괄'});
  const store=new DecisionStore(h,{notifyRequest:message=>notifications.push(message)});
  const saved=store.request('repo/card',decision,'비서');
  assert.equal(store.request('repo/card',decision,'비서').id,saved.id);
  assert.equal(store.get(saved.id).requestedBy,'비서');
  assert.equal(notifications.length,1);
  const failing=new DecisionStore(h,{notifyRequest:()=>{throw Error('notification unavailable');}});
  const other=failing.request('repo/card',{...decision,question:'다른 선택?'},'비서');
  assert.equal(failing.get(other.id).status,'open');
});

test('우편 조회 실패는 결정 요청을 지우지 않고 확인 목록 오류로 표시한다', () => {
  const result=decisionsData({decisions:[],entries:[{broken:true}],ledgerLines:null},null,{});
  assert.deepEqual(result.items,[]);
  assert.match(result.attentionError,/확인 기록/);
});

test('실제 감시 순회: 사용자 직속의 시작 보고 누락은 기록만, 세션 종료는 OS 알림', async () => {
  const { runWatch } = await import('./helpers/watch-runner.mjs');
  const at='2026-10-01T00:00:00Z', grace=300_000;
  for (const dead of [false,true]) {
    let cycle=0;
    const records=[], notifications=[], end=new Error('end');
    const start={kind:'start',role:'worker',session:'kadan-worker',panePid:'1',t:at};
    await assert.rejects(()=>runWatch({
      floor:{list:()=>dead&&cycle>0?[]:[{session:start.session,pid:'1'}],read:()=> 'working'},
      readEntries:()=>[start,{kind:'send',role:'worker',taskId:'c',t:at}],
      readCards:()=>[{id:'c',key:'r/c',status:'assigned',role:'worker'}],
      startReportGraceMs:grace,intervalMs:grace,stallN:100,
      parents:new Map([['worker','@user']]),routes:new Map(),
      now:()=>Date.parse(at)+grace+cycle*grace,
      record:r=>records.push(r),sendAlert:()=>{throw Error('unexpected role delivery');},print:()=>{},
      spawn:(cmd,args)=>{
        if(cmd==='sleep'&&++cycle===3)throw end;
        if(cmd==='osascript')notifications.push(args);
        return {status:0,stdout:''};
      },
    }),error=>error===end);
    if(dead) assert.ok(notifications.length>0);
    else {
      assert.equal(notifications.length,0);
      assert.ok(records.some(e=>e.alertKind==='시작보고누락'&&e.userSuppressed===true&&e.delivered===false));
    }
  }
});

test('실제 감시AI 보고도 사용자 직속의 정체는 알리지 않고 응답 장애만 알린다', async () => {
  const { WatchReports }=await import('../src/watch-report.mjs');
  const { appendLedger }=await import('../src/ledger.mjs');
  const h=home(), sent=[];
  appendLedger({kind:'start',role:'worker',session:'kadan-worker',panePid:1},h);
  appendLedger({kind:'send',role:'worker',taskId:'c'},h);
  const reports=new WatchReports({home:h,
    floor:{list:()=>[{session:'kadan-worker',pid:1}]},
    readCards:()=>[{id:'c',key:'r/c',status:'assigned',role:'worker'}],
    send:(role,message)=>sent.push({role,message}),
  });
  const request=()=>reports.request({source:'stall',role:'worker',parents:new Map([['worker','@user']])});
  reports.submit(request().requestId,'정체','화면 변화 없음');
  assert.equal(sent.length,0);
  reports.submit(request().requestId,'응답장애','입력에 응답하지 못함');
  assert.equal(sent.length,1);
  assert.equal(sent[0].role,'@user');
});

test('실제 mail CLI의 OS 경로: 보고는 조용히 저장, 사용자 요청만 알림 명령 실행', async () => {
  const { spawnSync }=await import('node:child_process');
  const h=home(), bin=path.join(h,'bin'), log=path.join(h,'notifications.jsonl');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'osascript'),`#!${process.execPath}\n`+
    `require('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');\n`,{mode:0o700});
  const env={...process.env,KADAN_HOME:h,KADAN_SOCKET:'user-attention-test-unused',
    KADAN_NOTIFY:'on',KADAN_ROLE:'p-슈퍼감독',PATH:`${bin}:${process.env.PATH}`};
  const cli=new URL('../src/cli.mjs',import.meta.url).pathname;
  const send=kind=>spawnSync(process.execPath,[cli,'mail','@user','--mailbox','--mail-kind',kind,'검토할 내용'],
    {env,encoding:'utf8'});
  assert.equal(send('report').status,0);
  assert.equal(fs.existsSync(log),false);
  const request=send('request');
  assert.equal(request.status,0,request.stderr);
  const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(calls.length,1);
  assert.match(calls[0][1],/^display notification /);
  assert.equal(userAttention(readLedger(h),h).length,1);
});
