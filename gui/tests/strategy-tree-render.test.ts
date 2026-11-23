import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module, { createRequire } from "node:module";

// 전략 맵 '나무' 보기를 실제 React 소스의 서버 렌더로 확인한다(restart-role-render와 같은 방식).
// 화면 자료(useResource)와 이동(navigation)만 가짜로 바꾸고 StrategyMap·StrategyTree·배치 계산은 진짜 소스를 쓴다.
const root = path.resolve(import.meta.dirname, "..");
const req = createRequire(path.join(root, "package.json"));
const ts = req("typescript"), React = req("react"), { renderToStaticMarkup } = req("react-dom/server");

let savedView: string | null = null;
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => savedView, setItem: () => {} } });
const on = (role: string, harness: string | null) => ({ role, harness, model: "m", effort: null, pidState: "match" });
const workers = [1, 2, 3, 4, 5, 6, 7].map((n) => `a-작업${n}`);
const status = {
  collectedAt: new Date().toISOString(), alerts: null,
  hierarchy: {
    "a-슈퍼": "@user", "a-감독": "a-슈퍼", ...Object.fromEntries(workers.map((w) => [w, "a-감독"])),
    "b-슈퍼": "@user", "b-감독": "b-슈퍼", "b-작업": "b-감독", "c-슈퍼": "@user",
  },
  live: [on("a-슈퍼", "claude"), on("a-감독", "claude"), ...workers.map((w) => on(w, "codex")),
    on("b-슈퍼", "claude"), on("b-감독", "claude"), on("b-작업", "agy"), on("c-슈퍼", "claude"), on("watch", null)],
  rows: [{ key: "r/1", owner: "a-작업1", bucket: "running", title: "t" }, { key: "r/2", owner: "", bucket: "planned", title: "t" }],
};
let current: object = status; // 화면이 읽는 자료. 시험마다 바꿔 끼운다
const M = Module as unknown as { _load: (...a: unknown[]) => unknown; _extensions: Record<string, (m: { _compile: (c: string, f: string) => void }, f: string) => void> };
const original = M._load;
M._load = function (request: string, parent: { filename?: string } | null, isMain: boolean) {
  if (parent?.filename?.startsWith(path.join(root, "src") + path.sep) && /^\.\.?\/resource$/.test(request))
    return { useResource: () => ({ data: current, error: null, refresh: () => {} }), save: () => { throw new Error("writes disabled"); } };
  if (parent?.filename?.startsWith(path.join(root, "src") + path.sep) && /^\.\.?\/navigation$/.test(request))
    return new Proxy({}, { get: (_, key) => (key === "__esModule" ? false : () => "/") });
  return original.call(this, request, parent, isMain);
};
for (const ext of [".ts", ".tsx"]) M._extensions[ext] = (module, filename) => {
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  module._compile(code, filename);
};
const StrategyMap = req("./src/pages/StrategyMap.tsx").default;
const { TreeList, TreeSvg } = req("./src/pages/StrategyTree.tsx");
const { buildMap } = req("./src/strategy-map.ts");
const { buildForest } = req("./src/strategy-tree.ts");
const { AppContext } = req("./src/ui.tsx");

const page = (view: string | null) => {
  savedView = view;
  return renderToStaticMarkup(React.createElement(AppContext.Provider,
    { value: { token: "fake-token", readOnly: false, draft: () => {}, notice: () => {} } },
    React.createElement(StrategyMap, { url: new URL("https://kadan.example.com/#strategy-map") })));
};
const stage = (html: string) => html.slice(html.indexOf('class="sm-stage"'));

test("전략 맵은 나무 보기 하나: 보기 전환 단추가 없고 나무 그림을 그린다", () => {
  const html = page(null);
  assert.doesNotMatch(html, /sm-viewswitch|aria-label="지도 보기"|>2D<|>3D<|>나무</, "전환 단추 없음");
  assert.doesNotMatch(html, /기지와 유닛 지도|왕관 = 슈퍼감독|<canvas/, "2D·3D 그림과 그 범례 없음");
  assert.match(html, /aria-label="판과 역할 나무"/);
  // 소개 문단은 kyle이 승인한 두 문장 그대로다(PR #465 검수 F1). 덧붙은 문장·링크가 없어야 한다.
  assert.equal(html.match(/<header class="st-lead"><h1>전략 맵<\/h1><p>(.*?)<\/p>/)?.[1],
    "슈퍼감독마다 판 하나, 그 아래 감독과 작업자·검수자가 이어집니다. 칸을 누르면 옆 칸(좁은 화면에서는 아래)에 그 역할의 카드가 보입니다.");
  assert.doesNotMatch(html, /기지 하나|유닛 옆 상자/, "옛 소개 문단 없음");
  assert.match(html, /<b[^>]*>3<\/b> 판|>3<[^>]*> 판/, "집계 줄에 판 수");
  assert.match(html, /대기 역할/);
  assert.match(html, /큰 상자 = 슈퍼감독 · 둥근 상자 = 감독/);
  assert.match(html, />지시</);
  assert.match(html, />\+3 더 보기</);
  assert.match(html, /하위 역할 없는 슈퍼감독 1/);
  assert.match(html, /발령 전 창고/);
  assert.match(html, /담당이 정해지지 않은 카드 \(누르면 옆 칸에 목록\)/);
  assert.match(html, /aria-label="a-작업1 · 작업자·검수자 · codex · 작업중"/);
  assert.match(html, /aria-expanded="true" aria-label="b-슈퍼 하위 역할"/, "작업중이 없는 판도 펼친 채로 시작(kyle 피드백 표 1행)");
  assert.match(html, /aria-label="b-작업 · 작업자·검수자 · agy · 대기"/);
  assert.doesNotMatch(html, /class="smt-count"/, "접힌 판이 없으니 접은 줄의 상태 개수도 없다");
  assert.match(html, /aria-label="기반 세션"/, "지도 아래 기반 세션 표는 그대로");
  assert.match(html, /유닛이나 발령 전 창고를 누르면 상태와 카드가 여기에 보입니다\./, "옆 칸 자리는 그대로");
});

test("옛 보기 값(2d·3d)이 저장된 브라우저도 같은 나무 보기로 열린다", () => {
  const base = stage(page(null));
  assert.match(base, /aria-label="판과 역할 나무"/);
  for (const view of ["2d", "3d", "tree", "4d"]) assert.equal(stage(page(view)), base, `저장값 ${view}`);
});

test("좁은 화면의 접는 목록: 모두 펼친 채로 시작하고, 사람이 접은 줄에는 하위 상태 개수만 남는다", () => {
  const map = buildMap({ hierarchy: status.hierarchy, rows: status.rows, live: status.live, alerts: null });
  const list = (fold: Record<string, boolean>, expanded: string[] = []) => renderToStaticMarkup(React.createElement(TreeList, {
    forest: buildForest(map.bases, false), model: map, sessions: [status.live.at(-1)], fold, expanded: new Set(expanded),
    selected: "a-작업1", depotKey: "depot", onSelect: () => {}, onFold: () => {}, onMore: () => {},
  }));
  const html = list({});
  for (const label of ["a-슈퍼 하위 역할", "b-슈퍼 하위 역할", "a-감독 하위 역할", "b-감독 하위 역할", "하위 역할 없는 슈퍼감독", "기반 세션"])
    assert.match(html, new RegExp(`aria-expanded="true" aria-label="${label}"`), `${label}: 펼친 채`);
  assert.doesNotMatch(html, /aria-expanded="false"/);
  assert.match(html, /슈퍼감독 · claude · 유닛 9/);
  assert.match(html, /claude · 대기 · 하위 7/);
  assert.match(html, /aria-pressed="true" title="a-작업1"/);
  assert.match(html, /title="b-작업"/, "작업중이 없는 판의 하위 역할도 보인다");
  assert.match(html, /agy · 대기/);
  assert.match(html, /title="c-슈퍼"/, "하위 없는 슈퍼감독 묶음도 펼친 채");
  assert.match(html, /발령 전 창고 1/);
  assert.match(html, /기반 세션 1/);
  assert.doesNotMatch(html, /더 보기/, "하위 7명은 8명 이하라 그대로");
  const folded = list({ "b-슈퍼": false });
  assert.match(folded, /aria-expanded="false" aria-label="b-슈퍼 하위 역할"/);
  assert.doesNotMatch(folded, /title="b-작업"|title="b-감독"/, "접은 판의 하위 역할은 그리지 않는다");
  assert.match(folded, /title="대기"><i class="sm-dot sm-s-idle"><\/i>2</, "접은 b 판: 슈퍼감독 자신은 빼고 감독·작업자 2명이 대기");
  assert.doesNotMatch(folded, /title="대기"><i class="sm-dot sm-s-idle"><\/i>3</);
  assert.doesNotMatch(list({ "b-감독": false }), /title="b-작업"/, "감독 줄을 접으면 그 아래만 숨는다");
});

// PR #464 검수 발견(2026-11-23): 같은 자료를 넓은 그림과 좁은 목록이 다르게 보이면 안 된다.
type Fake = { hierarchy: Record<string, string>; live: ReturnType<typeof on>[]; rows: { key: string; owner: string; bucket: string; title: string }[] };
// 같은 자료·같은 접기 상태로 넓은 그림(TreeSvg, 폭 980)과 좁은 목록(TreeList)을 그린다.
const both = (data: Fake, fold: Record<string, boolean> = {}, expanded: string[] = []) => {
  const map = buildMap({ ...data, alerts: null });
  const props = {
    forest: buildForest(map.bases, false), model: map, sessions: [], fold, expanded: new Set(expanded),
    selected: null, depotKey: "depot", onSelect: () => {}, onFold: () => {}, onMore: () => {},
  };
  return {
    wide: renderToStaticMarkup(React.createElement(TreeSvg, { ...props, width: 980 })) as string,
    narrow: renderToStaticMarkup(React.createElement(TreeList, props)) as string,
  };
};

test("접힌 판의 하위 상태 수: 슈퍼감독 자신은 빼고, 넓은 그림과 좁은 목록이 같은 값", () => {
  const { wide, narrow } = both({
    hierarchy: { "p-슈퍼": "@user", "p-감독": "p-슈퍼", "p-작업": "p-감독" },
    live: [on("p-슈퍼", "claude"), on("p-감독", "claude")],
    rows: [{ key: "r/1", owner: "p-작업", bucket: "stale", title: "t" }],
  }, { "p-슈퍼": false });
  const inWide = [...wide.matchAll(/class="smt-count"[^>]*><title>([^<]+)<\/title><circle[^>]*><\/circle><text[^>]*>(\d+)<\/text>/g)].map((m) => `${m[1]} ${m[2]}`);
  const inNarrow = [...narrow.matchAll(/<span title="([^"]+)"><i class="sm-dot sm-s-[a-z]+"><\/i>(\d+)<\/span>/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(inWide, ["오래된 미확정 1", "대기 1"], "대기는 감독 1명 — 대기 중인 슈퍼감독은 세지 않는다");
  assert.deepEqual(inNarrow, inWide);
});

test("작업중인 가지와 역할은 '더 보기' 뒤에 숨지 않는다: 감독 줄은 전부, 작업자는 작업중을 앞으로", () => {
  const two = (n: number) => String(n).padStart(2, "0"), ten = Array.from({ length: 10 }, (_, i) => two(i + 1));
  const { wide, narrow } = both({
    hierarchy: {
      "p-슈퍼": "@user",
      ...Object.fromEntries(ten.flatMap((n) => [[`p-감독${n}`, "p-슈퍼"], [`p-옛작업${n}`, `p-감독${n}`]])),
      ...Object.fromEntries(ten.map((n) => [`p-일꾼${n}`, "p-감독10"])),
    },
    live: [on("p-슈퍼", "claude"), ...ten.map((n) => on(`p-감독${n}`, "claude")), ...ten.map((n) => on(`p-일꾼${n}`, "codex"))],
    rows: [{ key: "r/1", owner: "p-일꾼10", bucket: "running", title: "t" }],
  });
  for (const n of ten) assert.match(narrow, new RegExp(`title="p-감독${n}"`), `좁은 목록에 감독 ${n} 줄이 보인다`);
  assert.match(narrow, /aria-expanded="true" aria-label="p-감독10 하위 역할"/, "열째 감독 가지는 펼친 채");
  assert.match(narrow, /title="p-일꾼10"/, "열째 작업자(작업중)가 묶음 앞에 보인다");
  assert.deepEqual([...narrow.matchAll(/title="p-일꾼(\d+)"/g)].map((m) => m[1]), ["10", "01", "02", "03", "04", "05"]);
  assert.deepEqual([...narrow.matchAll(/>(\+\d+ 더 보기)</g)].map((m) => m[1]), ["+4 더 보기"], "묶음은 감독 아래 작업자 줄 하나뿐");
  for (const n of ten) assert.match(wide, new RegExp(`aria-label="p-감독${n} · 감독 ·`), `넓은 그림에 감독 ${n} 줄이 보인다`);
  assert.deepEqual([...wide.matchAll(/aria-label="p-일꾼(\d+) ·/g)].map((m) => m[1]), ["10", "01", "02", "03"], "넓은 그림도 작업중을 앞으로");
  assert.match(wide, />\+6 더 보기</);
});

// ---- kyle 피드백 3가지(2026-11-23) 기대 결과 표: 화면에 그려진 꼴 ----
const names = (n: number, f: (k: number) => string) => Array.from({ length: n }, (_, i) => f(i + 1));
const stale = (owner: string, i: number) => ({ key: `s/${owner}/${i}`, owner, bucket: "stale", title: "t" });
const running = (owner: string, i: number) => ({ key: `r/${owner}/${i}`, owner, bucket: "running", title: "t" });
// 넓은 그림: 칸·묶음을 그려진 순서대로. 좁은 목록: 줄을 순서대로.
const wideOrder = (html: string) => [...html.matchAll(/class="smt-unit[^"]*" role="button" tabindex="0" aria-label="([^"·]+) ·|class="smt-(?:more|stale)"[^>]*aria-label="([^":]+):/g)].map((m) => m[1] ?? `[${m[2]}]`);
const narrowOrder = (html: string) => [...html.matchAll(/<button type="button" class="smt-pick[^"]*"[^>]*title="([^"]+)"|<button type="button" class="smt-more-row[^"]*"[^>]*>([^<]+)</g)].map((m) => m[1] ?? `[${m[2]}]`);
const bundle: Fake = {
  hierarchy: {
    "t-슈퍼": "@user", "t-감독": "t-슈퍼", "u-감독": "t-슈퍼",
    ...Object.fromEntries(["t-작업1", "t-작업2", "t-대기1", "t-옛1", "t-옛2", "t-옛3"].map((r) => [r, "t-감독"])),
    ...Object.fromEntries([...names(6, (k) => `u-${k}`), "u-옛1", "u-옛2"].map((r) => [r, "u-감독"])),
  },
  live: ["t-슈퍼", "t-감독", "u-감독", "t-작업1", "t-작업2", "t-대기1", ...names(6, (k) => `u-${k}`)].map((r) => on(r, "claude")),
  rows: [running("t-작업1", 1), running("t-작업2", 2), ...["t-옛1", "t-옛2", "t-옛3", "u-옛1", "u-옛2"].map(stale)],
};

test("표 6·7행: 오래된 미확정은 살아 있는 칸 뒤 줄 끝의 묶음 한 칸으로 — 넓은 그림과 좁은 목록이 같은 순서", () => {
  const { wide, narrow } = both(bundle);
  assert.deepEqual(wideOrder(wide), [
    "t-감독", "t-대기1", "t-작업1", "t-작업2", "[오래된 미확정 3]",
    "u-감독", "u-1", "u-2", "u-3", "u-4", "[+2 더 보기]", "[오래된 미확정 2]", "t-슈퍼",
  ]);
  assert.deepEqual(narrowOrder(narrow), [
    "t-슈퍼", "t-감독", "t-대기1", "t-작업1", "t-작업2", "[오래된 미확정 3]",
    "u-감독", "u-1", "u-2", "u-3", "u-4", "u-5", "u-6", "[오래된 미확정 2]",
  ], "좁은 목록은 넘침 기준이 8줄이라 살아 있는 6명이 다 보인다");
  assert.match(wide, /class="smt-stale" role="button" tabindex="0" aria-label="오래된 미확정 3: t-옛1, t-옛2, t-옛3"/);
  assert.match(narrow, /aria-label="오래된 미확정 3: t-옛1, t-옛2, t-옛3"/);
  assert.doesNotMatch(wide + narrow, /t-옛1 ·|title="t-옛1"/, "묶인 역할의 칸은 그리지 않는다");
});

test("표 8행: 묶음을 누르면(펼침 상태) 그 자리에 오래된 미확정 칸이 놓이고, 칸마다 누를 수 있다", () => {
  const { wide, narrow } = both(bundle, {}, ["t-감독\u0000stale"]);
  assert.deepEqual(wideOrder(wide).slice(0, 8), ["t-감독", "t-대기1", "t-작업1", "t-작업2", "t-옛1", "t-옛2", "t-옛3", "u-감독"]);
  assert.deepEqual(narrowOrder(narrow).slice(0, 8), ["t-슈퍼", "t-감독", "t-대기1", "t-작업1", "t-작업2", "t-옛1", "t-옛2", "t-옛3"]);
  assert.match(wide, /class="smt-unit smt-worker" role="button" tabindex="0" aria-label="t-옛2 · 작업자·검수자 · 세션 · 오래된 미확정" aria-pressed="false"/);
  assert.match(narrow, /<button type="button" class="smt-pick smt-k-worker" aria-pressed="false" title="t-옛2">/);
  assert.match(wide + narrow, /오래된 미확정 2/, "다른 줄의 묶음은 그대로");
});

test("표 3·4·5행: 이름은 앞을 떼지 않고 줄을 나눠 그리며, 잘린 이름도 툴팁·읽기 이름에는 전체가 있다", () => {
  const long = "shopfront-파트너스감사-후속정리-검수-감독-2", worker = "home-board-신호수집-작업자";
  const { wide, narrow } = both({
    // long은 관계표에 하위가 있어 감독이다(하위는 창도 일도 없어 지도에 오르지 않는다).
    hierarchy: { "home-board-슈퍼감독": "@user", "home-board-투자감독": "home-board-슈퍼감독", [worker]: "home-board-투자감독", [long]: "home-board-슈퍼감독", "옛-작업자": long },
    live: ["home-board-슈퍼감독", "home-board-투자감독", worker, long].map((r) => on(r, "claude")),
    rows: [running(worker, 1)],
  });
  const lines = (role: string) => [...(wide.match(new RegExp(`aria-label="${role} ·[^"]*"[^>]*>(.*?)</g>`))?.[1] ?? "").matchAll(/<text class="smt-t1"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  assert.deepEqual(lines("home-board-투자감독"), ["home-board-투자감독"]);
  assert.deepEqual(lines("home-board-슈퍼감독"), ["home-board-", "슈퍼감독"]);
  assert.deepEqual(lines(worker), ["home-board-", "신호수집-", "작업자"]);
  assert.deepEqual(lines(long), ["shopfront-", "파트너스감사-후속정리…"]);
  assert.match(wide, new RegExp(`<title>${long} · 감독 · claude · 대기</title>`), "전체 이름은 툴팁에");
  assert.match(wide, new RegExp(`aria-label="${long} · 감독 · claude · 대기"`), "읽기 이름에도");
  assert.doesNotMatch(wide + narrow, />board-투자감독</, "앞 낱말을 뗀 옛 이름이 아니다");
  // 좁은 목록은 전체 이름을 그대로 적고 줄바꿈·줄 수 제한은 CSS(.smt-nm)가 한다.
  for (const role of ["home-board-투자감독", worker, long]) assert.match(narrow, new RegExp(`title="${role}"[^>]*>.*?<span class="smt-nm">${role}</span>`));
  assert.match(narrow, new RegExp(`class="smt-pick smt-k-worker" aria-pressed="false" title="${worker}"`), "작업자·검수자 줄은 세 줄까지(.smt-k-worker)");
});
