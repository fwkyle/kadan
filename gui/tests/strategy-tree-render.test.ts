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
const M = Module as unknown as { _load: (...a: unknown[]) => unknown; _extensions: Record<string, (m: { _compile: (c: string, f: string) => void }, f: string) => void> };
const original = M._load;
M._load = function (request: string, parent: { filename?: string } | null, isMain: boolean) {
  if (parent?.filename?.startsWith(path.join(root, "src") + path.sep) && /^\.\.?\/resource$/.test(request))
    return { useResource: () => ({ data: status, error: null, refresh: () => {} }), save: () => { throw new Error("writes disabled"); } };
  if (parent?.filename?.startsWith(path.join(root, "src") + path.sep) && /^\.\.?\/navigation$/.test(request))
    return new Proxy({}, { get: (_, key) => (key === "__esModule" ? false : () => "/") });
  return original.call(this, request, parent, isMain);
};
for (const ext of [".ts", ".tsx"]) M._extensions[ext] = (module, filename) => {
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  module._compile(code, filename);
};
const StrategyMap = req("./src/pages/StrategyMap.tsx").default;
const { TreeList } = req("./src/pages/StrategyTree.tsx");
const { buildMap } = req("./src/strategy-map.ts");
const { buildForest } = req("./src/strategy-tree.ts");
const { AppContext } = req("./src/ui.tsx");

const page = (view: string | null) => {
  savedView = view;
  return renderToStaticMarkup(React.createElement(AppContext.Provider,
    { value: { token: "fake-token", readOnly: false, draft: () => {}, notice: () => {} } },
    React.createElement(StrategyMap, { url: new URL("https://kadan.example.com/#strategy-map") })));
};
const pressed = (html: string) => [...html.matchAll(/<button type="button" aria-pressed="(true|false)">(2D|3D|나무)<\/button>/g)].map((m) => `${m[2]}:${m[1]}`);

test("보기 전환에 '나무'가 있고, 기억한 보기가 나무면 나무 그림을 그린다", () => {
  const html = page("tree");
  assert.deepEqual(pressed(html), ["2D:false", "3D:false", "나무:true"]);
  assert.match(html, /aria-label="판과 역할 나무"/);
  assert.match(html, /<b[^>]*>3<\/b> 판|>3<[^>]*> 판/, "집계 줄에 판 수");
  assert.match(html, /대기 역할/);
  assert.match(html, /큰 상자 = 슈퍼감독 · 둥근 상자 = 감독/);
  assert.doesNotMatch(html, /왕관 = 슈퍼감독/);
  assert.match(html, />지시</);
  assert.match(html, />\+3 더 보기</);
  assert.match(html, /하위 역할 없는 슈퍼감독 1/);
  assert.match(html, /발령 전 창고/);
  assert.match(html, /담당이 정해지지 않은 카드 \(누르면 옆 칸에 목록\)/);
  assert.match(html, /aria-label="a-작업1 · 작업자·검수자 · codex · 작업중"/);
  assert.match(html, /aria-expanded="false" aria-label="b-슈퍼 하위 역할"/, "작업중이 없는 판은 접힌 채로 시작");
  assert.doesNotMatch(html, /aria-label="b-작업 ·/, "접은 판의 하위 역할은 그리지 않는다");
});

test("기억한 보기가 없거나 모르는 값이면 2D, 2D·3D에는 나무 전용 줄이 없다", () => {
  for (const view of [null, "나무", "4d"]) assert.deepEqual(pressed(page(view)), ["2D:true", "3D:false", "나무:false"]);
  const html = page("2d");
  assert.match(html, /aria-label="기지와 유닛 지도"/);
  assert.match(html, /왕관 = 슈퍼감독 · 깃발 = 감독/);
  assert.doesNotMatch(html, /대기 역할|큰 상자 = 슈퍼감독/);
  assert.deepEqual(pressed(page("3d")), ["2D:false", "3D:true", "나무:false"]);
});

test("좁은 화면의 접는 목록: 접은 줄에 하위 상태 개수, 펼친 줄에 하위 역할, 넘치면 '+N 더 보기'", () => {
  const map = buildMap({ hierarchy: status.hierarchy, rows: status.rows, live: status.live, alerts: null });
  const list = (fold: Record<string, boolean>, expanded: string[] = []) => renderToStaticMarkup(React.createElement(TreeList, {
    forest: buildForest(map.bases, false), model: map, sessions: [status.live.at(-1)], fold, expanded: new Set(expanded),
    selected: "a-작업1", depotKey: "depot", onSelect: () => {}, onFold: () => {}, onMore: () => {},
  }));
  const html = list({});
  assert.match(html, /aria-expanded="true" aria-label="a-슈퍼 하위 역할"/);
  assert.match(html, /aria-expanded="false" aria-label="b-슈퍼 하위 역할"/);
  assert.match(html, /슈퍼감독 · claude · 유닛 9/);
  assert.match(html, /claude · 대기 · 하위 7/);
  assert.match(html, /aria-pressed="true" title="a-작업1"/);
  assert.doesNotMatch(html, /title="b-작업"/, "접은 판의 하위 역할은 그리지 않는다");
  assert.match(html, /title="대기"><i class="sm-dot sm-s-idle"><\/i>3</, "접은 b 판: 슈퍼감독·감독·작업자 3명이 대기");
  assert.match(html, /발령 전 창고 1/);
  assert.match(html, /기반 세션 1/);
  assert.doesNotMatch(html, /더 보기/, "하위 7명은 8명 이하라 그대로");
  assert.match(html, /aria-expanded="false" aria-label="하위 역할 없는 슈퍼감독"/);
  assert.match(html, /aria-expanded="true" aria-label="기반 세션"/);
  assert.doesNotMatch(list({ "b-슈퍼": true }), /title="b-작업"/, "판을 펴도 작업중이 없는 감독 가지는 접힌 채");
  const open = list({ "b-슈퍼": true, "b-감독": true });
  assert.match(open, /title="b-작업"/);
  assert.match(open, /agy · 대기/);
});
