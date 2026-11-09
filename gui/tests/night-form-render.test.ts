import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module, { createRequire } from "node:module";

// PR3b 나이트런 정책 양식을 실제 React 소스 서버 렌더로 확인한다(숨김·잠금·처음 상태).
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
const NightPolicyForm = req("./src/NightPolicyForm.tsx").default;
const { AppContext } = req("./src/ui.tsx");
const line = { github: "o/a", repo: "a", settings: { deployBranch: null, nightMerge: null }, verdict: { action: "merge", reason: "allowed" },
  effective: { deployBranch: { value: "main", from: "ontology" }, nightMerge: { value: null, from: null } } };
const render = (context: object, nightOn: boolean | null) => renderToStaticMarkup(React.createElement(AppContext.Provider,
  { value: { token: "fake-token", readOnly: false, draft: () => {}, notice: () => {}, ...context } },
  React.createElement(NightPolicyForm, { line, nightOn })));

test("양식: 원격 읽기 전용이면 아무것도 그리지 않는다", () => assert.equal(render({ readOnly: true }, false), ""));
test("양식: 처음엔 저장이 꺼져 있고 연결 문서 값 안내·지우기 안내가 보인다. 칸은 비어 있다(연결 문서 값으로 채우지 않음)", () => {
  const html = render({}, false);
  assert.match(html, /<button type="submit" disabled="">저장<\/button>/);
  assert.match(html, /연결 문서 값: main/);
  assert.match(html, /<option value="" selected="">\(그대로\)<\/option>|<option value="">\(그대로\)<\/option>/);
  assert.doesNotMatch(html, /value="main"/);
  assert.match(html, /kadan night repo o\/a --clear deployBranch\|nightMerge/);
  assert.doesNotMatch(html, /밤 머지/);
});
test("양식: 나이트런 켜짐이면 지우지 않고 막아 둔 채 이유를 보인다", () => {
  const html = render({}, true);
  assert.match(html, /나이트런 켜짐 동안 바꿀 수 없음/);
  assert.match(html, /disabled=""/);
});

test("양식: 저장 성공 기록이 있으면 다시 그려도 '저장했습니다 · HH:MM'이 보인다", () => {
  const { rememberSaved, forgetSaved } = req("./src/night-form.ts");
  rememberSaved("o/a", new Date(2026, 10, 4, 14, 7));
  assert.match(render({}, false), /저장했습니다 · 14:07/);
  forgetSaved("o/a");
  assert.doesNotMatch(render({}, false), /저장했습니다/);
});
