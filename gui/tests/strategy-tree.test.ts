import test from "node:test";
import assert from "node:assert/strict";
import { buildMap } from "../src/strategy-map.ts";
import {
  buildForest, clip, defaultOpen, isRunning, depotLine, fitText, flatten, harnessName, isBranch, layoutTree, LONE_KEY, shapeOf, stateCounts, TREE,
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
const layout = (over: Partial<Parameters<typeof layoutTree>[1]> = {}, f: Forest = forest) =>
  layoutTree(f, { width: 980, fold: {}, expanded: new Set(), selected: null, depot: map.depot, system: 2, ...over });
const allOpen = { "a-슈퍼": true, "b-슈퍼": true, "관계표 밖": true };
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
      ...g.rows.flatMap((r) => [...(r.dir ? [r.dir.unit.role] : []), ...roles(r.workers), ...(r.more?.units.map((u) => u.role) ?? [])])]),
    ...roles(l.lone!.cells), ...(l.lone!.more?.units.map((u) => u.role) ?? []),
  ];
  const visible = map.bases.flatMap((b) => b.units).map((u) => u.role);
  assert.deepEqual([...placed].sort(), [...visible].sort());
  assert.equal(new Set(placed).size, placed.length, "두 번 놓인 역할 없음");
});

test("작업중이 든 판만 펼친 채로 시작하고, 누른 값과 고른 역할이 그 기본을 바꾼다", () => {
  assert.deepEqual(layout().groups.map((g) => g.open), [true, false, false]);
  assert.deepEqual(layout({ fold: { "a-슈퍼": false, "b-슈퍼": true } }).groups.map((g) => g.open), [false, true, false]);
  assert.deepEqual(layout({ selected: "b-작업" }).groups.map((g) => g.open), [true, true, false], "고른 역할이 든 판은 펴진다");
  assert.equal(defaultOpen(forest.groups[1].units, null), false);
});

test("접은 줄: 하위 상태 개수를 합쳐 보이고 줄은 그리지 않는다", () => {
  const l = layout();
  assert.deepEqual(group(l, "b-슈퍼").counts, [{ state: "idle", n: 2 }], "슈퍼감독 자신은 세지 않는다");
  assert.deepEqual(group(l, "관계표 밖").counts, [{ state: "dead", n: 1 }, { state: "idle", n: 2 }]);
  assert.deepEqual(group(l, "b-슈퍼").rows, []);
  assert.deepEqual(group(l, "b-슈퍼").box, { x: 0, y: 166, w: 150, h: TREE.FOLDED });
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
  assert.deepEqual(l.depot!.box, { x: 0, y: 400, w: 150, h: 58 });
  assert.deepEqual(l.depot!.crates, [{ x: 396, y: 410 }, { x: 413, y: 410 }, { x: 430, y: 410 }]);
  assert.deepEqual(l.system.box, { x: 0, y: 478, w: 150, h: 48 });
  assert.deepEqual(l.system.cells.map((c) => [c.x, c.y]), [[396, 486], [510, 486]]);
  assert.equal(l.height, 538);
  const empty = layout({ depot: 0, system: 0 });
  assert.equal(empty.depot, null, "창고가 비면 그리지 않는다");
  assert.equal(empty.system.box.y, 400);
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
