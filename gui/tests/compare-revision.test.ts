import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module, {createRequire} from 'node:module';

// 실제 컴포넌트를 렌더하고 effect를 실행한다. DOM 없이 버전 전환과 요청 횟수를 확인한다.
const root = path.resolve(import.meta.dirname, '..');
const req = createRequire(path.join(root, 'package.json'));
const ts = req('typescript'), React = req('react');
const {renderToStaticMarkup} = req('react-dom/server');
const M = Module as unknown as {
  _load: (...args: unknown[]) => unknown;
  _extensions: Record<string, (m: {_compile: (code: string, file: string) => void}, file: string) => void>;
};
const original = M._load;
const context = React.createContext({readOnly: false, token: 'fake', draft: () => {}, notice: () => {}});
const refs: {current: unknown}[] = [];
const dependencies: unknown[][] = [];
let refIndex = 0, effectIndex = 0, effects: (() => void)[] = [];
let counts = {revision: 1, picks: {A: 2}};
const refreshCalls: boolean[] = [];
let reportCalls = 0;
const refresh = (force: boolean) => { refreshCalls.push(force); return Promise.resolve(); };
M._load = function(request: string, parent: {filename?: string} | null, isMain: boolean) {
  if (parent?.filename === path.join(root, 'src/pages/CompareMode.tsx')) {
    if (request === 'react') return {...React,
      useRef: (value: unknown) => refs[refIndex++] ?? (refs[refIndex - 1] = {current: value}),
      useEffect: (effect: () => void, deps: unknown[]) => {
        const index = effectIndex++, before = dependencies[index];
        if (!before || deps.some((value, i) => !Object.is(value, before[i]))) effects.push(effect);
        dependencies[index] = deps;
      },
    };
    if (request === '../resource') return {
      useResource: (url: string, options: {pollMs: number}) => {
        assert.equal(url, '/runners/compare'); assert.equal(options.pollMs, 0);
        return {data: counts, refresh, error: null, refreshing: false};
      },
      json: () => { reportCalls++; throw new Error('결과는 버튼에서만 조회'); },
      save: () => { throw new Error('시험 중 쓰기 없음'); },
    };
    if (request === '../ui') return {AppContext: context, ErrorMessage: () => null};
    if (request === '../navigation') return {cardUrl: () => '/'};
    if (request.endsWith('.css')) return {};
  }
  return original.call(this, request, parent, isMain);
};
M._extensions['.tsx'] = (module, filename) => {
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  }}).outputText;
  module._compile(code, filename);
};
const {CompareMode} = req('./src/pages/CompareMode.tsx');
const render = (revision: number) => {
  refIndex = 0; effectIndex = 0; effects = [];
  const html = renderToStaticMarkup(React.createElement(CompareMode, {settings: {
    revision, activePreset: 'A', presets: {A: {roles: {}}},
    compare: {enabled: true, presets: ['A'], enabledAt: null},
  }}));
  effects.forEach(effect => effect());
  return html;
};

test('외부 settings revision 변경마다 뽑힌 수를 한 번 갱신하고 결과 표는 다시 읽지 않는다', () => {
  assert.match(render(1), /A 2/);
  assert.deepEqual(refreshCalls, [], '최초 조회는 useResource가 맡는다');
  assert.match(render(2), /확인 중/);
  assert.deepEqual(refreshCalls, [true], '옛 요청이 진행 중이어도 새 revision으로 갱신');
  render(2); render(2);
  assert.deepEqual(refreshCalls, [true], '같은 버전 재렌더는 추가 요청 없음');
  counts = {revision: 2, picks: {A: 5}};
  assert.match(render(2), /A 5/);
  assert.doesNotMatch(render(2), /확인 중/);
  render(3); render(3);
  assert.deepEqual(refreshCalls, [true, true]);
  assert.equal(reportCalls, 0);
});
