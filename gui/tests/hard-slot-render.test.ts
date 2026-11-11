import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module, { createRequire } from "node:module";

// 실행 모델 설정 화면의 요약표·편집 칸을 실제 React 소스로 서버 렌더한다(restart-role-render와 같은 방식).
// 핵심은 "어려운 일 작업자 값이 없는 설정(지금 모든 사용자)"이 예외 없이 그려지는 것이다.
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
const { RunnerSummary, summaryCells } = req("./src/pages/RunnerSummary.tsx");
const { PresetEditor } = req("./src/pages/PresetEditor.tsx");
const { AppContext } = req("./src/ui.tsx");

const fixture = JSON.parse(fs.readFileSync(path.resolve(root, "../tests/fixtures/difficulty-preset-save.json"), "utf8"));
// 서버 응답(runnersData)의 모양: 이름표 사전은 작업자 다음에 어려운 일 작업자가 온다.
const roles = { worker: "작업자", "worker-hard": "어려운 일 작업자", reviewer: "검수자", conductor: "일반감독", super: "슈퍼감독", watch: "감시 AI", senior: "시니어", explain: "설명 AI" };
const catalog = { codex: { spawn: "codex --model {model}", needsEffort: false, models: ["gpt-test", "gpt-test2", "gpt-hard", "claude-test"].map(model => ({ model, efforts: [] })) } };
const dataOf = (which: "empty" | "filled") => {
  const settings = { ...fixture.settings[which], favorites: [], blocked: [] };
  const commands: Record<string, string> = { worker: "codex --model gpt-test", reviewer: "codex --model claude-test", conductor: "미설정", super: "미설정", watch: "미설정", senior: "미설정", explain: "미설정" };
  if (which === "filled") commands["worker-hard"] = "codex --model gpt-hard";
  return { settings, catalog, commands, roles, history: [], window: undefined };
};
const render = (child: unknown) => renderToStaticMarkup(React.createElement(AppContext.Provider,
  { value: { token: "fake-token", readOnly: false, draft: () => {}, notice: () => {} } }, child));

test("요약표: 값이 없는 설정(기본)도 예외 없이 그려지고 어려운 일 줄은 작업자와 같음으로 보인다", () => {
  const data = dataOf("empty");
  const html = render(React.createElement(RunnerSummary, { data }));
  const order = [...html.matchAll(/<th>([^<]+)<\/th><td>/g)].map(m => m[1]);
  assert.deepEqual(order.slice(0, 3), ["작업자", "어려운 일 작업자", "검수자"], "작업자 줄 바로 다음");
  assert.match(html, /비어 있음 — 작업자와 같음/);
  assert.match(html, /없음 \(폴백 없음\)/);
  assert.match(html, /작업자와 같은 명령으로 띄웁니다/);
  assert.doesNotMatch(html, /undefined|NaN/);
  assert.deepEqual(summaryCells(data, "worker-hard").fallbacks, []);
  assert.equal(summaryCells(data, "worker").value, "codex / gpt-test", "기존 줄은 그대로");
  assert.equal(summaryCells(data, "conductor").value, "미설정", "다른 비어 있는 역할은 여전히 미설정");
});

test("요약표: 값이 있으면 다른 역할처럼 값·명령이 보이고 폴백 칸은 없음", () => {
  const html = render(React.createElement(RunnerSummary, { data: dataOf("filled") }));
  assert.match(html, /codex \/ gpt-hard/);
  assert.match(html, /<code>codex --model gpt-hard<\/code>/);
  assert.doesNotMatch(html, /작업자와 같음/);
});

// 표 줄의 편집 칸은 처음엔 모두 닫혀 있다. 서버 렌더 시험은 initialOpen으로 열린 상태를 그린다.
const editor = (data: ReturnType<typeof dataOf>, initialOpen: string[] = []) =>
  render(React.createElement(PresetEditor, { data, settings: data.settings, initialOpen }));

test("표 편집기: 처음엔 모든 편집 칸이 닫혀 있고 줄마다 바꾸기 버튼만 있다(저장 줄도 없다)", () => {
  const data = dataOf("empty");
  const html = editor(data);
  assert.equal([...html.matchAll(/>바꾸기<\/button>/g)].length, Object.keys(roles).length);
  assert.doesNotMatch(html, /기본 실행 모델|대체 후보 순서|비우기|\(저장 전\)|바꾼 것|runner-save-row|되돌리기/);
  assert.match(html, /비어 있음 — 작업자와 같음/, "표의 기존 줄 글자는 그대로");
  assert.match(html, /작업자와 같은 명령으로 띄웁니다/);
  assert.doesNotMatch(html, /undefined|NaN/);
});

test("편집 칸: 값이 없으면 비어 있음 안내와 꺼진 비우기 버튼, 폴백 칸은 없다", () => {
  const data = dataOf("empty");
  const html = editor(data, ["worker-hard", "reviewer"]);
  assert.match(html, /어려운 일 작업자 바꾸기/);
  assert.match(html, /비어 있음 — 작업자와 같은 값으로 띄웁니다/);
  assert.match(html, /<button type="button" disabled="">비우기<\/button>/);
  // 폴백 칸("대체 후보 순서" 제목)은 어려운 일 자리에 없고 다른 역할에는 있다.
  const hard = html.slice(html.indexOf("어려운 일 작업자 바꾸기"), html.indexOf("검수자 바꾸기"));
  assert.doesNotMatch(hard, /대체 후보 순서/);
  assert.match(hard, /기본 실행 모델/);
  assert.match(html.slice(html.indexOf("검수자 바꾸기")), /대체 후보 순서/);
});

test("편집 칸: 값이 있으면 지금 값과 켜진 비우기 버튼이 보인다", () => {
  const html = editor(dataOf("filled"), ["worker-hard"]);
  assert.match(html, /지금 값: codex \/ gpt-hard/);
  assert.match(html, /<button type="button">비우기<\/button>/);
});

test("편집 칸: 시니어는 기본 실행 모델 없이 등록 목록만 연다", () => {
  const html = editor(dataOf("empty"), ["senior"]);
  assert.match(html, /등록된 시니어/);
  assert.doesNotMatch(html, /기본 실행 모델/);
});

test("비교 모드 잠금: 경고가 보이고 바꾸기 버튼이 모두 꺼진다", () => {
  const data = dataOf("empty");
  const settings = { ...data.settings, compare: { enabled: true, presets: [data.settings.activePreset], enabledAt: null } };
  const html = render(React.createElement(PresetEditor, { data: { ...data, settings }, settings }));
  assert.match(html, /비교 모드 중 — 먼저 끄기/);
  assert.equal([...html.matchAll(/class="row-edit"[^>]*disabled=""/g)].length, Object.keys(roles).length);
});

test("읽기 전용 표(RunnerSummary)에는 바꾸기 버튼·저장 줄이 없다", () => {
  const html = render(React.createElement(RunnerSummary, { data: dataOf("filled") }));
  assert.doesNotMatch(html, /바꾸기|runner-save-row|\(저장 전\)/);
});

test("요약 글: 초안 설정을 주면 초안 값으로 말한다(표의 '바꿀 값' 계산에 쓴다)", () => {
  const data = dataOf("filled");
  const draft = { ...data.settings, presets: { ...data.settings.presets, [data.settings.activePreset]: { ...data.settings.presets[data.settings.activePreset], roles: { ...data.settings.presets[data.settings.activePreset].roles, worker: { runner: "codex", model: "gpt-test2", effort: "high" } } } } };
  assert.equal(summaryCells(data, "worker").value, "codex / gpt-test");
  assert.equal(summaryCells(data, "worker", draft).value, "codex / gpt-test2 / high");
});

test("요약 글: 모델을 안 고른 초안은 빈 글자가 아니라 안 골랐다고 말한다", () => {
  const data = dataOf("filled");
  const preset = data.settings.presets[data.settings.activePreset];
  const draft = { ...data.settings, presets: { ...data.settings.presets, [data.settings.activePreset]: { ...preset, roles: { ...preset.roles, worker: { runner: "claude", model: "" } } } } };
  assert.equal(summaryCells(data, "worker", draft).value, "claude / (모델 안 골랐음)");
});
