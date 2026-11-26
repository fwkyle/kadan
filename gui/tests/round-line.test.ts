import test from "node:test";
import assert from "node:assert/strict";
import { roundLine } from "../src/round-line.ts";

const openedAt = "2026-01-01T00:00:00.000Z";
const after = (minutes: number) => Date.parse(openedAt) + minutes * 60_000;

test("업무 줄은 라운드·경과 시간·단계 문구를 한 줄로 만들고 경과는 지금 시각 기준이다", () => {
  const value = { round: 2, label: "검수 대기", openedAt };
  assert.equal(roundLine(value, after(130)), "2라운드째 · 2시간 10분 · 검수 대기");
  assert.equal(roundLine(value, after(135)), "2라운드째 · 2시간 15분 · 검수 대기", "같은 행도 시간이 지나면 늘어난다");
  assert.equal(roundLine({ ...value, label: "연결 확인 필요" }, after(5)), "2라운드째 · 5분 · 연결 확인 필요");
});

test("시작 시각을 모르면 경과 칸을 빼고, 기기 시계가 늦어도 음수나 줄표를 보이지 않는다", () => {
  assert.equal(roundLine({ round: 1, label: "검수 중", openedAt: null }, after(10)), "1라운드째 · 검수 중");
  assert.equal(roundLine({ round: 1, label: "검수 중", openedAt: "모름" }, after(10)), "1라운드째 · 검수 중");
  assert.equal(roundLine({ round: 1, label: "검수 중", openedAt }, after(-1)), "1라운드째 · 0초 · 검수 중");
});
