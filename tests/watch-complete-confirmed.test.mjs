import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { runWatch } from "./helpers/watch-runner.mjs";

// 이미 done으로 확정된 완료는 완료후보 경보를 만들지 않는다 — 확인할 게 없는 알림과
// 그 해소 우편이 감독을 시끄럽게 했다(card-kadan-watch-completion-noise).
const session = "kadan-p-작업자";
const start = { kind: "start", role: "p-작업자", session, panePid: 1, t: "2026-09-14T00:00:00.000Z" };
const send = { kind: "send", role: "p-작업자", session, taskId: "card-x", bytes: 1, fingerprint: "f", by: "p-감독", t: "2026-09-14T00:00:10.000Z" };
const done = { kind: "done", role: "p-작업자", taskId: "card-x", result: "ok", by: "p-감독", t: "2026-09-14T00:05:00.000Z" };

async function exercise({ entries, cards, screen = "KADAN:DONE card-x ok\n› 입력 대기" }) {
  let cycle = 0;
  const records = [], sent = [], lines = [];
  const sentinel = new Error("cycle boundary");
  const oldLoad = os.loadavg;
  os.loadavg = () => [0, 0, 0];
  try {
    await assert.rejects(() => runWatch({
      floor: { list: () => [{ session, pid: 1 }], read: () => screen },
      readEntries: () => entries,
      ...(cards?{readCards:()=>cards,readWorks:()=>[]}:{}),
      record: entry => { if (entry.kind !== "watch-cycle") records.push(entry); },
      sendAlert: (role, message) => sent.push({ role, message }),
      intervalMs: 1000, stallN: 100, routes: { p: "p-감독" },
      superRole: "qa-슈퍼감독", now: () => Date.parse(start.t) + cycle * 1000,
      print: line => lines.push(line),
      spawn: command => {
        if (command === "sleep" && ++cycle === 4) throw sentinel;
        if (command === "memory_pressure") return { status: 0, stdout: "System-wide memory free percentage: 80%" };
        if (command === "sysctl") return { status: 0, stdout: "total = 0M used = 0M free = 0M" };
        return { status: 0, stdout: "" };
      },
    }), error => error === sentinel);
  } finally { os.loadavg = oldLoad; }
  return { records, sent, lines };
}

test("확정된 완료는 완료후보를 만들지 않는다 — 알림도 해소 우편도 없다", async () => {
  const result = await exercise({ entries: [start, send, done] });
  assert.equal(result.records.filter(e => e.alertKind === "완료후보").length, 0);
  assert.equal(result.sent.length, 0);
  assert.equal(result.lines.filter(l => l.includes("끝난 것 같음") || l.includes("해소됨")).length, 0);
});

test("확정 안 된 완료는 지금처럼 감독에게 알린다", async () => {
  const result = await exercise({ entries: [start, send] });
  const candidates = result.records.filter(e => e.alertKind === "완료후보");
  assert.ok(candidates.length > 0);
  for (const entry of candidates) {
    assert.equal(entry.taskId, "card-x");
    assert.equal(entry.delivered, true);
    assert.equal(entry.recipient, "p-감독");
  }
  assert.ok(result.sent.some(s => s.role === "p-감독" && s.message.includes("끝난 것 같음")));
});

test("다른 카드·다른 결과·발령 전의 done은 확정으로 세지 않는다", async () => {
  // 다른 카드의 done
  let result = await exercise({ entries: [start, send, { ...done, taskId: "card-y" }] });
  assert.ok(result.records.some(e => e.alertKind === "완료후보"));
  // 결과가 다른 done (감독은 ok 확정, 화면은 ok — 여기서는 failed 기록과 불일치로 본다)
  result = await exercise({ entries: [start, send, { ...done, result: "failed" }] });
  assert.ok(result.records.some(e => e.alertKind === "완료후보"));
  // 같은 카드라도 발령 전의 done은 지난 실행의 기록 — 재실행의 완료는 다시 알린다
  result = await exercise({ entries: [start, { ...done, t: "2026-09-13T23:00:00.000Z" }, send] });
  assert.ok(result.records.some(e => e.alertKind === "완료후보"));
  // 다른 역할의 done은 이 역할의 완료를 덮지 않는다
  result = await exercise({ entries: [start, send, { ...done, role: "p-다른작업자" }] });
  assert.ok(result.records.some(e => e.alertKind === "완료후보"));
});

test("발령 없이 띄운 세션도 세션 시작 이후의 done이면 확정으로 본다", async () => {
  const result = await exercise({ entries: [start, done] });
  assert.equal(result.records.filter(e => e.alertKind === "완료후보").length, 0);
  assert.equal(result.sent.length, 0);
});


test("다른 실행으로 감시가 유지돼도 짧은/전체 주소로 확정된 완료는 경보를 재생하지 않는다", async () => {
  const cards=['card-x','other'].map(id=>({key:`repo/${id}`,id,status:'assigned',workType:'execution',role:start.role}));
  for(const recorded of ['card-x','repo/card-x'])for(const marker of ['card-x','repo/card-x']) {
    const entries=[start,{...send,taskId:recorded},{...done,taskId:recorded},{...send,taskId:'other'}];
    const result=await exercise({cards,entries,screen:`KADAN:DONE ${marker} ok\n› 입력 대기`});
    assert.equal(result.records.filter(e=>e.alertKind==='완료후보').length,0,`${recorded} -> ${marker}`);
    assert.equal(result.sent.length,0);
  }
});

test("미확정 전체 주소 완료후보는 화면의 taskId와 기존 경보 ID를 보존한다", async () => {
  const cards=['card-x','other'].map(id=>({key:`repo/${id}`,id,status:'assigned',workType:'execution',role:start.role}));
  const entries=[start,send,{...send,taskId:'other'}],screen='KADAN:DONE repo/card-x ok\n› 입력 대기';
  const baseline=await exercise({entries,screen});
  const result=await exercise({cards,entries,screen});
  const before=baseline.records.find(e=>e.alertKind==='완료후보');
  const after=result.records.find(e=>e.alertKind==='완료후보');
  assert.ok(before&&after);
  assert.equal(after.taskId,'repo/card-x');assert.equal(after.id,before.id);
  // 없는 저장소나 다른 결과의 완료를 카드에 붙여 경보를 숨기지 않는다.
  const wrong=await exercise({cards,entries:[...entries,done],screen:'KADAN:DONE wrong/card-x ok\n› 입력 대기'});
  assert.ok(wrong.records.some(e=>e.alertKind==='완료후보'));
  const failed=await exercise({cards,entries:[...entries,{...done,result:'failed'}],screen});
  assert.ok(failed.records.some(e=>e.alertKind==='완료후보'));
});
