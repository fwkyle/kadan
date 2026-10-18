import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module, { createRequire } from "node:module";

// 알림 링크(#decision-<id>)가 접어 둔 결정을 펼쳐 답하기 양식을 보이는지, 실제 React 소스를 서버 렌더로 확인한다(2026-10-18 검수 F2).
// 화면 자료(useResource)와 이동(navigation)만 가짜로 바꾸고, Decisions·ui·decision-fold·decision-link는 진짜 소스를 쓴다.
const root = path.resolve(import.meta.dirname, "..");
const req = createRequire(path.join(root, "package.json"));
const ts = req("typescript"), React = req("react"), { renderToStaticMarkup } = req("react-dom/server");

const g = globalThis as Record<string, unknown>;
g.__folded = [] as string[];
g.window = { localStorage: { getItem: () => JSON.stringify(g.__folded), setItem: () => {} } };
const decision = (id: string) => ({ id, card: "repo/card", question: "Q " + id, status: "open", revision: 1, requestedBy: "x-슈퍼감독",
  options: ["yes", "no"], recommendation: "yes", reason: "R", at: new Date().toISOString() });
const fixture = { items: [decision("target"), decision("other")], answered: 0, past: 0, collectedAt: new Date().toISOString() };

const M = Module as unknown as { _load: (...a: unknown[]) => unknown; _extensions: Record<string, (m: { _compile: (c: string, f: string) => void }, f: string) => void> };
const original = M._load;
M._load = function (request: string, parent: { filename?: string } | null, isMain: boolean) {
  if (parent?.filename?.startsWith(path.join(root, "src") + path.sep) && /^\.\.?\/(resource|navigation)$/.test(request)) {
    if (request.endsWith("/resource")) return { useResource: () => ({ data: fixture, error: null, refresh: () => {} }), save: () => { throw new Error("writes disabled"); } };
    return { navigate: () => {}, cardUrl: (x: string) => "/#card=" + x };
  }
  return original.call(this, request, parent, isMain);
};
for (const ext of [".ts", ".tsx"]) M._extensions[ext] = (module, filename) => {
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  module._compile(code, filename);
};
const Decisions = req("./src/pages/Decisions.tsx").default;
const { AppContext } = req("./src/ui.tsx");

const render = (context: object, hash = "#decision-target") => renderToStaticMarkup(React.createElement(AppContext.Provider,
  { value: { token: "", readOnly: true, draft: () => {}, notice: () => {}, ...context } },
  React.createElement(Decisions, { url: new URL("https://kadan.example.com/" + hash) })));
const bodyOf = (html: string, id: string) => html.match(new RegExp(`<div class="decision-body" id="decision-body-${id}"([^>]*)>`))?.[1] ?? "";
const remote = { decisionToken: "fake-test-token" };

test("링크 대상이 접혀 있어도 펼쳐지고 원격 답하기 양식이 보인다", () => {
  g.__folded = ["target"];
  const html = render(remote);
  assert.ok(!/hidden/.test(bodyOf(html, "target")), "대상 본문이 숨겨지지 않는다");
  assert.ok(html.includes('action="/decisions/answer"') || html.includes("<form"), "답하기 양식이 그려진다");
});

test("링크가 가리키지 않은 접힌 결정은 접힌 채로 있다", () => {
  g.__folded = ["other"];
  const html = render(remote);
  assert.ok(/hidden/.test(bodyOf(html, "other")));
  assert.ok(!/hidden/.test(bodyOf(html, "target")));
});

test("링크 없이 열면 접힌 결정은 접힌 채다", () => {
  g.__folded = ["target"];
  assert.ok(/hidden/.test(bodyOf(render(remote, "#decisions"), "target")));
});

test("원격 보기에서 결정 token이 없으면 양식이 없다", () => {
  g.__folded = [];
  assert.ok(!render({}).includes("<form"));
});
