import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module, { createRequire } from "node:module";

// 전략 맵 옆 칸의 '다시 띄우기'(2026-10-25 담당자 상태 표에서 옮김)를 실제 React 소스를 서버 렌더로 확인한다.
// 화면 자료(useResource·save)와 이동(navigation)만 가짜로 바꾸고 RestartRole·StrategyMap·ui는 진짜 소스를 쓴다(decision-link-render와 같은 방식).
const root = path.resolve(import.meta.dirname, "..");
const req = createRequire(path.join(root, "package.json"));
const ts = req("typescript"), React = req("react"), { renderToStaticMarkup } = req("react-dom/server");

const g = globalThis as Record<string, unknown>;
g.window ??= { localStorage: { getItem: () => null, setItem: () => {} } };
const status = { rows: [], live: [], alerts: null, hierarchy: null, collectedAt: new Date().toISOString() };
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
const { RestartRole } = req("./src/pages/RestartRole.tsx");
const StrategyMap = req("./src/pages/StrategyMap.tsx").default;
const { AppContext } = req("./src/ui.tsx");

const wrap = (context: object, child: unknown) => renderToStaticMarkup(React.createElement(AppContext.Provider,
  { value: { token: "fake-token", readOnly: false, draft: () => {}, notice: () => {}, ...context } }, child));
const restart = (context: object, generation: string | null) =>
  wrap(context, React.createElement(RestartRole, { role: "t-작업자", generation }));

test("다시 띄우기: 세대가 있고 쓰기 가능하면 버튼, 원격 읽기 전용·세대 없음이면 아무것도 그리지 않는다", () => {
  assert.match(restart({}, "101"), /다시 띄우기/);
  assert.equal(restart({ readOnly: true }, "101"), "", "원격 읽기 전용이면 버튼 없음");
  assert.equal(restart({}, null), "", "세대가 없으면 버튼 없음");
});

test("옛 #sessions 주소로 오면 전략 맵에 옮겼다는 안내 한 줄이 뜬다", () => {
  const map = (hash: string) => wrap({}, React.createElement(StrategyMap, { url: new URL("https://kadan.example.com/" + hash) }));
  assert.match(map("#sessions"), /담당자 상태는 전략 맵으로 옮겼습니다/);
  assert.doesNotMatch(map("#strategy-map"), /담당자 상태는 전략 맵으로 옮겼습니다/);
});
