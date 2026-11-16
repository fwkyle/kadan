import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module, {createRequire} from "node:module";

// 실제 React 화면을 렌더링한다. 조회와 이동만 가짜로 바꾸고 쓰기는 거절한다.
const root = path.resolve(import.meta.dirname, "..");
const req = createRequire(path.join(root, "package.json"));
const ts = req("typescript"), React = req("react"), {renderToStaticMarkup} = req("react-dom/server");
const g = globalThis as Record<string, unknown>;
g.window = {localStorage: {getItem: () => "[]", setItem: () => {}}};
const single = {id: "single", card: "repo/card", question: "단일 질문", status: "open",
  revision: 1, requestedBy: "test-슈퍼감독", options: ["예", "아니오"],
  recommendation: "예", reason: "이유", at: "2026-11-16T00:00:00Z"};
const bundle = {id: "bundle", card: null, bundle: true, repo: "repo", question: "묶음 질문",
  status: "open", revision: 2, requestedBy: "test-슈퍼감독", options: [],
  itemKeys: ["A1", "A2"], answered: {A1: "keep"}, reason: "이유", at: single.at};
const fixture = {items: [bundle, single], answered: 0, past: 0, collectedAt: single.at};
const M = Module as unknown as {
  _load: (...a: unknown[]) => unknown;
  _extensions: Record<string, (m: {_compile: (code: string, file: string) => void}, file: string) => void>;
};
const original = M._load;
M._load = function(request: string, parent: {filename?: string} | null, isMain: boolean) {
  if (parent?.filename?.startsWith(path.join(root, "src") + path.sep)
      && /^\.\.?\/(resource|navigation)$/.test(request)) {
    if (request.endsWith("/resource")) return {
      useResource: () => ({data: fixture, error: null, refresh: () => {}}),
      save: () => {throw new Error("writes disabled");},
    };
    return {navigate: () => {}, cardUrl: (key: string) => "/#card=" + key};
  }
  return original.call(this, request, parent, isMain);
};
for (const extension of [".ts", ".tsx"]) M._extensions[extension] = (module, filename) => {
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  }}).outputText;
  module._compile(code, filename);
};
const {default: Decisions, BundleDecision} = req("./src/pages/Decisions.tsx");
const {AppContext} = req("./src/ui.tsx");
const render = (node: unknown) => renderToStaticMarkup(React.createElement(AppContext.Provider,
  {value: {token: "fake", decisionToken: "fake", readOnly: false, draft: () => {}, notice: () => {}}}, node));

test("묶음과 단일 질문이 섞여도 화면을 그리고 단일 질문에만 답 양식을 둔다", () => {
  const html = render(React.createElement(Decisions, {url: new URL("http://127.0.0.1/#decisions")}));
  assert.match(html, /묶음 질문/);
  assert.match(html, /항목 2개 · 답 1개/);
  const onlyBundle = html.split('id="decision-bundle"')[1].split("</article>")[0];
  assert.doesNotMatch(onlyBundle, /<form|추천안|선택지 없이|답 화면 준비 중/);
  assert.equal((html.match(/<form\b/g) ?? []).length, 1);
  assert.match(html, /단일 질문/);
});

test("전부 답·취소된 묶음도 답 수만 읽기 전용으로 보인다", () => {
  for (const status of ["answered", "cancelled"]) {
    const html = render(React.createElement(BundleDecision, {decision: {...bundle, status}}));
    assert.match(html, /항목 2개 · 답 1개/);
    assert.match(html, status === "answered" ? /답변 완료/ : /취소/);
    assert.doesNotMatch(html, /<form|관련 카드|추천/);
  }
});
