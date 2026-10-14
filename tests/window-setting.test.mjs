import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  adoptMachineWindow, describeWindowSetting, effectiveWindow, readWindowSetting,
  setWindowSetting, unsetWindowSetting, windowSettingPath,
} from '../src/window-setting.mjs';
import {unpinnedWindowWarning, resolveWindowChoice, inspectRottieStartPreflight} from '../src/cli-start-support.mjs';
import {runnersData} from '../src/dashboard/settings.mjs';

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-window-setting-'));
const BIN = '/apps/Rottie/Contents/MacOS/rottie';
const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
const run = (h, args, env = {}) => spawnSync(process.execPath, [cli, ...args],
  {encoding: 'utf8', env: {PATH: process.env.PATH, HOME: process.env.HOME, KADAN_HOME: h, ...env}});

test('rottie 고정은 절대경로 없이는 받지 않고, 잘못된 값도 거절한다', () => {
  const h = home();
  assert.throws(() => setWindowSetting(h, {window: 'rottie', env: {}}), /KADAN_ROTTIE_BIN_REQUIRED/);
  assert.throws(() => setWindowSetting(h, {window: 'rottie', rottieBin: 'rottie', env: {}}), /KADAN_ROTTIE_BIN_REQUIRED/);
  assert.throws(() => setWindowSetting(h, {window: 'orca', env: {}}), /rottie\|none/);
  assert.throws(() => setWindowSetting(h, {window: 'none', rottieBin: BIN, env: {}}), /rottie 고정에서만/);
  assert.equal(readWindowSetting(h), null, '거절된 값은 파일을 만들지 않는다');
});

test('set·show·unset: 환경변수의 로티 경로를 받아 저장하고 0600 파일 하나만 쓴다', () => {
  const h = home();
  const saved = setWindowSetting(h, {window: 'rottie', env: {KADAN_ROTTIE_BIN: BIN}});
  assert.equal(saved.rottieBin, BIN);
  assert.equal(fs.statSync(windowSettingPath(h)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(h), ['window-setting.json'], '임시 파일이 남지 않는다');
  assert.equal(describeWindowSetting(h).kind, 'rottie');
  setWindowSetting(h, {window: 'none'});
  assert.deepEqual([describeWindowSetting(h).kind, readWindowSetting(h).rottieBin], ['none', undefined]);
  assert.equal(unsetWindowSetting(h).window, 'none');
  assert.equal(describeWindowSetting(h).kind, 'unset');
  assert.equal(unsetWindowSetting(h), null);
});

test('읽는 순서: 환경변수 > 기계 설정 > 기본 none, 로티 경로도 같다', () => {
  const h = home();
  assert.deepEqual(effectiveWindow({}, h).window, {value: 'none', source: 'default'});
  setWindowSetting(h, {window: 'rottie', rottieBin: BIN});
  const fromSetting = effectiveWindow({}, h);
  assert.deepEqual([fromSetting.window, fromSetting.rottieBin],
    [{value: 'rottie', source: 'setting'}, {value: BIN, source: 'setting'}]);
  const fromEnv = effectiveWindow({KADAN_WINDOW: 'none', KADAN_ROTTIE_BIN: '/env/rottie'}, h);
  assert.deepEqual([fromEnv.window, fromEnv.rottieBin],
    [{value: 'none', source: 'env'}, {value: '/env/rottie', source: 'env'}]);
});

test('설정 rottie → 창을 여는 쪽이 읽는 환경이 로티로 채워지고, 설정 none → 백그라운드다', () => {
  const h = home();
  setWindowSetting(h, {window: 'rottie', rottieBin: BIN});
  const env = {};
  assert.equal(adoptMachineWindow(env, h).windowSource, 'setting');
  assert.deepEqual(resolveWindowChoice(env), {kind: 'rottie'});
  assert.equal(env.KADAN_ROTTIE_BIN, BIN);
  setWindowSetting(h, {window: 'none'});
  const none = {};
  adoptMachineWindow(none, h);
  assert.deepEqual(resolveWindowChoice(none), {kind: 'none'});
});

test('환경변수 KADAN_WINDOW=none이 설정 rottie를 이기고, KADAN_ROTTIE_BIN도 설정 경로를 이긴다', () => {
  const h = home();
  setWindowSetting(h, {window: 'rottie', rottieBin: BIN});
  const env = {KADAN_WINDOW: 'none', KADAN_ROTTIE_BIN: '/env/rottie'};
  assert.equal(adoptMachineWindow(env, h).windowSource, 'env');
  assert.deepEqual([env.KADAN_WINDOW, env.KADAN_ROTTIE_BIN], ['none', '/env/rottie']);
  const partial = {KADAN_ROTTIE_BIN: '/env/rottie'};
  adoptMachineWindow(partial, h);
  assert.deepEqual([partial.KADAN_WINDOW, partial.KADAN_ROTTIE_BIN], ['rottie', '/env/rottie'], '각각 따로 정한다');
});

test('설정 rottie여도 start 사전 점검은 설정이 채운 경로를 쓰고, 파일은 자동으로 고쳐 쓰지 않는다', () => {
  const h = home();
  setWindowSetting(h, {window: 'rottie', rottieBin: BIN});
  const before = fs.readFileSync(windowSettingPath(h), 'utf8');
  const env = {};
  adoptMachineWindow(env, h);
  const seen = [];
  const result = inspectRottieStartPreflight({env, floorName: 'tmux', existsFn: () => true,
    connectFn: ({bin}) => { seen.push(bin); return {ok: true}; }, listBinsFn: () => ['/other/rottie']});
  assert.deepEqual([result.ok, seen], [true, [BIN]]);
  assert.equal(fs.readFileSync(windowSettingPath(h), 'utf8'), before);
});

test('깨진 설정 파일은 알리고 진행한다(다른 명령까지 막지 않는다)', () => {
  const h = home();
  fs.writeFileSync(windowSettingPath(h), '{ 깨짐');
  const warns = [], env = {};
  const result = adoptMachineWindow(env, h, {warn: line => warns.push(line)});
  assert.equal(result.corrupt, true);
  assert.match(warns[0], /창 선택 설정 손상/);
  assert.equal(env.KADAN_WINDOW, undefined);
  assert.equal(describeWindowSetting(h).kind, 'broken');
});

test('고정값이 없고 로티가 켜져 있으면 경고 한 줄, 로티가 없거나 고정돼 있으면 경고 없음', () => {
  const bins = () => ['/Applications/Rottie Local.app/Contents/MacOS/rottie'];
  const line = unpinnedWindowWarning({env: {}, listBinsFn: bins});
  assert.match(line, /창 선택이 고정되지 않았다.*Rottie Local.*백그라운드로 진행.*kadan window set rottie/);
  assert.equal(line.includes('\n'), false);
  assert.equal(unpinnedWindowWarning({env: {}, listBinsFn: () => []}), null);
  assert.equal(unpinnedWindowWarning({env: {KADAN_WINDOW: 'none'}, listBinsFn: bins}), null);
});

test('window 명령 CLI: 경로 없는 rottie는 종료 코드 2, 고정 → show → unset 왕복', () => {
  const h = home();
  const refused = run(h, ['window', 'set', 'rottie']);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /KADAN_ROTTIE_BIN_REQUIRED/);
  assert.equal(run(h, ['window', 'set', 'orca']).status, 2);
  assert.equal(run(h, ['window', 'bogus']).status, 2);
  const set = run(h, ['window', 'set', 'rottie', '--rottie-bin', BIN]);
  assert.equal(set.status, 0, set.stderr);
  const shown = run(h, ['window', 'show']);
  assert.match(shown.stdout, new RegExp(`기계 설정.*: 로티 ${BIN}`));
  assert.match(shown.stdout, /실제로 쓰는 창: rottie \(기계 설정\)/);
  const overridden = run(h, ['window', 'show'], {KADAN_WINDOW: 'none'});
  assert.match(overridden.stdout, /실제로 쓰는 창: none \(환경변수\)/);
  assert.match(overridden.stdout, /환경변수 KADAN_WINDOW=none가 기계 설정보다 먼저/);
  assert.match(run(h, ['window', 'unset']).stdout, /이전 값: rottie/);
  assert.match(run(h, ['window', 'show']).stdout, /: 미설정/);
});

test('대시보드 API(runners)가 기계 설정 값을 돌려주고, 프로세스 환경변수에 끌려가지 않는다', () => {
  const h = home(), url = new URL('http://local/api/dashboard/runners'), stamp = {};
  const keep = process.env.KADAN_WINDOW;
  process.env.KADAN_WINDOW = 'none';
  try {
    assert.equal(runnersData({home: h, entries: []}, url, stamp).window.kind, 'unset');
    setWindowSetting(h, {window: 'rottie', rottieBin: BIN});
    const rottie = runnersData({home: h, entries: []}, url, stamp).window;
    assert.deepEqual([rottie.kind, rottie.label, rottie.rottieBin], ['rottie', '로티', BIN]);
    setWindowSetting(h, {window: 'none'});
    assert.equal(runnersData({home: h, entries: []}, url, stamp).window.label, '백그라운드');
  } finally { if (keep === undefined) delete process.env.KADAN_WINDOW; else process.env.KADAN_WINDOW = keep; }
});

// ---- 2라운드: 손상 설정은 창을 여는 행동에서 실패 닫힘 ----
const CORRUPT = {
  '깨진 JSON': '{ 깨짐',
  '잘못된 창 값': JSON.stringify({version: 1, window: 'orca'}),
  '상대 로티 경로': JSON.stringify({version: 1, window: 'rottie', rottieBin: 'rottie'}),
};
const isolated = () => {
  const h = home(), socket = `kw-${path.basename(h)}`.slice(0, 30);
  const env = {KADAN_SOCKET: socket, KADAN_FLOOR: 'tmux', KADAN_ROLE: ''};
  const sessions = () => spawnSync('tmux', ['-L', socket, 'ls'], {encoding: 'utf8'}).stdout ?? '';
  return {h, env, socket, sessions};
};
const corrupt = (h, text) => fs.writeFileSync(windowSettingPath(h), text);

test('손상 설정 3종 × 환경변수 없음: start·attach·adopt·up·restore는 세션을 만들지 않고 종료 코드 2', () => {
  for (const [name, text] of Object.entries(CORRUPT)) {
    const t = isolated();
    // attach가 '세션 없음'에서 먼저 끝나지 않게, 설정이 멀쩡할 때 명시 none으로 세션 하나를 미리 둔다.
    assert.equal(run(t.h, ['start', 'kadan-pre', '--cmd', 'sleep 60'], {...t.env, KADAN_WINDOW: 'none'}).status, 0);
    const before = t.sessions();
    corrupt(t.h, text);
    try {
      for (const args of [['start', 'kadan-x', '--cmd', 'sleep 60'], ['attach', 'kadan-pre'], ['adopt', 'kadan-x'],
        ['up'], ['restore']]) {
        const r = run(t.h, args, t.env);
        assert.equal(r.status, 2, `${name} ${args[0]}: ${r.stdout}${r.stderr}`);
        assert.match(r.stderr, /WINDOW_SETTING_CORRUPT.*window unset/s, `${name} ${args[0]}`);
      }
      assert.equal(t.sessions(), before, `${name}: 격리 tmux에 새 세션이 생기면 안 된다`);
    } finally {
      run(t.h, ['stop', 'kadan-pre'], {...t.env, KADAN_WINDOW: 'none'});
      spawnSync('tmux', ['-L', t.socket, 'kill-server']);
    }
  }
});

test('손상 설정 + 명시 환경변수: none·(rottie+BIN 환경변수)는 진행, rottie만이면 멈춘다', () => {
  const t = isolated();
  corrupt(t.h, CORRUPT['깨진 JSON']);
  try {
    const none = run(t.h, ['start', 'kadan-win-none', '--cmd', 'sleep 60'], {...t.env, KADAN_WINDOW: 'none'});
    assert.equal(none.status, 0, none.stderr);
    assert.match(t.sessions(), /kadan-win-none/);
    const rottieOnly = run(t.h, ['start', 'kadan-win-r', '--cmd', 'sleep 60'], {...t.env, KADAN_WINDOW: 'rottie'});
    assert.equal(rottieOnly.status, 2);
    assert.match(rottieOnly.stderr, /WINDOW_SETTING_CORRUPT/);
    assert.doesNotMatch(t.sessions(), /kadan-win-r/);
    const empty = run(t.h, ['start', 'kadan-win-e', '--cmd', 'sleep 60'], {...t.env, KADAN_WINDOW: ''});
    assert.equal(empty.status, 2, '빈 문자열은 미지정으로 본다');
    // rottie + BIN 환경변수는 설정을 안 쓰므로 막히지 않는다(여기서는 가짜 경로라 사전 점검에서 멈추지만 손상 때문은 아니다).
    const both = run(t.h, ['start', 'kadan-win-b', '--cmd', 'sleep 60'],
      {...t.env, KADAN_WINDOW: 'rottie', KADAN_ROTTIE_BIN: '/nope/rottie'});
    assert.doesNotMatch(both.stderr, /WINDOW_SETTING_CORRUPT/);
  } finally {
    run(t.h, ['stop', 'kadan-win-none'], t.env);
    spawnSync('tmux', ['-L', t.socket, 'kill-server']);
  }
});

test('손상 설정에서도 창과 무관한 명령은 경고만 하고 진행하고, 복구 명령이 실제로 동작한다', () => {
  const t = isolated();
  corrupt(t.h, CORRUPT['상대 로티 경로']);
  const status = run(t.h, ['status'], t.env);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stderr, /경고: 창 선택 설정 손상/);
  assert.match(run(t.h, ['window', 'show'], t.env).stdout, /설정 손상[\s\S]*window unset/);
  assert.match(run(t.h, ['window', 'unset'], t.env).stdout, /이전 값: \(손상된 설정\)/);
  assert.equal(fs.existsSync(windowSettingPath(t.h)), false);
  corrupt(t.h, CORRUPT['깨진 JSON']);
  assert.equal(run(t.h, ['window', 'set', 'none'], t.env).status, 0, '손상 설정을 set으로 덮어쓴다');
  assert.equal(readWindowSetting(t.h).window, 'none');
});

test('아직 없는 KADAN_HOME에서도 window set none이 저장된다', () => {
  const fresh = path.join(home(), 'not', 'yet');
  assert.equal(run(fresh, ['window', 'set', 'none']).status, 0);
  assert.equal(readWindowSetting(fresh).window, 'none');
});

test('자동 시작·대시보드 재기동(KADAN_WINDOW=none 명시)은 손상 설정이어도 막히지 않는다', () => {
  const t = isolated();
  corrupt(t.h, CORRUPT['깨진 JSON']);
  const r = run(t.h, ['start', 'kadan-win-auto', '--hidden', '--cmd', 'sleep 60'], {...t.env, KADAN_WINDOW: 'none'});
  try { assert.equal(r.status, 0, r.stderr); } finally {
    run(t.h, ['stop', 'kadan-win-auto'], {...t.env, KADAN_WINDOW: 'none'});
    spawnSync('tmux', ['-L', t.socket, 'kill-server']);
  }
});
