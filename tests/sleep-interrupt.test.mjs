import "./helpers/isolated-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  currentErrorBlock, currentStopPhrases, anyStopWordInBottom, SUPERVISOR_ERROR_PATTERN, STOP_PHRASES,
} from "../src/watch-stop-phrases.mjs";
import { screenDisconnects, disconnectKind } from "../src/watch.mjs";
import { SupervisorHealth, SUPERVISOR_ERROR_MS, SUPERVISOR_CHECK_MS } from "../src/watch-supervisor-health.mjs";
import { changeDigest } from "../src/watch-roles.mjs";
import { buildWatchPrompt } from "../src/watch-ai.mjs";

const load = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
// 2026-10-21 감독 오판 사고의 실제 화면(경로·커밋 문구만 일반 문구로 바꿈)
const SLEEP = load("sleep-interrupt-screens.json")["A-claude-sleep-interrupted-then-empty-composer"];

test("실제 절전 중단 화면: 작업자 오류 덩어리·낱말·넓은 판정·감독 20줄 판정이 모두 오류로 잡는다", () => {
  assert.ok(STOP_PHRASES.some((p) => p.id === "sleep-interrupted" && p.scope.includes("worker") && p.scope.includes("supervisor")));
  const block = currentErrorBlock(SLEEP);
  assert.match(block.head, /^⏺ API Error: Your computer went to sleep mid-response/u);
  assert.equal(currentStopPhrases(SLEEP).size, 1);
  assert.equal(screenDisconnects(SLEEP).size, 1);
  assert.equal(disconnectKind("API Error: Your computer went to sleep mid-response."), "끊김");
  assert.equal(anyStopWordInBottom(SLEEP), true);
  assert.equal(SUPERVISOR_ERROR_PATTERN.test(SLEEP.split("\n").slice(-20).join("\n")), true);
});

test("절전 낱말을 인용만 한 화면, 입력 중인 화면은 오류 덩어리가 아니다", () => {
  const quoted = "⏺ 로그에 'went to sleep mid-response' 가 찍혔습니다.\n\n✻ Baked for 1m 2s\n\n❯ \n";
  assert.equal(currentErrorBlock(quoted), null);
  const typing = SLEEP.replace("❯ \n", "❯ 계속해줘\n");
  assert.equal(currentErrorBlock(typing), null);
  const resumed = SLEEP.replace("⏺ API Error", "⏺ API Error").replace("✻ Baked for 8m 22s · done 6:12 PM", "✻ Baked for 8m 22s · done 6:12 PM\n\n⏺ 이어서 하겠습니다.");
  assert.equal(currentErrorBlock(resumed), null);
});

test("작업자 판정은 main과 같다: 절전 낱말이 없는 입력 14개의 낱말·넓은 판정이 main 값과 일치", () => {
  const rows = Object.entries(load("sleep-interrupt-worker-inputs.json"));
  assert.ok(rows.length >= 10);
  for (const [name, row] of rows) {
    assert.deepEqual([...currentStopPhrases(row.screen).keys()], row.mainPhrases, name);
    assert.equal(anyStopWordInBottom(row.screen), row.mainBroad, name);
  }
});

test("감독 화면에 절전 오류가 5분 이어지면 조기 확인 후보가 생기고, 지난 정상 판정 재사용으로 생략되지 않는다", () => {
  const session = "kadan-r-감독", t0 = Date.UTC(2026, 9, 21, 9, 12);
  const seen = { alive: true, pid: "1", expectedPid: "1", startedAt: new Date(t0 - 3600e3).toISOString(), screen: SLEEP };
  const base = { scope: { sessions: new Set([session]), entries: [] }, observations: new Map([[session, seen]]), cards: [], enabled: true };
  // 지난 확인이 같은 화면을 '실행완료'로 판정한 기록 — 오류가 없었다면 재사용으로 생략될 조건
  const entries = [
    { kind: "watch-ai-request", source: "supervisor-health", session, requestId: "q1", t: new Date(t0 - 600e3).toISOString(), observationDigest: changeDigest(SLEEP) },
    { kind: "watch-ai-report", requestId: "q1", accepted: true, verdict: "실행완료" },
  ];
  const health = new SupervisorHealth();
  assert.equal(health.select({ ...base, entries, now: t0 }).candidate, undefined, "처음 본 순회는 후보 없음");
  assert.equal(health.select({ ...base, entries, now: t0 + SUPERVISOR_ERROR_MS - 60e3 }).candidate, undefined, "5분 전");
  const early = health.select({ ...base, entries, now: t0 + SUPERVISOR_ERROR_MS }).candidate;
  assert.equal(early.input.check, "persistent-error");
  assert.equal(early.input.errorMinutes, 5);
  // 시간만 늘고 화면이 같아도(가짜 시계 증가) 1시간 정기 확인이 재사용으로 빠지지 않는다
  const fresh = new SupervisorHealth();
  fresh.select({ ...base, entries, now: t0 });
  const hourly = fresh.select({ ...base, entries, now: t0 + SUPERVISOR_CHECK_MS, ownTurn: new Set() });
  assert.ok(hourly.candidate, "오류가 보이면 재사용 생략이 꺼진다");
});

test("오류 없는 같은 화면은 예전처럼 재사용으로 생략된다(대조)", () => {
  const calm = SLEEP.replace(/⏺ API Error:.*\n/u, "⏺ 정리했습니다.\n");
  const session = "kadan-r-감독", t0 = Date.UTC(2026, 9, 21, 9, 12);
  const seen = { alive: true, pid: "1", expectedPid: "1", startedAt: new Date(t0 - 7200e3).toISOString(), screen: calm };
  const entries = [
    { kind: "watch-ai-request", source: "supervisor-health", session, requestId: "q1", t: new Date(t0 - 600e3).toISOString(), observationDigest: changeDigest(calm) },
    { kind: "watch-ai-report", requestId: "q1", accepted: true, verdict: "실행완료" },
  ];
  const health = new SupervisorHealth();
  const base = { scope: { sessions: new Set([session]), entries: [] }, observations: new Map([[session, seen]]), entries, cards: [], enabled: true, ownTurn: new Set() };
  health.select({ ...base, now: t0 });
  assert.equal(health.select({ ...base, now: t0 + SUPERVISOR_CHECK_MS }).candidate, undefined);
});

test("감시AI 지시문: 응답 중단 오류 뒤 빈 입력창은 실행완료가 아니다", () => {
  for (const source of ["supervisor-health", "worker-stall"]) {
    const prompt = buildWatchPrompt({ source, command: "cmd", input: {} });
    assert.match(prompt, /응답 중단 오류\(절전 went to sleep mid-response·API Error 등\) 뒤에 남은 빈 입력창은 실행완료가 아니다/u);
    assert.match(prompt, /실행완료: 현재 맡긴 실행의 완료 표시 뒤 정상 입력 프롬프트로 복귀/u, "기존 문구는 그대로");
  }
});
