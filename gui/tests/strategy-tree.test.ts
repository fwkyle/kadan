import test from "node:test";
import assert from "node:assert/strict";
import { buildMap } from "../src/strategy-map.ts";
import {
  arrange, buildForest, cellHeight, clip, isRunning, depotLine, fitText, flatten, harnessName, isBranch, layoutTree, LONE_KEY, nameLines, shapeOf, staleKey, stateCounts, TREE, wrapText,
  type Forest, type TreeLayout,
} from "../src/strategy-tree.ts";
import type { Row } from "../src/types.ts";

// 전략 맵 나무 보기의 배치 계산. 자료는 buildMap 결과 그대로 쓴다.
const row = (key: string, owner: string, bucket: string, board = "") => ({ key, owner, bucket, board, title: key }) as unknown as Row;
const workers = [1, 2, 3, 4, 5, 6, 7].map((n) => `a-작업${n}`);
const hierarchy: Record<string, string> = {
  "a-슈퍼": "@user", "a-감독": "a-슈퍼", "a-부감독": "a-감독", "a-검수": "a-부감독", "a-직속": "a-슈퍼",
  ...Object.fromEntries(workers.map((w) => [w, "a-감독"])),
  "b-슈퍼": "@user", "b-감독": "b-슈퍼", "b-작업": "b-감독",
  "c-슈퍼": "@user", "d-슈퍼": "@user",
  "고아": "없는-감독", "x1": "x2", "x2": "x1",
};
const on = (role: string, harness: string | null) => ({ role, harness, model: "m", effort: null, pidState: "match" });
const live = [
  on("a-슈퍼", "claude"), on("a-감독", "claude"), on("a-부감독", "claude"), on("a-검수", "codex"), on("a-직속", "claude"),
  on("a-작업1", "codex"), on("a-작업2", "codex"), on("a-작업3", "agy"), on("a-작업4", "claude'"),
  on("a-작업5", "claude"), on("a-작업6", "claude"), on("a-작업7", "claude"),
  on("b-슈퍼", "claude"), on("b-감독", "claude"), on("b-작업", "claude"), on("c-슈퍼", "claude"),
  on("x1", null), on("x2", null), on("watch", null), on("대시보드", null),
];
const rows = [
  row("r/1", "a-작업1", "running"), row("r/2", "고아", "running"),
  row("r/3", "", "planned"), row("r/4", "", "planned"), row("r/5", "", "hold"),
];
const map = buildMap({ hierarchy, rows, live, alerts: null, lastRuns: { "d-슈퍼": { harness: "codex", model: null } } });
const forest = buildForest(map.bases, false);
// 아래 좌표 시험들은 사람이 b 판과 '관계표 밖'을 접어 둔 상태를 기준으로 한다(기본은 모두 펼침).
const folded = { "b-슈퍼": false, "관계표 밖": false };
const layout = (over: Partial<Parameters<typeof layoutTree>[1]> = {}, f: Forest = forest) =>
  layoutTree(f, { width: 980, fold: folded, expanded: new Set(), depot: map.depot, system: 2, ...over });
const allOpen = {};
const group = (l: TreeLayout, id: string) => l.groups.find((g) => g.group.id === id)!;
const roles = (cells: { unit: { role: string } }[]) => cells.map((c) => c.unit.role);

test("집계 줄: 판 수·대기 역할 수·실행 도구별 수", () => {
  assert.deepEqual(forest.groups.map((g) => g.id), ["a-슈퍼", "b-슈퍼", "관계표 밖"]);
  assert.equal(forest.boards, 5, "하위가 있는 판 3 + 하위 없는 슈퍼감독 2");
  assert.equal(forest.idle, 17);
  assert.deepEqual(forest.harness, { claude: 12, codex: 4, agy: 1 }, "따옴표가 붙은 이름도 claude로, 닫힌 창은 마지막 실행 기록으로 센다");
});

test("실행 도구 이름과 모양: 영문자만 남기고, 기록이 없으면 점선 동그라미", () => {
  const unit = (role: string) => map.bases.flatMap((b) => b.units).find((u) => u.role === role)!;
  assert.equal(harnessName(unit("a-작업4")), "claude");
  assert.equal(harnessName(unit("d-슈퍼")), "codex");
  assert.equal(harnessName(unit("x1")), null);
  assert.deepEqual(["claude", "codex", "agy", "other", null].map(shapeOf), ["circle", "square", "triangle", "circle", "none"]);
});

test("하위 역할 없는 슈퍼감독만 한 줄 묶음으로, 슈퍼감독 없는 판은 묶음에 넣지 않는다", () => {
  assert.deepEqual(forest.lone.map((u) => u.role), ["c-슈퍼", "d-슈퍼"]);
  const solo = buildForest(buildMap({ hierarchy: null, rows: [], live: [on("혼자", "claude")], alerts: null }).bases, false);
  assert.deepEqual(solo.lone, [], "슈퍼감독이 아닌 역할 하나는 '하위 역할 없는 슈퍼감독'이 아니다");
  assert.deepEqual(solo.groups.map((g) => [g.root, g.tops.map((n) => n.unit.role)]), [[null, ["혼자"]]]);
});

test("상위를 못 찾은 역할과 서로를 가리키는 역할도 빠지지 않고 한 번씩만 놓인다", () => {
  const outside = forest.groups[2];
  assert.equal(outside.root, null);
  assert.deepEqual(outside.tops.flatMap(flatten).map((u) => u.role).sort(), ["x1", "x2", "고아"]);
  const l = layout({ fold: allOpen });
  const placed = [
    ...l.groups.flatMap((g) => [...(g.group.root ? [g.group.root.role] : []),
      ...g.rows.flatMap((r) => [...(r.dir ? [r.dir.unit.role] : []), ...roles(r.workers), ...(r.more?.units.map((u) => u.role) ?? []),
        ...roles(r.old), ...(r.stale?.units.map((u) => u.role) ?? [])])]),
    ...roles(l.lone!.cells), ...(l.lone!.more?.units.map((u) => u.role) ?? []),
  ];
  const visible = map.bases.flatMap((b) => b.units).map((u) => u.role);
  assert.deepEqual([...placed].sort(), [...visible].sort());
  assert.equal(new Set(placed).size, placed.length, "두 번 놓인 역할 없음");
});

// kyle 피드백(2026-11-23) 기대 결과 표 1·2행
test("모든 판을 펼친 채로 시작한다 — 작업중이 없는 판도. 사람이 접은 판은 새 자료가 와도 접힌 채", () => {
  assert.deepEqual(forest.groups.map((g) => g.units.some(isRunning)), [true, false, false], "b 판과 '관계표 밖'에는 작업중이 없다");
  assert.deepEqual(layout({ fold: {} }).groups.map((g) => g.open), [true, true, true]);
  assert.deepEqual(roles(group(layout({ fold: {} }), "b-슈퍼").rows[0].workers), ["b-작업"]);
  const byHand = { "b-슈퍼": false };
  assert.deepEqual(layout({ fold: byHand }).groups.map((g) => g.open), [true, false, true]);
  // 새로 읽기: b 판에 작업중이 생긴 다음 자료로 다시 배치해도 사람이 접은 값이 이긴다
  const next = buildForest(buildMap({ hierarchy, rows: [...rows, row("r/8", "b-작업", "running")], live, alerts: null }).bases, false);
  assert.equal(group(layout({ fold: byHand }, next), "b-슈퍼").open, false);
  assert.equal(group(layout({ fold: { "b-슈퍼": true } }, next), "b-슈퍼").open, true);
});

test("접은 줄: 하위 상태 개수를 합쳐 보이고 줄은 그리지 않는다", () => {
  const l = layout();
  assert.deepEqual(group(l, "b-슈퍼").counts, [{ state: "idle", n: 2 }], "슈퍼감독 자신은 세지 않는다");
  assert.deepEqual(group(l, "관계표 밖").counts, [{ state: "dead", n: 1 }, { state: "idle", n: 2 }]);
  assert.deepEqual(group(l, "b-슈퍼").rows, []);
  assert.deepEqual(group(l, "b-슈퍼").box, { x: 0, y: 166, w: 150, h: 58 });
  assert.deepEqual(stateCounts([]), []);
});

test("펼친 판: 직속 작업자 줄, 감독 줄, 감독 아래 감독은 들여쓰고 상위 줄을 가리킨다", () => {
  const a = group(layout(), "a-슈퍼");
  assert.deepEqual(a.rows.map((r) => [r.dir?.unit.role ?? null, r.parent, roles(r.workers)]), [
    [null, -1, ["a-직속"]],
    ["a-감독", -1, ["a-작업1", "a-작업2", "a-작업3", "a-작업4"]],
    ["a-부감독", 1, ["a-검수"]],
  ]);
  assert.deepEqual(a.rows.map((r) => r.dir?.x ?? null), [null, TREE.DX, TREE.DX + TREE.INDENT]);
  assert.deepEqual(a.rows.map((r) => r.mid), [50, 90, 130]);
  assert.deepEqual(a.box, { x: 0, y: 34, w: 150, h: 112 });
  assert.equal(a.running, 1);
});

test("넘침: 작업자 5명까지는 그대로, 넘으면 4명 + '+N 더 보기', 누르면 전부", () => {
  const more = group(layout(), "a-슈퍼").rows[1].more!;
  assert.deepEqual(more.units.map((u) => u.role), ["a-작업5", "a-작업6", "a-작업7"]);
  assert.deepEqual([more.x, more.y], [TREE.CX + 4 * (TREE.CW + TREE.GAP), 74], "다섯째 칸 자리");
  const open = group(layout({ expanded: new Set(["a-감독"]) }), "a-슈퍼").rows[1];
  assert.equal(open.more, null);
  assert.equal(open.workers.length, 7);
  assert.deepEqual([open.workers[5].x, open.workers[5].y], [TREE.CX, 114], "여섯째는 다음 줄 첫 칸");
  assert.deepEqual(clip([1, 2, 3, 4, 5], 5, 4, false), { shown: [1, 2, 3, 4, 5], more: [] });
  assert.deepEqual(clip([1, 2, 3, 4, 5, 6], 5, 4, false), { shown: [1, 2, 3, 4], more: [5, 6] });
});

test("그림 폭이 좁으면 작업자 칸을 다음 줄로 내리고 그림 밖으로 넘기지 않는다", () => {
  const l = layout({ width: 640 }), a = group(l, "a-슈퍼");
  assert.equal(l.cols, 2);
  assert.deepEqual(a.rows[1].workers.map((c) => [c.x, c.y]), [[396, 74], [510, 74], [396, 114], [510, 114]]);
  assert.deepEqual([a.rows[1].more!.x, a.rows[1].more!.y], [396, 154]);
  assert.equal(a.rows[2].dir!.y, 194, "아래 감독 줄은 그만큼 밀린다");
  const right = [...a.rows.flatMap((r) => [...r.workers, ...(r.more ? [r.more] : [])]), ...l.lone!.cells, ...l.system.cells].map((c) => c.x + c.w);
  assert.ok(Math.max(...right) <= l.width, `오른쪽 끝 ${Math.max(...right)} ≤ ${l.width}`);
  assert.equal(layout({ width: 300 }).width, TREE.MIN_WIDTH, "이보다 좁으면 목록으로 바꾸므로 그림 폭은 더 줄이지 않는다");
  assert.equal(TREE.MIN_WIDTH, TREE.CX + 2 * TREE.CW + TREE.GAP, "최소 폭 = 작업자 칸 두 개가 들어가는 폭");
  assert.equal(layout({ width: TREE.MIN_WIDTH }).cols, 2);
});

test("맨 아래: 하위 없는 슈퍼감독 묶음 → 발령 전 창고 → 기반 세션 순서", () => {
  const l = layout();
  assert.deepEqual([l.lone!.y, l.lone!.total, roles(l.lone!.cells)], [306, 2, ["c-슈퍼", "d-슈퍼"]]);
  assert.deepEqual(l.lone!.cells.map((c) => [c.x, c.y]), [[0, 334], [160, 334]]);
  assert.deepEqual(l.lone!.cells.map((c) => c.h), [32, 32], "이름이 한 줄이면 칸 높이 32");
  assert.deepEqual(l.depot!.box, { x: 0, y: 388, w: 150, h: 58 });
  assert.deepEqual(l.depot!.crates, [{ x: 396, y: 398 }, { x: 413, y: 398 }, { x: 430, y: 398 }]);
  assert.deepEqual(l.system.box, { x: 0, y: 466, w: 150, h: 48 });
  assert.deepEqual(l.system.cells.map((c) => [c.x, c.y]), [[396, 474], [510, 474]]);
  assert.equal(l.height, 526);
  const empty = layout({ depot: 0, system: 0 });
  assert.equal(empty.depot, null, "창고가 비면 그리지 않는다");
  assert.equal(empty.system.box.y, 388);
});

test("하위 없는 슈퍼감독이 두 줄을 넘으면 '+N 더 보기'로 묶는다", () => {
  const supers = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`s${String(i).padStart(2, "0")}`, "@user"]));
  const many = buildForest(buildMap({ hierarchy: supers, rows: [], live: [], alerts: null }).bases, false);
  const l = layout({}, many);
  assert.equal(l.lone!.cells.length, 11);
  assert.equal(l.lone!.more!.units.length, 4);
  assert.equal(l.lone!.more!.key, LONE_KEY);
  assert.equal(layout({ expanded: new Set([LONE_KEY]) }, many).lone!.cells.length, 15);
});

test("쉬는 작업자는 기본으로 숨기고, 켜면 다시 놓는다", () => {
  const resting = buildMap({ hierarchy: { "s": "@user", "s-작업": "s" }, rows: [row("r/9", "s-작업", "planned")], live: [on("s", "claude")], alerts: null });
  assert.deepEqual(buildForest(resting.bases, false).lone.map((u) => u.role), ["s"], "쉬는 작업자만 있으면 하위 없는 슈퍼감독으로 묶인다");
  const shown = buildForest(resting.bases, true);
  assert.deepEqual(shown.groups.map((g) => g.tops.map((n) => n.unit.role)), [["s-작업"]]);
  assert.equal(isBranch(shown.groups[0].tops[0]), false);
});

test("글자 자르기와 창고 한 줄", () => {
  assert.equal(fitText("짧은이름", 100, 11.5), "짧은이름");
  assert.equal(fitText("아주긴역할이름입니다", 60, 10), "아주긴역할…");
  assert.equal(depotLine(map.depotRows), "진행 전 2장 · 일시정지 1장 · 판 미지정");
  assert.equal(depotLine([{ bucket: "planned", board: "판" }, { bucket: "etc", board: "" }]), "진행 전 1장 · 그 밖 1장");
  assert.equal(depotLine([]), "");
});

// PR #464 검수 발견(2026-11-23)
test("접힌 판의 상태 수는 한 곳(buildForest)에서 슈퍼감독을 빼고 세고, 그림 배치는 그 값을 그대로 쓴다", () => {
  const m = buildMap({ hierarchy: { "p-슈퍼": "@user", "p-감독": "p-슈퍼" }, rows: [], live: [on("p-슈퍼", "claude"), on("p-감독", "claude")], alerts: null });
  const f = buildForest(m.bases, false);
  assert.deepEqual(f.groups[0].counts, [{ state: "idle", n: 1 }], "대기 중인 슈퍼감독과 감독 한 명 → 하위 대기 1");
  assert.equal(layout({}, f).groups[0].counts, f.groups[0].counts, "같은 배열");
  assert.deepEqual(forest.groups[2].counts, [{ state: "dead", n: 1 }, { state: "idle", n: 2 }], "슈퍼감독 없는 판은 전부 센다");
});

test("넘칠 때 작업중인 것은 앞으로 옮겨 '더 보기' 뒤에 숨기지 않는다", () => {
  const seven = [1, 2, 3, 4, 5, 6, 7];
  assert.deepEqual(clip(seven, 5, 4, false, (n) => n === 7), { shown: [7, 1, 2, 3], more: [4, 5, 6] });
  assert.deepEqual(clip(seven, 5, 4, true, (n) => n === 7), { shown: [7, 1, 2, 3, 4, 5, 6], more: [] }, "펼쳐도 순서는 그대로");
  assert.deepEqual(clip([...seven, 8], 5, 4, false, (n) => n >= 3), { shown: [3, 4, 5, 6, 7, 8], more: [1, 2] }, "작업중이 keep보다 많으면 전부 보인다");
  assert.deepEqual(clip(seven, 5, 4, false, (n) => n >= 2), { shown: [2, 3, 4, 5, 6, 7, 1], more: [] }, "남은 하나는 묶지 않는다");
  assert.deepEqual(clip([1, 2, 3], 5, 4, false, (n) => n === 3), { shown: [1, 2, 3], more: [] }, "넘치지 않으면 순서를 바꾸지 않는다");
  const busy = buildMap({ hierarchy, rows: [...rows, row("r/7", "a-작업6", "running")], live, alerts: null });
  const a = group(layout({}, buildForest(busy.bases, false)), "a-슈퍼").rows[1];
  assert.deepEqual(roles(a.workers), ["a-작업1", "a-작업6", "a-작업2", "a-작업3"]);
  assert.deepEqual(a.more!.units.map((u) => u.role), ["a-작업4", "a-작업5", "a-작업7"]);
  assert.equal(a.more!.units.some(isRunning), false);
});

// ---- kyle 피드백 3가지(2026-11-23) 기대 결과 표 ----
const forestOf = (h: Record<string, string>, states: Record<string, "running" | "idle" | "stale">) => {
  const names = Object.keys(states);
  return buildForest(buildMap({
    hierarchy: h, alerts: null, live: Object.keys(h).filter((r) => states[r] !== "stale").map((r) => on(r, "claude")),
    rows: names.filter((r) => states[r] !== "idle").map((r, i) => row(`t/${i}`, r, states[r])),
  }).bases, false);
};
const under = (parent: string, names: string[]) => Object.fromEntries(names.map((n) => [n, parent]));

test("표 3행: 저장소 이름에 -가 있는 역할도 앞을 떼지 않고 전체 이름을 보인다", () => {
  const f = forestOf({ "home-board-슈퍼감독": "@user", "home-board-투자감독": "home-board-슈퍼감독", "home-board-신호수집-작업자": "home-board-투자감독" },
    { "home-board-신호수집-작업자": "running" });
  const g = layout({ fold: {} }, f).groups[0], r = g.rows[0];
  assert.deepEqual(r.dir!.name, ["home-board-투자감독"], "옛 규칙은 'board-투자감독'으로 앞 낱말을 뗐다");
  assert.deepEqual(g.name, ["home-board-", "슈퍼감독"]);
  assert.deepEqual(r.workers[0].name, ["home-board-", "신호수집-", "작업자"]);
  for (const lines of [r.dir!.name, g.name, r.workers[0].name]) assert.doesNotMatch(lines.join(""), /…/);
});

test("표 4행: 칸 폭을 넘는 24자 이름은 감독 칸·판 상자에서 두 줄로 나뉘고 낱말 중간에서 끊기지 않으며 …가 없다", () => {
  const director = "demo-partner-감사후속정리-감독-2", board = "designtools-studio-슈퍼감독2";
  assert.deepEqual([[...director].length, [...board].length], [24, 24]);
  assert.deepEqual(nameLines(director, "director"), ["demo-partner-", "감사후속정리-감독-2"]);
  assert.deepEqual(nameLines(board, "board"), ["designtools-", "studio-슈퍼감독2"]);
  assert.deepEqual(nameLines("paperlight-홈페이지-슈퍼감독", "lone"), ["paperlight-", "홈페이지-슈퍼감독"]);
  for (const [name, kind] of [[director, "director"], [board, "board"]] as const) {
    const lines = nameLines(name, kind);
    assert.equal(lines.join(""), name, "글자를 잃지 않는다");
    assert.match(lines[0], /-$/, "첫 줄은 - 뒤에서 끝난다(낱말 중간 아님)");
  }
  assert.deepEqual(nameLines("감독-4", "director"), ["감독-4"], "들어가면 한 줄 그대로");
});

test("표 4행(작업자·검수자 칸): 세 줄까지 줄바꿈하고, 세 줄도 넘으면 셋째 줄 끝만 …", () => {
  assert.deepEqual(nameLines("kadan-조각복구-검수자", "worker"), ["kadan-", "조각복구-", "검수자"], "두 줄에는 안 들어가던 이름이 세 줄로 다 보인다");
  assert.deepEqual(nameLines("sample_app-출시점검-검수자-43", "worker"), ["sample_app-", "출시점검-", "검수자-43"]);
  assert.deepEqual(nameLines("화면구현-작업자", "worker"), ["화면구현-", "작업자"]);
  assert.deepEqual(nameLines("super검수", "worker"), ["super검수"], "들어가면 한 줄 그대로");
  const long = nameLines("demo-labelgen-저장결함-검수자-후보", "worker");
  assert.equal(long.length, 3);
  assert.match(long[2], /…$/);
  assert.doesNotMatch(long[0] + long[1], /…/);
});

test("표 5행: 두 줄도 넘는 이름은 둘째 줄 끝을 …로 자르고, 한 낱말이 줄보다 길 때만 낱말 안에서 끊는다", () => {
  const lines = nameLines("shopfront-파트너스감사-후속정리-검수-감독-2", "director");
  assert.deepEqual(lines, ["shopfront-", "파트너스감사-후속정리…"]);
  assert.deepEqual(nameLines("demo-아주긴이름의감독역할-두번째줄도넘치는-감독", "director"), ["demo-", "아주긴이름의감독역할-…"], "긴 낱말을 앞줄로 당겨 쪼개지 않는다");
  assert.deepEqual(wrapText("가나다라마바사아자차카타파하", [40, 40], 10), ["가나다라", "마바사…"], "띄어쓰기도 -도 없는 긴 낱말");
  assert.deepEqual(wrapText("alpha beta gamma", [60, 60], 10), ["alpha beta", "gamma"], "공백에서도 줄을 바꾼다");
  assert.deepEqual(wrapText("짧음", [60, 60], 10), ["짧음"]);
});

test("줄 높이: 같은 줄의 칸은 그 줄에서 이름이 가장 긴 칸에 맞춘다", () => {
  const f = forestOf({ "h-슈퍼": "@user", "h-감독": "h-슈퍼", ...under("h-감독", ["h-짧음", "kadan-조각복구-검수자"]), "h-둘째-감독": "h-슈퍼", ...under("h-둘째-감독", ["h-작업"]) },
    { "h-짧음": "idle", "kadan-조각복구-검수자": "idle", "h-작업": "idle" });
  const [tall, short] = layout({ fold: {} }, f).groups[0].rows;
  assert.deepEqual([cellHeight(1), cellHeight(2), cellHeight(3)], [32, 45, 58]);
  assert.deepEqual([tall.dir!.h, ...tall.workers.map((c) => c.h)], [58, 58, 58], "세 줄 이름이 든 줄은 감독 칸까지 같은 높이");
  assert.deepEqual([short.dir!.h, ...short.workers.map((c) => c.h)], [32, 32]);
  assert.equal(short.dir!.y, tall.dir!.y + 58 + TREE.ROW_GAP, "다음 줄은 그만큼 내려간다");
});

const bundleForest = () => forestOf(
  { "t-슈퍼": "@user", "t-감독": "t-슈퍼", ...under("t-감독", ["t-작업1", "t-작업2", "t-대기1", "t-옛1", "t-옛2", "t-옛3"]),
    "u-감독": "t-슈퍼", ...under("u-감독", ["u-1", "u-2", "u-3", "u-4", "u-5", "u-6", "u-옛1", "u-옛2"]) },
  { "t-작업1": "running", "t-작업2": "running", "t-대기1": "idle", "t-옛1": "stale", "t-옛2": "stale", "t-옛3": "stale",
    "u-1": "idle", "u-2": "idle", "u-3": "idle", "u-4": "idle", "u-5": "idle", "u-6": "idle", "u-옛1": "stale", "u-옛2": "stale" });
const cellX = (i: number) => TREE.CX + i * (TREE.CW + TREE.GAP);

test("표 6행: 작업중 2 + 대기 1 + 오래된 미확정 3 → 살아 있는 칸 3개 뒤에 '오래된 미확정 3' 묶음 한 칸, '+N 더 보기' 없음", () => {
  const row = layout({ fold: {} }, bundleForest()).groups[0].rows[0];
  assert.equal(row.dir!.unit.role, "t-감독");
  assert.deepEqual(roles(row.workers), ["t-대기1", "t-작업1", "t-작업2"]);
  assert.equal(row.more, null);
  assert.deepEqual(row.stale!.units.map((u) => u.role), ["t-옛1", "t-옛2", "t-옛3"]);
  assert.deepEqual([row.stale!.x, row.stale!.y], [cellX(3), row.workers[0].y], "넷째 칸 자리");
  assert.deepEqual(row.old, []);
});

test("표 7행: 살아 있는 6 + 오래된 미확정 2 → 살아 있는 4칸 + '+2 더 보기' + '오래된 미확정 2'", () => {
  const row = layout({ fold: {} }, bundleForest()).groups[0].rows[1];
  assert.equal(row.dir!.unit.role, "u-감독");
  assert.deepEqual(roles(row.workers), ["u-1", "u-2", "u-3", "u-4"]);
  assert.deepEqual(row.more!.units.map((u) => u.role), ["u-5", "u-6"], "넘침 셈에 오래된 미확정은 들어가지 않는다");
  assert.equal(row.more!.x, cellX(4));
  assert.deepEqual(row.stale!.units.map((u) => u.role), ["u-옛1", "u-옛2"]);
  assert.deepEqual([row.stale!.x, row.stale!.y], [cellX(0), row.workers[0].y + 32 + TREE.ROW_GAP], "여섯째 자리 = 다음 줄 첫 칸");
});

test("표 8행: 묶음 칸을 누르면 그 자리에 오래된 미확정 칸이 펼쳐진다", () => {
  const f = bundleForest(), row = layout({ fold: {}, expanded: new Set([staleKey("t-감독")]) }, f).groups[0].rows[0];
  assert.equal(row.stale, null);
  assert.deepEqual(roles(row.workers), ["t-대기1", "t-작업1", "t-작업2"]);
  assert.deepEqual(roles(row.old), ["t-옛1", "t-옛2", "t-옛3"]);
  assert.deepEqual(row.old.map((c) => c.x), [cellX(3), cellX(4), cellX(0)], "묶음이 있던 넷째 자리부터");
  const other = layout({ fold: {}, expanded: new Set([staleKey("t-감독")]) }, f).groups[0].rows[1];
  assert.equal(other.stale!.units.length, 2, "다른 줄의 묶음은 그대로");
  const both = arrange(f.groups[0].units.filter((u) => u.parent === "u-감독"), "u-감독", 5, 4, new Set(["u-감독", staleKey("u-감독")]));
  assert.deepEqual([both.shown.length, both.more.length, both.old.length, both.oldOpen], [6, 0, 2, true], "더 보기와 묶음은 따로 펼친다");
});

test("표 10행: 접힌 판의 상태 개수는 오래된 미확정을 포함해 센다(슈퍼감독 제외)", () => {
  const f = bundleForest();
  assert.deepEqual(f.groups[0].counts, [{ state: "running", n: 2 }, { state: "stale", n: 5 }, { state: "idle", n: 9 }]);
  assert.equal(layout({ fold: { "t-슈퍼": false } }, f).groups[0].counts, f.groups[0].counts);
});
