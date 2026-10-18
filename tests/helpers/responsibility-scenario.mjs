// 책임 판정 시험용 장면. 손으로 만든 업무 객체가 아니라 실제 WorkStore·CardStore·원장 모듈을 지난 값을 쓴다.
// 시각은 실제 시계라 단계 사이에 잠깐 쉰다(업무 저장소가 new Date()로 찍는다).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkStore } from "../../src/work-store.mjs";
import { CardStore } from "../../src/card-store.mjs";
import { appendLedger, readLedger } from "../../src/ledger.mjs";
import { withEffectiveOwner } from "../../src/handover-state.mjs";
import { buildSupervisorScope, previousGenerationWorks } from "../../src/watch-scope.mjs";

export const parents = new Map(Object.entries({ "r-슈퍼": "@user", "r-감독": "r-슈퍼", "r-작업자": "r-감독" }));
const sleep = (ms = 4) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function scenario(steps) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-resp-"));
  const works = new WorkStore(home);
  let work = works.create({ key: "r/w1", title: "t", goal: "g", scope: "s", acceptance: "a",
    owner: steps.owner ?? "r-감독", repoPath: home, by: "사람" });
  sleep();
  work = works.change("r/w1", "execute", { phase: "implementation", round: 1, title: "실행", body: "본문" },
    { revision: work.revision, by: "사람", note: "발령" });
  const execution = work.executions[0].key;
  const start = (role) => { sleep(); appendLedger({ kind: "start", role, session: `kadan-${role}`, cmd: "claude --model sonnet" }, home); };
  const update = (fields) => { sleep(); work = works.change("r/w1", "update", fields, { revision: work.revision, by: "사람", note: "변경" }); };
  // 실행 발령(send)은 업무 연결 조건이다. 감독 역할이 받은 발령 하나를 둔다.
  start("r-작업자");
  appendLedger({ kind: "send", role: "r-작업자", taskId: execution, executionKey: execution }, home);
  steps.run({ start, update });
  const entries = readLedger(home);
  const cards = new CardStore(home).list();
  const effective = works.list().map((w) => withEffectiveOwner(w, entries));
  return { home, entries, cards, works: effective, work: effective[0], execution };
}

// 이 업무가 감독 응답 감시 범위와 대시보드 이전 세대 목록 중 어디에 나오는가.
export function surfaces(s, tree = parents) {
  const scope = buildSupervisorScope(s.cards, s.entries, tree, s.works).entries.filter((e) => e.workKey === "r/w1");
  const previous = previousGenerationWorks(s.works, s.entries, tree);
  return { scopeRoles: [...new Set(scope.map((e) => e.role))].sort(), previous: previous.map((p) => p.role) };
}
