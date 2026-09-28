import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { closeStartedWindow } from '../src/cli.mjs';
import { appendLedger, readLedger } from '../src/ledger.mjs';

function fixture(overrides = {}) {
  const calls = [], lines = [];
  const env = {KADAN_ROTTIE_BIN:'/gone/rottie', KADAN_WINDOW:'none'};
  const deps = {env, existsFn:()=>false, listBinsFn:()=>['/live/rottie'],
    connectFn:({bin})=>{calls.push(['status',bin]);return {ok:true,bundleId:'example.rottie'};},
    showFn:({bin,terminalId})=>{calls.push(['show',bin,terminalId]);return {ok:true,state:'closed'};},
    closeFn:({bin,terminalId})=>{calls.push(['close',bin,terminalId]);return {closed:true};},
    removeFn:({bin,terminalId})=>{calls.push(['remove',bin,terminalId]);return {removed:true};},
    print:line=>lines.push(line), ...overrides};
  return {calls,lines,env:deps.env,run:()=>closeStartedWindow({rottieTerminalId:'owned-tab'},deps)};
}

test('없어진 로티 경로를 현재 앱으로 교정하고 원장에 있는 탭만 조회·닫기·제거한다', () => {
  const f=fixture(), result=f.run();
  assert.deepEqual(f.calls,[['status','/live/rottie'],['show','/live/rottie','owned-tab'],['close','/live/rottie','owned-tab'],['remove','/live/rottie','owned-tab']]);
  assert.equal(result.rottieWindowClosed,true);assert.equal(result.rottieWindowRemoved,true);
  assert.equal(f.env.KADAN_ROTTIE_BIN,'/live/rottie');
  assert.deepEqual(result.rottieBinSwitched,{from:'/gone/rottie',to:'/live/rottie',reason:'missing'});
});

test('여러 앱·앱 없음·자동 교정 거부·연결 실패는 쓰기 없이 끝난다', () => {
  for(const overrides of [
    {listBinsFn:()=>[]}, {listBinsFn:()=>['/a/rottie','/b/rottie']},
    {env:{KADAN_ROTTIE_BIN:'/gone/rottie',KADAN_ROTTIE_AUTO_ATTACH:'off'}},
    {connectFn:()=>({ok:false,code:'ROTTIE_APP_NOT_RUNNING'})},
  ]) {
    const f=fixture({...overrides,showFn:()=>assert.fail('unexpected show'),closeFn:()=>assert.fail('unexpected close'),removeFn:()=>assert.fail('unexpected remove')});
    assert.equal(f.run().rottieWindowClosed,false);
    assert.equal(f.env.KADAN_ROTTIE_BIN,'/gone/rottie');
  }
});

test('경로 파일이 있어도 연결 실패하면 같은 교정 규칙으로 현재 앱을 확인한다', () => {
  const f=fixture({existsFn:()=>true,connectFn:({bin})=>bin==='/gone/rottie'?{ok:false,code:'ROTTIE_APP_NOT_RUNNING'}:{ok:true}});
  const result=f.run();
  assert.equal(result.rottieWindowRemoved,true);assert.equal(result.rottieBinSwitched.reason,'connect');
  assert(f.calls.every(call=>call[1]==='/live/rottie'));
});

test('현재 앱에 원장의 탭이 없거나 조회에 실패하면 닫기·제거하지 않는다', () => {
  for(const code of ['ROTTIE_TERMINAL_NOT_FOUND','ROTTIE_SHOW_FAILED']) {
    const f=fixture({showFn:()=>({ok:false,code}),closeFn:()=>assert.fail('unexpected close'),removeFn:()=>assert.fail('unexpected remove')});
    const result=f.run();assert.equal(result.rottieWindowClosed,false);assert.equal(result.rottieWindowError,code);
  }
});

test('교정 뒤 닫기 결과가 불명확하면 다시 보내거나 다른 앱을 찾지 않는다', () => {
  let closes=0;
  const f=fixture({closeFn:()=>{closes++;return {closed:false,code:'ROTTIE_EFFECT_UNKNOWN'};},removeFn:()=>assert.fail('unexpected remove')});
  const result=f.run();assert.equal(closes,1);assert.equal(result.rottieWindowError,'ROTTIE_EFFECT_UNKNOWN');
  assert.equal(f.calls.filter(c=>c[0]==='status').length,1);
});

function commandFixture({removeFails=false,showFails=false,closeFails=false,hasTab=true,oldBin=true}={}) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-stop-path-'));
  const binDir=path.join(home,'bin');fs.mkdirSync(binDir);
  const binary=path.join(home,'Rottie Local.app','Contents','MacOS','rottie');
  fs.mkdirSync(path.dirname(binary),{recursive:true});
  const calls=path.join(home,'calls.jsonl');
  const executable=(file,body)=>fs.writeFileSync(file,`#!${process.execPath}\n${body}\n`,{mode:0o700});
  executable(binary,`
    const fs=require('node:fs'), args=process.argv.slice(2), id=args[args.indexOf('--terminal')+1];
    fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
    const error=args[1]==='show'&&${showFails}?'ROTTIE_TERMINAL_NOT_FOUND':args[1]==='close'&&${closeFails}?'ROTTIE_EFFECT_UNKNOWN':args[1]==='remove'&&${removeFails}?'ROTTIE_TERMINAL_RUNNING':null;
    console.log(JSON.stringify(error?{ok:false,error:{code:error}}:{ok:true,runtime:{bundleId:'example.rottie'},result:{terminal:{id,state:'closed'}}}));
    process.exitCode=error?5:0;
  `);
  executable(path.join(binDir,'ps'),`console.log(${JSON.stringify(binary)});`);
  executable(path.join(binDir,'tmux'),`
    const fs=require('node:fs'),args=process.argv.slice(2);
    if(args.includes('kill-session'))fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(['tmux-stop'])+'\\n');
  `);
  const role='test-worker',session='kadan-test-worker';
  appendLedger({kind:'start',role,session,panePid:123,...(hasTab?{rottieTerminalId:'original-tab'}:{})},home);
  if(hasTab)appendLedger({kind:'window',role,session,rottieTerminalId:'restored-tab'},home);
  const env={...process.env,KADAN_HOME:home,KADAN_ROLE:'test-supervisor',KADAN_WINDOW:'none',KADAN_FLOOR:'tmux',KADAN_ROTTIE_AUTO_ATTACH:'on',
    KADAN_ROTTIE_BIN:oldBin?path.join(home,'missing-rottie'):binary,PATH:`${binDir}:${process.env.PATH}`};
  const run=spawnSync(process.execPath,['src/cli.mjs','stop',role],{env,encoding:'utf8',timeout:20000});
  const actions=fs.existsSync(calls)?fs.readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse):[];
  return {run,actions,receipt:readLedger(home).at(-1),binary};
}

test('CLI: 오래된 부모 환경에서도 새 경로로 복구된 탭을 닫고 성공을 기록한다', () => {
  const {run,actions,receipt,binary}=commandFixture();
  assert.equal(run.status,0,run.stderr);
  assert.deepEqual(actions.map(a=>a.slice(0,2)),[['tmux-stop'],['status','--json'],['terminal','show'],['terminal','close'],['terminal','remove']]);
  for(const args of actions.filter(a=>a[0]==='terminal'))assert.equal(args[args.indexOf('--terminal')+1],'restored-tab');
  assert.equal(receipt.kind,'stop');assert.equal(receipt.rottieTerminalId,'restored-tab');
  assert.equal(receipt.rottieWindowRemoved,true);assert.equal(receipt.rottieBinSwitched.to,binary);
});

for(const stage of ['show','close','remove'])test(`CLI: ${stage} 실패는 종료 코드 1·표준 오류로 알리고 부분 완료 영수증을 보존한다`, () => {
  const {run,actions,receipt}=commandFixture({oldBin:false,[`${stage}Fails`]:true});
  assert.equal(run.status,1,run.stdout);
  assert.match(run.stderr,/세션.*종료.*로티 탭.*미완료/);
  assert.doesNotMatch(run.stdout,/^종료됨:/m);
  assert.equal(actions.filter(a=>a[0]==='tmux-stop').length,1);
  assert.equal(receipt.kind,'stop');
  if(stage==='remove') {assert.equal(receipt.rottieWindowClosed,true);assert.equal(receipt.rottieWindowRemoved,false);}
  else {assert.equal(receipt.rottieWindowClosed,false);assert(!actions.some(a=>a[1]==='remove'));}
});

test('CLI: 로티 창 기록이 없는 세션은 로티를 조회하지 않고 기존대로 종료한다', () => {
  const {run,actions,receipt}=commandFixture({hasTab:false});
  assert.equal(run.status,0,run.stderr);assert.deepEqual(actions,[['tmux-stop']]);
  assert.equal(receipt.kind,'stop');assert(!Object.hasOwn(receipt,'rottieWindowClosed'));
});
