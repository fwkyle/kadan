import { test } from "node:test";
import assert from "node:assert/strict";
import { sendTmux } from "../src/floor-tmux.mjs";
import { guardedSend } from "../src/cli.mjs";
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function noopSpawn() {
  return {};
}

function bufferOf(call) {
  const i = call.args.indexOf("-b");
  return i === -1 ? null : call.args[i + 1];
}

test("동시 send는 서로의 tmux 버퍼를 붙여넣거나 지우지 않는다 — 고정 kadan-send 교차 배달(2026-09-05)(card-48)", () => {
  const calls = [];
  let hrtimeN = 0n;
  const hrtime = () => {
    hrtimeN += 1n;
    return hrtimeN;
  };
  let reentered = false;

  const run = (args, input) => {
    const call = { args: [...args], input };
    calls.push(call);
    if (args[0] === "display-message") return "0\n";
    if (!reentered && args[0] === "load-buffer" && bufferOf(call) === "kadan-send-101-1") {
      reentered = true;
      sendTmux("kadan-b", "B-지시", { run, spawn: noopSpawn, pid: 202, hrtime });
    }
  };

  sendTmux("kadan-a", "A-지시", { run, spawn: noopSpawn, pid: 101, hrtime });

  const loads = calls.filter((c) => c.args[0] === "load-buffer");
  const pastes = calls.filter((c) => c.args[0] === "paste-buffer");
  const deletes = calls.filter((c) => c.args[0] === "delete-buffer");

  assert.strictEqual(loads.length, 2, "load-buffer 호출 수");
  assert.strictEqual(pastes.length, 2, "paste-buffer 호출 수");
  assert.strictEqual(deletes.length, 0, "정상 경로에서 delete-buffer 호출 수");

  const byBuffer = new Map();
  for (const c of calls) {
    const buf = bufferOf(c);
    if (!buf) continue;
    if (!byBuffer.has(buf)) byBuffer.set(buf, []);
    byBuffer.get(buf).push(c.args[0]);
  }

  assert.deepStrictEqual(
    [...byBuffer.keys()].sort(),
    ["kadan-send-101-1", "kadan-send-202-2"],
    "버퍼 이름이 pid+hrtime 조합으로 분리돼야 한다"
  );

  for (const [buf, cmds] of byBuffer) {
    assert.deepStrictEqual(
      cmds.sort(),
      ["load-buffer", "paste-buffer"],
      `${buf} 에 load/paste 한 쌍만 있어야 한다`
    );
    const pasteCall = pastes.find((c) => bufferOf(c) === buf);
    assert.ok(pasteCall, `${buf} 의 paste 호출이 있어야 한다`);
    assert.ok(pasteCall.args.includes("-d"), `${buf} 의 paste 에 -d 가 있어야 한다`);
  }
});

test("본문은 괄호 붙여넣기(-p)로 넣고 1초 뒤 Enter를 보낸다 — Claude Code Enter 누락(2026-09-23)", () => {
  const calls = [];
  const run = (args) => { calls.push(["run", ...args]); if (args[0] === "display-message") return "0\n"; };
  const spawn = (cmd, args) => { calls.push(["spawn", cmd, ...args]); return {}; };
  sendTmux("kadan-a", "짧은 지시\n", { run, spawn, pid: 1, hrtime: () => 1n });
  const paste = calls.findIndex((c) => c[1] === "paste-buffer");
  const sleep = calls.findIndex((c) => c[1] === "sleep");
  const enter = calls.findIndex((c) => c[1] === "send-keys");
  assert.ok(calls[paste].includes("-p"), "paste-buffer 에 -p 가 있어야 한다");
  assert.deepEqual(calls[sleep], ["spawn", "sleep", "1"]);
  assert.ok(paste < sleep && sleep < enter, "붙여넣기 → 대기 → Enter 순서");
});

for (const sample of [
  {name:'처음부터 복사모드',modes:['1'],pastes:0,delivery:'not-sent'},
  {name:'버퍼 준비 뒤 복사모드',modes:['0','1'],pastes:0,delivery:'not-sent'},
  {name:'붙여넣기 뒤 복사모드',modes:['0','0','1'],pastes:1,delivery:'unknown'},
  {name:'첫 조회 빈 응답',modes:[''],pastes:0,delivery:'not-sent'},
  {name:'붙여넣기 뒤 조회 실패',modes:['0','0',null],pastes:1,delivery:'unknown'},
]) test(`모드 검사: ${sample.name} — Enter 0, 자동 해제·재시도 0`,()=>{
  const calls=[],modes=[...sample.modes];
  const run=args=>{
    calls.push(args);
    if(args[0]==='display-message'){const value=modes.shift();if(value===null)throw new Error('조회 실패');return value;}
  };
  assert.throws(()=>sendTmux('kadan-test','본문',{run,spawn:noopSpawn}),e=>{
    assert.equal(e.delivery,sample.delivery);assert.equal(e.inputAcceptance,'unconfirmed');assert.match(e.message,/전송 보류/);return true;
  });
  assert.equal(calls.filter(c=>c[0]==='paste-buffer').length,sample.pastes);
  assert.equal(calls.filter(c=>c[0]==='send-keys').length,0);
  assert.ok(calls.every(c=>!c.includes('-X')));
});

test('정상 모드의 키 전달은 입력 접수 확인을 주장하지 않는다',()=>{
  const calls=[];
  const receipt=sendTmux('kadan-test','본문',{run:a=>{calls.push(a);return a[0]==='display-message'?'0':undefined;},spawn:noopSpawn});
  assert.deepEqual(receipt,{keyDelivery:'sent',inputAcceptance:'unconfirmed'});
  assert.equal(calls.filter(c=>c[0]==='paste-buffer').length,1);assert.equal(calls.filter(c=>c[0]==='send-keys').length,1);
});

for(const failure of ['load-buffer','paste-buffer','send-keys'])test(`${failure} 오류의 전송 단계를 보존하고 반복하지 않는다`,()=>{
  const calls=[];const error=new Error('시험 오류');
  assert.throws(()=>sendTmux('kadan-test','본문',{run:a=>{calls.push(a);if(a[0]===failure)throw error;return a[0]==='display-message'?'0':undefined;},spawn:noopSpawn}),e=>{
    assert.equal(e,error);assert.equal(e.delivery,failure==='load-buffer'?'not-sent':'unknown');return true;
  });
  assert.equal(calls.filter(c=>c[0]===failure).length,1);
});

test('미전송·부분전송 오류는 guardedSend에서 덮지 않고 성공 send 원장을 쓰지 않는다',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'scm-test-unit-'));
  for(const delivery of ['not-sent','unknown',undefined]){
    const records=[],error=new Error('바닥 오류');if(delivery)error.delivery=delivery;
    assert.throws(()=>guardedSend({floor:{name:'tmux',alive:()=>true,pid:()=> '123',send:()=>{throw error;}},session:'kadan-test',role:'test',message:'본문',recordedPid:'123',env:{KADAN_HOME:home},readEntries:()=>[],record:e=>records.push(e)}),e=>e.delivery===(delivery||'unknown'));
    assert.equal(records.length,0);
  }
});

test('전송 버퍼 정리 오류도 미전송 판정을 보존한다',()=>{
  let checks=0;
  assert.throws(()=>sendTmux('kadan-test','본문',{run:a=>{if(a[0]==='display-message')return ++checks===1?'0':'1';if(a[0]==='delete-buffer')throw new Error('정리 실패');},spawn:noopSpawn}),e=>e instanceof AggregateError&&e.delivery==='not-sent');
});

test("paste 실패면 같은 이름 버퍼를 지우고 원래 오류를 던진다(card-48)", () => {
  const originalError = new Error("paste 실패");
  const calls = [];
  const run = (args, input) => {
    calls.push({ args: [...args], input });
    if (args[0] === "display-message") return "0\n";
    if (args[0] === "paste-buffer") {
      throw originalError;
    }
  };

  let caught;
  try {
    sendTmux("kadan-a", "text", { run, spawn: noopSpawn, pid: 1, hrtime: () => 5n });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught, "원래 오류가 다시 던져져야 한다");
  assert.strictEqual(caught, originalError, "던져진 오류가 원래 오류 객체여야 한다");

  const deletes = calls.filter((c) => c.args[0] === "delete-buffer");
  assert.strictEqual(deletes.length, 1, "paste 실패 시 delete-buffer 한 번 시도해야 한다");
  assert.strictEqual(bufferOf(deletes[0]), "kadan-send-1-5", "지우는 버퍼가 본인 것이어야 한다");
});
