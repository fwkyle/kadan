import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module, {createRequire} from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const req = createRequire(path.join(root, "package.json"));
const ts = req("typescript"), React = req("react"), {renderToStaticMarkup} = req("react-dom/server");
const g = globalThis as Record<string, unknown>;
g.window = {localStorage: {getItem: () => "[]", setItem: () => {}}};
const plain = {id: "open", card: "repo/card", question: "원문 질문", status: "open", revision: 1,
  requestedBy: "render-슈퍼감독", options: ["추천대로", "보류"], recommendation: "추천대로",
  reason: "이유", at: "2026-11-16T00:00:00Z"};
const attached = {...plain, body: {bytes: 40, sha256: "a".repeat(64)}, replyTo: "render-원감독"};
let item: object = attached, expanded = false, loaded: string | undefined = "A1\r\n<script>원문 그대로</script>";
let bodyError: string | undefined;
let requested: string[] = [];
const M = Module as unknown as {
  _load: (...args: unknown[]) => unknown;
  _extensions: Record<string, (m: {_compile: (code: string, file: string) => void}, file: string) => void>;
};
const original = M._load;
M._load = function(name: string, parent: {filename?: string} | null, isMain: boolean) {
  if (parent?.filename === path.join(root, "src/pages/Decisions.tsx") && name === "react")
    return {...React, useState: (initial: unknown) => React.useState(initial === false ? expanded : initial)};
  if (parent?.filename?.startsWith(path.join(root, "src") + path.sep)
      && /^\.\.?\/(resource|navigation)$/.test(name)) {
    if (name.endsWith("/navigation")) return {navigate: () => {}, cardUrl: (key: string) => "/#card=" + key};
    return {useResource: (route: string) => {
      requested.push(route);
      if (route.includes("?id=")) return {data: loaded === undefined && !bodyError ? undefined
        : {item: {...attached, bodyText: loaded, bodyError}}};
      return {data: {items: [item], answered: 0, past: 1}, refresh: () => {}};
    }, save: () => {throw new Error("writes disabled");}};
  }
  return original.call(this, name, parent, isMain);
};
for (const ext of [".ts", ".tsx"]) M._extensions[ext] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  }}).outputText, filename);
};
const {default: Decisions, DecisionBody} = req("./src/pages/Decisions.tsx");
const {AppContext} = req("./src/ui.tsx");
const render = (node: unknown) => renderToStaticMarkup(React.createElement(AppContext.Provider,
  {value: {token: "fake", readOnly: false, draft: () => {}, notice: () => {}}}, node));
const page = () => render(React.createElement(Decisions, {url: new URL("http://127.0.0.1/#decisions")}));

test("원문 표시가 없으면 기존 화면, 접힌 원문은 단건을 읽지 않는다", () => {
  expanded = false; requested = []; item = plain;
  assert.doesNotMatch(page(), /질문 원문 보기|메모는 render-원감독/);
  assert.deepEqual(requested, ["decisions"]);
  requested = []; item = attached;
  const html = page();
  assert.match(html, /질문 원문 보기/);
  assert.match(html, /메모는 render-원감독에게 그대로 전달됩니다/);
  assert.deepEqual(requested, ["decisions"]);
});

test("펼치면 단건 원문을 글자로 렌더하고 조회 중·오류에도 기존 답 양식은 남는다", () => {
  expanded = true; item = attached; bodyError = undefined;
  loaded = "A1\r\n<script>원문 그대로</script>";
  const body = render(React.createElement(DecisionBody, {decision: attached}));
  assert.match(body, /<pre>A1\r\n&lt;script&gt;원문 그대로&lt;\/script&gt;<\/pre>/);
  for (const phase of ["loading", "error"]) {
    loaded = undefined; bodyError = phase === "error" ? "원문 지문이 다릅니다" : undefined;
    const html = page();
    assert.match(html, /<form\b/);
    assert.match(html, phase === "error" ? /원문 지문이 다릅니다/ : /원문을 불러오는 중/);
  }
  expanded = false; loaded = "원문"; bodyError = undefined;
});

test("지난 결정에서도 원문을 열 수 있다", () => {
  expanded = true; item = {...attached, status: "answered", answer: {text: "답", at: plain.at}};
  const html = page();
  assert.match(html, /질문 원문 보기/);
  assert.match(html, /<pre>원문<\/pre>/);
  expanded = false; item = plain;
});
