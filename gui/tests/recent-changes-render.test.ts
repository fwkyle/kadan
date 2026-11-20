import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module, { createRequire } from "node:module";

// 실행 모델 설정 화면의 '값의 출처' 줄과 '최근 변경' 되돌리기 표를 실제 React 소스로 서버 렌더한다(hard-slot-render와 같은 방식).
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
const { RecentChanges } = req("./src/pages/RecentChanges.tsx");
const { PresetEditor } = req("./src/pages/PresetEditor.tsx");
const { AppContext } = req("./src/ui.tsx");

const c = (model: string, effort: string) => ({ runner: "codex", model, effort });
const roles = { worker: "작업자", "worker-hard": "어려운 일 작업자", reviewer: "검수자", conductor: "일반감독", super: "슈퍼감독", watch: "감시 AI", senior: "시니어", explain: "설명 AI", secretary: "비서" };
const catalog = { codex: { spawn: "codex -m {model} -c effort={effort}", needsEffort: true, models: ["sol", "astra", "old"].map(model => ({ model, efforts: ["low", "high"] })) } };
const settings = { revision: 9, activePreset: "B", blocked: [], presets: { B: { roles: { worker: c("sol", "high"), reviewer: c("astra", "high") }, fallback: { reviewer: [c("old", "low")] } } } };
const history = [
  { t: "2026-11-20T06:00:00Z", by: "사람", kind: "runner-settings", action: "set", preset: "B", role: "worker", revision: 9, reason: "시험", before: c("old", "low"), after: c("sol", "high") },
  { t: "2026-11-20T05:00:00Z", by: "사람", kind: "runner-settings", action: "set", preset: "B", role: "reviewer", revision: 8, reason: "시험", before: c("sol", "low"), after: c("old", "high") },
  { t: "2026-11-20T04:00:00Z", by: "사람", kind: "runner-settings", action: "favorite", revision: 7, reason: "시험", before: [], after: [c("sol", "low")] },
];
const data = { settings, catalog, roles, commands: {}, history, window: undefined };
const render = (child: unknown) => renderToStaticMarkup(React.createElement(AppContext.Provider,
  { value: { token: "fake-token", readOnly: false, draft: () => {}, notice: () => {} } }, child));
// 표 줄(tr)마다 되돌리기 단추가 켜져 있는지와 이유 글을 뽑는다.
const rows = (html: string) => [...html.matchAll(/<tr><td data-label="시각">[\s\S]*?<\/tr>/g)].map(m => ({
  disabled: /<button[^>]*class="row-revert"[^>]*disabled/.test(m[0]) || /disabled=""[^>]*class="row-revert"/.test(m[0]),
  label: /class="row-revert"[^>]*>([^<]+)</.exec(m[0])?.[1], why: /class="why muted">([^<]+)</.exec(m[0])?.[1] ?? null,
}));

test("최근 변경: 지금 되돌릴 수 있는 줄만 켜지고, 그 뒤에 또 바뀐 줄·역할 값이 아닌 줄은 이유와 함께 꺼진다", () => {
  const html = render(React.createElement(RecentChanges, { data, saved: settings, draft: settings, locked: null }));
  const [first, second, third] = rows(html);
  assert.equal(first.disabled, false, "가장 최근 변경은 되돌릴 수 있다");
  assert.equal(second.disabled, true);
  assert.match(second.why ?? "", /검수자.*또 바뀌어/);
  assert.equal(third.disabled, true);
  assert.match(third.why ?? "", /역할 값·대체 후보가 아닌 변경/);
  assert.match(html, /프리셋 B · 작업자/);
  assert.match(html, /codex \/ old \/ low → codex \/ sol \/ high/);
});

test("보관 값으로 그리는 동안·원격 보기·저장 중 등 locked 문구가 있으면 모든 줄이 꺼지고 그 이유를 보인다", () => {
  const html = render(React.createElement(RecentChanges, { data, saved: null, draft: null, locked: "마지막으로 받은 설정입니다 — 최신 값을 읽은 뒤 되돌릴 수 있습니다" }));
  const all = rows(html);
  assert.equal(all.length, 3);
  assert.ok(all.every(row => row.disabled && /마지막으로 받은 설정/.test(row.why ?? "")));
});

test("값의 출처 줄: 살아 있는 세션이 있는 역할 줄에만 보이고, 세션 상태를 모르면 아무것도 그리지 않는다", () => {
  const live = [{ role: "a", profile: "worker", pidState: "match", launch: { source: "settings" } },
    { role: "b", profile: "worker", pidState: "match", launch: { source: "fallback", fallbackIndex: 1 } }];
  const html = render(React.createElement(RunnerSummary, { data, live }));
  const lines = [...html.matchAll(/class="origin"[^>]*>([^<]+)</g)].map(m => m[1]);
  assert.deepEqual(lines, ["떠 있는 2개 · 설정 1 · 대체 1번 1"], "작업자 줄에만");
  assert.doesNotMatch(render(React.createElement(RunnerSummary, { data, live: null })), /class="origin"/);
  assert.doesNotMatch(render(React.createElement(RunnerSummary, { data })), /class="origin"/);
});

// 비교 모드: 활성 프리셋이 비교 목록 안이든 밖이든 켜져 있으면 되돌리기는 모두 꺼진다. 일반 편집('바꾸기') 잠금은 기존 정책 그대로다(목록 밖은 허용).
const withCompare = (compare: unknown) => ({ ...data, settings: { ...settings, compare } });
const editor = (d: ReturnType<typeof withCompare>) => render(React.createElement(PresetEditor, { data: d, settings: d.settings }));
const editButtons = (html: string) => [...html.matchAll(/<button[^>]*class="row-edit"[^>]*>/g)].map(m => /disabled/.test(m[0]));

test("비교 모드가 켜져 있으면 활성 프리셋이 비교 목록 밖이어도 최근 변경 되돌리기가 모두 꺼지고 이유를 보인다", () => {
  const outside = editor(withCompare({ enabled: true, presets: ["C", "D"], enabledAt: "2026-11-20T00:00:00Z" }));
  const all = rows(outside);
  assert.equal(all.length, 3);
  assert.ok(all.every(row => row.disabled && row.why === "비교 모드 중 — 먼저 끄기"), JSON.stringify(all));
  assert.doesNotMatch(outside, /class="warning">비교 모드 중/, "목록 밖 프리셋은 일반 편집 잠금 경고를 띄우지 않는다");
  assert.ok(editButtons(outside).length > 0 && editButtons(outside).every(disabled => !disabled), "목록 밖 프리셋의 일반 편집(바꾸기)은 전처럼 된다");
});

test("비교 목록 안이면 되돌리기도 일반 편집도 꺼지고, 비교 모드를 끄면 되돌리기가 다시 켜진다", () => {
  const inside = editor(withCompare({ enabled: true, presets: ["B", "C"], enabledAt: "2026-11-20T00:00:00Z" }));
  assert.ok(rows(inside).every(row => row.disabled && row.why === "비교 모드 중 — 먼저 끄기"));
  assert.match(inside, /class="warning">비교 모드 중 — 먼저 끄기/);
  assert.ok(editButtons(inside).every(disabled => disabled), "목록 안 프리셋의 일반 편집은 기존대로 잠김");
  for (const compare of [{ enabled: false, presets: ["B", "C"], enabledAt: null }, undefined]) {
    const off = rows(editor(withCompare(compare)));
    assert.equal(off[0].disabled, false, "비교 모드가 꺼지면 되돌릴 수 있는 줄이 다시 켜진다");
  }
});

test("비교 모드 켜기·끄기 사건은 최근 변경에서 '비교 모드'로 보인다", () => {
  const events = [{ t: "2026-11-20T07:00:00Z", by: "사람", kind: "runner-settings", action: "compare", revision: 10, reason: "시험" }, ...history];
  const html = render(React.createElement(RecentChanges, { data: { ...data, history: events }, saved: settings, draft: settings, locked: null }));
  assert.match(html, /<td data-label="무엇을">비교 모드</);
  assert.doesNotMatch(html, /<td data-label="무엇을">compare/);
});
