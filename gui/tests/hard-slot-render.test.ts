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
  assert.doesNotMatch(html, /폴백 없음/);
  assert.match(html, /작업자와 같은 명령으로 띄웁니다/);
  assert.doesNotMatch(html, /undefined|NaN/);
  assert.deepEqual(summaryCells(data, "worker-hard").fallbacks, []);
  assert.equal(summaryCells(data, "worker").value, "codex / gpt-test", "기존 줄은 그대로");
  assert.equal(summaryCells(data, "conductor").value, "미설정", "다른 비어 있는 역할은 여전히 미설정");
});

test("요약표: 값이 있으면 다른 역할처럼 값·명령이 보이고 대체 후보가 없으면 없음", () => {
  const html = render(React.createElement(RunnerSummary, { data: dataOf("filled") }));
  assert.match(html, /codex \/ gpt-hard/);
  assert.match(html, /<code>codex --model gpt-hard<\/code>/);
  assert.doesNotMatch(html, /작업자와 같음|폴백 없음/);
  assert.deepEqual(summaryCells(dataOf("filled"), "worker-hard").fallbacks, []);
  assert.equal(summaryCells(dataOf("filled"), "worker-hard").note, "없음");
});

// 어려운 일 작업자 대체 후보가 저장돼 있는 설정.
const withHardFallback = () => {
  const data = dataOf("filled");
  const preset = data.settings.presets[data.settings.activePreset];
  const settings = { ...data.settings, presets: { ...data.settings.presets, [data.settings.activePreset]: { ...preset,
    fallback: { "worker-hard": [{ runner: "codex", model: "gpt-hard-2", effort: "high" }, { runner: "codex", model: "gpt-test2" }] } } } };
  return { ...data, settings };
};

test("요약표: 어려운 일 대체 후보 목록이 순서대로 실제 목록으로 보인다", () => {
  const data = withHardFallback();
  assert.deepEqual(summaryCells(data, "worker-hard").fallbacks, ["codex / gpt-hard-2 / high", "codex / gpt-test2"]);
  const html = render(React.createElement(RunnerSummary, { data }));
  assert.match(html, /<ol><li>codex \/ gpt-hard-2 \/ high<\/li><li>codex \/ gpt-test2<\/li><\/ol>/);
  assert.doesNotMatch(html, /폴백 없음|대체 후보는 없/);
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

test("편집 칸: 값이 없으면 비어 있음 안내와 꺼진 비우기 버튼, 대체 후보 칸은 열리지 않는다", () => {
  const data = dataOf("empty");
  const html = editor(data, ["worker-hard", "reviewer"]);
  assert.match(html, /어려운 일 작업자 바꾸기/);
  assert.match(html, /비어 있음 — 작업자와 같은 값으로 띄웁니다/);
  assert.match(html, /<button type="button" disabled="">비우기<\/button>/);
  // 폴백 칸("대체 후보 순서" 제목)은 어려운 일 자리에 없고 다른 역할에는 있다.
  const hard = html.slice(html.indexOf("어려운 일 작업자 바꾸기"), html.indexOf("검수자 바꾸기"));
  assert.doesNotMatch(hard, /대체 후보 순서|대체 후보 추가/);
  assert.match(hard, /값을 정하면 대체 후보 칸이 열립니다/);
  assert.doesNotMatch(hard, /대체 후보는 없습니다/);
  assert.match(hard, /기본 실행 모델/);
  assert.match(html.slice(html.indexOf("검수자 바꾸기")), /대체 후보 순서/);
});

test("편집 칸: 값이 있으면 지금 값·켜진 비우기 버튼·다른 역할과 같은 대체 후보 칸이 보인다", () => {
  const html = editor(dataOf("filled"), ["worker-hard"]);
  assert.match(html, /지금 값: codex \/ gpt-hard/);
  assert.match(html, /<button type="button">비우기<\/button>/);
  const hard = html.slice(html.indexOf("어려운 일 작업자 바꾸기"));
  assert.match(hard, /대체 후보 순서/);
  assert.match(hard, /대체 후보 추가/);
  assert.match(hard, /--difficulty hard --fallback 번호/);
  assert.doesNotMatch(hard, /대체 후보는 없습니다/);
});

test("편집 칸: 저장된 대체 후보는 위로·아래로·삭제와 함께 줄지어 보이고, 비우기 단추에 함께 지워짐이 적힌다", () => {
  const html = editor(withHardFallback(), ["worker-hard"]);
  const hard = html.slice(html.indexOf("어려운 일 작업자 바꾸기"));
  assert.match(hard, /<ol><li>codex \/ gpt-hard-2 \/ high /);
  assert.equal([...hard.matchAll(/value="remove:\d"/g)].length, 2);
  assert.match(hard, /비우기 \(대체 후보 2개도 지움\)/);
});

test("편집 칸: 시니어는 기본 실행 모델 없이 등록 목록만 연다", () => {
  const html = editor(dataOf("empty"), ["senior"]);
  assert.match(html, /등록된 시니어/);
  assert.doesNotMatch(html, /기본 실행 모델/);
});

test("편집 칸: 강도를 받지 않는 실행기는 꺼진 강도 칸 대신 '강도는 모델 이름에 포함' 안내를 보인다", () => {
  const html = editor(dataOf("filled"), ["worker"]);
  assert.match(html, /추론 강도 칸 없음 — 이 실행기는 강도를 따로 받지 않습니다\. 강도는 모델 이름에 포함됩니다/);
  assert.doesNotMatch(html, /해당 없음|강도 고르기/);
  // 강도를 받는 실행기는 지금처럼 강도 칸이 보인다.
  const data = dataOf("filled");
  const withEffort = { ...data, catalog: { codex: { ...data.catalog.codex, needsEffort: true, models: data.catalog.codex.models.map(m => ({ ...m, efforts: ["low", "high"] })) } } };
  const shown = editor(withEffort, ["worker"]);
  assert.match(shown, /강도 고르기/);
  assert.doesNotMatch(shown, /추론 강도 칸 없음/);
});

// 시니어 두 명과 검수자 대체 후보 두 개가 저장된 설정. 서버가 주는 팝업 재료(fallbackCommands·seniorCommands)도 함께 싣는다.
const withSeniors = () => {
  const data = dataOf("filled");
  const preset = data.settings.presets[data.settings.activePreset];
  const seniors = [{ runner: "codex", model: "gpt-test", effort: "high" }, { runner: "codex", model: "gpt-test2" }];
  const settings = { ...data.settings, presets: { ...data.settings.presets, [data.settings.activePreset]: { ...preset,
    roles: { ...preset.roles, senior: seniors },
    fallback: { reviewer: [{ runner: "codex", model: "gpt-test2" }, { runner: "codex", model: "gpt-hard" }] } } } };
  return { ...data, settings, commands: { ...data.commands, senior: "S1 + S2" },
    fallbackCommands: { reviewer: ["codex --model gpt-test2", "codex --model gpt-hard"] }, seniorCommands: ["S1", "S2"] };
};

test("시니어 '지금 값'은 옆으로 잇지 않고 대체 후보와 같은 번호 목록으로 아래로 보인다(편집 표·읽기 전용 표 모두)", () => {
  const data = withSeniors();
  assert.deepEqual(summaryCells(data, "senior").seniors, ["codex / gpt-test / high", "codex / gpt-test2"]);
  assert.equal(summaryCells(data, "worker").seniors, null);
  for (const html of [render(React.createElement(RunnerSummary, { data })), editor(data)]) {
    assert.match(html, /<td><ol><li>codex \/ gpt-test \/ high<\/li><li>codex \/ gpt-test2<\/li><\/ol><button type="button" class="row-command">/);
    assert.doesNotMatch(html, /codex \/ gpt-test \/ high \+ codex/, "옆으로 이은 글은 없다");
  }
});

test("편집 표: 바꾸기 버튼은 역할 칸이 아니라 오른쪽 끝 '편집' 칸에 있다(읽기 전용 요약표는 세 칸 그대로)", () => {
  const html = editor(dataOf("empty"), ["reviewer"]);
  assert.match(html, /<thead><tr><th>역할<\/th><th>지금 값<\/th><th>대체 후보 \(순서대로\)<\/th><th>편집<\/th><\/tr><\/thead>/);
  assert.match(html, /<tr><th>작업자<\/th><td>/, "역할 칸에는 이름만 있다");
  assert.doesNotMatch(html, /<th>[^<]*<(br|button|div)/, "역할 칸에 버튼·강제 줄바꿈이 없다");
  assert.equal([...html.matchAll(/<td class="edit-cell"><button type="button" class="row-edit" aria-expanded="(true|false)">(바꾸기|닫기)<\/button><\/td><\/tr>/g)].length,
    Object.keys(roles).length, "줄마다 마지막 칸에 버튼 하나");
  assert.match(html, /<tr class="runner-edit-row"><td colSpan="4">/, "펼친 편집 칸은 네 칸 전체 폭");
  const summary = render(React.createElement(RunnerSummary, { data: dataOf("empty") }));
  assert.match(summary, /<thead><tr><th>역할<\/th><th>지금 값<\/th><th>대체 후보 \(순서대로\)<\/th><\/tr><\/thead>/);
  assert.doesNotMatch(summary, /편집|row-edit/);
});

test("발령 명령 팝업: 지금 값 명령과 대체 후보 명령이 순서대로, 시니어는 한 명씩 줄로 보인다", () => {
  const html = render(React.createElement(RunnerSummary, { data: withSeniors() }));
  const reviewer = html.slice(html.indexOf('aria-label="검수자 발령 명령 보기"'), html.indexOf("<th>일반감독"));
  assert.match(reviewer, /<h4>지금 값<\/h4><code>codex --model claude-test<\/code><h4>대체 후보 \(순서대로\)<\/h4><ol><li><code>codex --model gpt-test2<\/code><\/li><li><code>codex --model gpt-hard<\/code><\/li><\/ol><form method="dialog"><button>닫기<\/button><\/form><\/dialog>/);
  const senior = html.slice(html.indexOf('aria-label="시니어 발령 명령 보기"'), html.indexOf("<th>설명 AI"));
  assert.match(senior, /<h4>지금 값<\/h4><ol><li><code>S1<\/code><\/li><li><code>S2<\/code><\/li><\/ol><form method="dialog">/);
  // 팝업 재료가 없는 옛 응답이어도 지금 값 명령은 보인다.
  const old = render(React.createElement(RunnerSummary, { data: dataOf("filled") }));
  assert.match(old, /<h4>지금 값<\/h4><code>codex --model gpt-hard<\/code><form method="dialog">/);
});

test("편집 칸: 대체 후보·시니어 줄마다 수정 버튼이 있고(제출 버튼이 아니다), 가득 찬 시니어는 추가만 막히고 안내가 보인다", () => {
  const html = editor(withSeniors(), ["reviewer", "senior"]);
  const reviewer = html.slice(html.indexOf("검수자 바꾸기"), html.indexOf("<th>일반감독</th>"));
  assert.equal([...reviewer.matchAll(/<button type="button">수정<\/button>/g)].length, 2, "대체 후보 두 줄");
  assert.match(reviewer, /<button class="primary" value="add">대체 후보 추가<\/button>/, "가득 찬 목록이 아니면 추가는 지금처럼 켜져 있다");
  assert.doesNotMatch(reviewer, /자리 바꾸기|고치는 중|최대 \d/);
  const senior = html.slice(html.indexOf("시니어 바꾸기"), html.indexOf("<th>설명 AI</th>"));
  assert.equal([...senior.matchAll(/<button type="button">수정<\/button>/g)].length, 2, "시니어 두 줄");
  assert.match(senior, /최대 2명까지입니다 — 줄의 &#x27;수정&#x27;으로 바꾸거나 삭제한 뒤 추가하세요\./);
  assert.match(senior, /<button class="primary" value="add" disabled="">시니어 추가<\/button>/);
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

// ---- 비서 자리(2026-11-19): 표 맨 아래 줄. 띄우는 명령이 아니라 다시 열 때 모델·강도만 바꾸는 값이다. ----
const withSecretary = (value?: { runner: string; model: string; effort?: string }) => {
  const data = dataOf("empty");
  const preset = data.settings.presets[data.settings.activePreset];
  const settings = { ...data.settings, presets: { ...data.settings.presets,
    [data.settings.activePreset]: { ...preset, roles: { ...preset.roles, ...(value ? { secretary: value } : {}) } } } };
  const commands = { ...data.commands, secretary: value
    ? `비서를 다시 열 때 저장된 명령의 모델·강도만 바꾼다: --model ${value.model}`
    : "비어 있음 — 저장된 명령 그대로 다시 연다" };
  return { ...data, settings, commands, roles: { ...roles, secretary: "비서" }, secretary: { runner: "codex" } };
};

test("비서 줄: 값이 없으면 비어 있음으로 보이고 대체 후보는 두지 않는다고 말한다", () => {
  const data = withSecretary();
  const cells = summaryCells(data, "secretary");
  assert.equal(cells.value, "비어 있음 — 저장된 명령 그대로 다시 엽니다");
  assert.deepEqual(cells.fallbacks, []);
  assert.equal(cells.note, "없음 (대체 후보를 두지 않습니다)");
  assert.equal(cells.commandTitle, "다시 열 때 동작 보기");
  const html = render(React.createElement(RunnerSummary, { data }));
  assert.equal([...html.matchAll(/<th>([^<]+)<\/th><td>/g)].map(m => m[1]).at(-1), "비서", "표의 맨 아래 줄");
  assert.match(html, /<button type="button" class="row-command">다시 열 때 동작 보기<\/button><dialog class="command-dialog" aria-label="비서 다시 열 때 동작 보기"><h3>비서 · 다시 열 때 동작<\/h3><h4>지금 값<\/h4><code>비어 있음 — 저장된 명령 그대로 다시 연다<\/code>/);
  assert.equal([...html.matchAll(/<button type="button" class="row-command">발령 명령 보기<\/button>/g)].length, Object.keys(roles).length, "다른 줄의 버튼 글은 그대로");
  assert.doesNotMatch(html, /undefined|NaN/);
});

test("비서 줄: 값이 있으면 값과 다시 열 때 동작이 보인다", () => {
  const data = withSecretary({ runner: "codex", model: "gpt-test2" });
  assert.equal(summaryCells(data, "secretary").value, "codex / gpt-test2");
  assert.match(render(React.createElement(RunnerSummary, { data })), /<code>비서를 다시 열 때 저장된 명령의 모델·강도만 바꾼다: --model gpt-test2<\/code>/);
});

test("비서 편집 칸: 기본 실행 모델과 비우기만 있고 대체 후보 칸은 없다", () => {
  const empty = editor(withSecretary() as never, ["secretary"]);
  const slot = empty.slice(empty.indexOf("비서 바꾸기"));
  assert.match(slot, /기본 실행 모델/);
  assert.match(slot, /비어 있음 — 비서는 저장된 명령 그대로 다시 열립니다/);
  assert.match(slot, /<button type="button" disabled="">비우기<\/button>/);
  assert.doesNotMatch(slot, /대체 후보 순서|대체 후보 추가/);
  assert.match(slot, /대체 후보는 두지 않습니다/);
  const filled = editor(withSecretary({ runner: "codex", model: "gpt-test2" }) as never, ["secretary"]);
  const filledSlot = filled.slice(filled.indexOf("비서 바꾸기"));
  assert.match(filledSlot, /지금 값: codex \/ gpt-test2/);
  assert.match(filledSlot, /<button type="button">비우기<\/button>/);
  assert.doesNotMatch(filledSlot, /대체 후보 순서|대체 후보 추가/);
});
