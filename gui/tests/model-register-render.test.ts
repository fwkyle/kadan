import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module, { createRequire } from "node:module";

// 실행 모델 화면의 바꾸기 창·요약표를 실제 React 소스로 서버 렌더한다(hard-slot-render와 같은 방식).
// 보는 것: 새 모델 등록 칸이 어느 실행기에서 보이는가, 바꾸기 창의 초기값이 지금 값인가, 명령 칸이 접혀 있는가.
const root = path.resolve(import.meta.dirname, "..");
const req = createRequire(path.join(root, "package.json"));
const ts = req("typescript"), React = req("react"), { renderToStaticMarkup } = req("react-dom/server");
const g = globalThis as Record<string, unknown>;
g.window ??= { localStorage: { getItem: () => null, setItem: () => {} } };
const M = Module as unknown as { _load: (...a: unknown[]) => unknown; _extensions: Record<string, (m: { _compile: (c: string, f: string) => void }, f: string) => void> };
const original = M._load;
M._load = function (request: string, parent: { filename?: string } | null, isMain: boolean) {
  if (parent?.filename?.startsWith(path.join(root, "src") + path.sep) && /^\.\.?\/resource$/.test(request))
    return { useResource: () => ({ data: null, error: null, refresh: () => {} }), save: () => { throw new Error("writes disabled"); } };
  if (parent?.filename?.startsWith(path.join(root, "src") + path.sep) && /^\.\.?\/navigation$/.test(request))
    return new Proxy({}, { get: (_, key) => (key === "__esModule" ? false : () => "/") });
  return original.call(this, request, parent, isMain);
};
for (const ext of [".ts", ".tsx"]) M._extensions[ext] = (module, filename) => {
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  module._compile(code, filename);
};
const { RunnerSummary } = req("./src/pages/RunnerSummary.tsx");
const { PresetEditor } = req("./src/pages/PresetEditor.tsx");
const { AppContext } = req("./src/ui.tsx");

const roles = { worker: "작업자", reviewer: "검수자", conductor: "일반감독" };
const catalog = {
  // codex는 모델 목록을 파일에서 읽는 실행기(catalog: true)라 직접 등록하지 않는다.
  codex: { spawn: "codex --model {model}", needsEffort: false, catalog: true, models: [{ model: "gpt-test", efforts: [] }] },
  agy: { spawn: "agy --model {model} --effort {effort}", needsEffort: true, models: [
    { model: "m-old", efforts: ["low", "medium", "high"] }, { model: "m-hi", efforts: ["medium", "high"] }] },
};
const settings = { revision: 4, activePreset: "A", favorites: [], blocked: [], presets: { A: { roles: {
  worker: { runner: "agy", model: "m-old", effort: "high" }, reviewer: { runner: "codex", model: "gpt-test" } } } } };
const commands = { worker: "agy --model m-old --effort high", reviewer: "codex --model gpt-test", conductor: "미설정" };
const data = { settings, catalog, commands, roles, history: [], window: undefined };
const render = (child: unknown, readOnly = false) => renderToStaticMarkup(React.createElement(AppContext.Provider,
  { value: { token: "fake", readOnly, draft: () => {}, notice: () => {} } }, child));

test("바꾸기 창: 목록 파일을 쓰지 않는 실행기(agy)에는 새 모델 등록 칸, codex에는 없다", () => {
  const agy = render(React.createElement(PresetEditor, { data, settings, initialOpen: ["worker"] }));
  assert.match(agy, /\+ 새 모델 등록 \(agy\)/);
  assert.match(agy, /등록은 누르는 즉시 저장/);
  assert.match(agy, /표 아래 <strong>저장<\/strong>을 눌러야 적용/);
  const codex = render(React.createElement(PresetEditor, { data, settings, initialOpen: ["reviewer"] }));
  assert.doesNotMatch(codex, /새 모델 등록/);
  assert.match(codex, /검수자 바꾸기/);
});

test("바꾸기 창을 열면 실행기·모델·강도 초기값이 그 자리의 지금 값이다", () => {
  const html = render(React.createElement(PresetEditor, { data, settings, initialOpen: ["worker"] }));
  assert.match(html, /<option selected="">agy<\/option>/);
  assert.match(html, /<option value="m-old" selected="">m-old<\/option>/);
  assert.match(html, /<option selected="">high<\/option>/, "강도는 low가 아니라 지금 값 high");
  assert.doesNotMatch(html, /이 모델은 강도를 골라야 합니다/);
});

test("지금 강도를 이어 쓸 수 없어 비어 있는 선택이면 강도를 고르라는 안내가 보인다", () => {
  const lo = { ...catalog, agy: { ...catalog.agy, models: [{ model: "m-lo", efforts: ["low"] }] } };
  const s = { ...settings, presets: { A: { roles: { ...settings.presets.A.roles, worker: { runner: "agy", model: "m-lo" } } } } };
  const html = render(React.createElement(PresetEditor, { data: { ...data, catalog: lo, settings: s }, settings: s, initialOpen: ["worker"] }));
  assert.match(html, /이 모델은 강도를 골라야 합니다/);
});

test("명령 칸은 표 칸이 아니라 줄마다 접혀 있고, 읽기 전용 요약표에서도 열어 볼 수 있다", () => {
  for (const html of [
    render(React.createElement(PresetEditor, { data, settings })),
    render(React.createElement(RunnerSummary, { data }), true),
  ]) {
    assert.doesNotMatch(html, /<th>발령 때 채워질 명령<\/th>/);
    assert.match(html, /<details class="row-command"><summary>발령 명령 보기<\/summary><code>agy --model m-old --effort high<\/code><\/details>/);
    assert.match(html, /<code>codex --model gpt-test<\/code>/, "정보는 지우지 않는다");
    assert.equal((html.match(/<th>/g) ?? []).length >= 3, true);
  }
});
