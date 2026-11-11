import "./helpers/isolated-home.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {autopilotCommand} from '../src/commands/autopilot.mjs';
import {DecisionStore} from '../src/decisions.mjs';
import {autopilotGuard, guardedReason} from '../src/autopilot-guard.mjs';
import {AUTO_CHECKLIST, COMMON_LINES, PICKS_LINE} from '../src/autopilot.mjs';

// 가짜 시계·가짜 우편만 쓴다. 운영 홈·우편·디코·OS 알림에 닿지 않는다. 역할 이름도 시험용이다.
const T0 = Date.parse('2026-11-02T14:00:00.000Z');
const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-autopilot-auto-'));
  const file = path.join(home, 'hierarchy.json');
  fs.writeFileSync(file, JSON.stringify({'a-슈퍼감독': '@user', 'a-감독': 'a-슈퍼감독'}));
  appendLedger({kind: 'hierarchy-loaded', path: file, hash: 'x', by: 'watch'}, home);
  appendLedger({kind: 'start', role: 'a-슈퍼감독', session: 'kadan-a-슈퍼감독', roleProfile: 'super'}, home);
  const sent = [];
  const deps = {
    now: () => T0,
    readWorks: () => [{key: 'a/w1', status: 'open', owner: 'a-감독', executions: []}],
    sendMail: (role, message) => { sent.push({role, message}); return {ok: true, mailId: 'm1'}; },
    notify: () => {},
  };
  const run = (args, flags = {}, by = '사람') => autopilotCommand(args, flags, {home, by, deps});
  const autopilot = () => readLedger(home).filter(e => e.kind === 'autopilot');
  return {home, sent, run, autopilot};
}

test('--level autopilot: on 사건에 level, status, Autopilot 단계 문구, 점검 목록(onlyRunning 칸 없음)', () => {
  const f = fixture();
  const r = f.run(['on', '밤 위임'], {level: 'autopilot'});
  assert.equal(r.level, 'autopilot');
  assert.equal('onlyRunning' in r, false);
  assert.equal(r.checklist.length, 3);
  const [on] = f.autopilot();
  assert.equal(on.level, 'autopilot');
  assert.equal('onlyRunning' in on, false);
  const s = f.run(['status']);
  assert.equal(s.level, 'autopilot');
  assert.equal('onlyRunning' in s, false);
  const msg = f.sent[0].message;
  assert.match(msg, /단계: Autopilot/);
  assert.match(msg, /묻기 전에 저장소·결정 이력·TODO·docs·카드를 먼저 봅니다/);
  assert.match(msg, /답을 기다리는 동안 그 일만 멈추고 다른 일은 계속합니다/);
  assert.doesNotMatch(msg, /\[Autopilot 결정\]|추천안으로 진행/);
  assert.match(msg, /영구 삭제/);
  assert.match(msg, /코드가 막지 못하므로/);
  // 13. 머지는 관문 뒤에만: 옛 "아침으로 보류" 문구가 사라지고 관문·머지 명령이 들어 있다.
  assert.doesNotMatch(msg, /아침으로 보류합니다/);
  assert.match(msg, /kadan merge-gate/);
  assert.match(msg, /--match-head-commit/);
  assert.match(msg, /관문이 거절한 머지, `--allow` 없이 정책이 보류한 저장소의 머지/);
  assert.doesNotMatch(msg, /머지가 곧 운영 배포인 저장소의 머지/);
  for (const line of AUTO_CHECKLIST) assert.doesNotMatch(line, /머지를 아침으로 보류합니다/);
  assert.match(AUTO_CHECKLIST.join('\n'), /merge-gate[\s\S]*관문이 내준 머지 명령 그대로/);
  assert.match(msg, /관문이 내준 머지 명령\(`gh pr merge … --match-head-commit … -R …`\)을 그대로 치고/);
  assert.doesNotMatch(msg, /새 일감을 시작하지 않습니다/);
  assert.match(msg, /위 \(1\)~\(6\) 줄/);
  assert.match(msg, /\(6\) 새 일감은 `kadan autopilot picks --todo/);
  assert.match(msg, /재시작 필요/);
  assert.doesNotMatch(msg, /아침|취침|기상|밤중/);
});

test('--level full은 이제 켜진다(자세한 시험은 autopilot-full.test.mjs)', () => {
  const f = fixture();
  const r = f.run(['on', '밤'], {level: 'full'});
  assert.equal(r.level, 'full');
  assert.equal(f.autopilot()[0].level, 'full');
});

test('--level 없이 켜면 cruise로 기록하고 문구는 켜진 모든 단계의 고정 줄 5개뿐(--level cruise와 같다, 일감 고르기 줄 없음)', () => {
  for (const flags of [{}, {level: 'cruise'}]) {
    const f = fixture();
    const r = f.run(['on', '위임'], flags);
    assert.equal(r.level, 'cruise');
    assert.equal(r.checklist.length, 3);
    const [on] = f.autopilot();
    assert.equal(on.level, 'cruise');
    assert.equal('until' in on, false);
    assert.equal('onlyRunning' in on, false);
    const msg = f.sent[0].message;
    assert.match(msg, /단계: Cruise/);
    assert.match(msg, /\(1\) 결정 요청은 평소와 같은 기준으로 올립니다/);
    assert.match(msg, /\(2\) 어떤 근거로도 하지 않는 것/);
    assert.match(msg, /kadan merge-gate/);
    assert.match(msg, /\(5\) kyle의 직접 중지/);
    assert.match(msg, /위 \(1\)~\(5\) 줄/);
    assert.doesNotMatch(msg, /\(6\)|kadan autopilot picks|새 일감은/);
    assert.doesNotMatch(msg, /decision request를 새로 올리지|결정 요청을 올리지 말고|추천안으로 진행/);
    assert.equal(f.run(['status']).level, 'cruise');
  }
  assert.equal(COMMON_LINES.length, 5);
  assert.match(PICKS_LINE, /미배정 ready 카드/);
});

test('--only-running은 없앴다: 모르는 옵션으로 종료 코드 2 거절, 켜지지 않고 우편 0통', () => {
  for (const flags of [{'only-running': true}, {level: 'autopilot', 'only-running': true}, {level: 'autopilot', 'only-running': '밤'}]) {
    const f = fixture();
    assert.throws(() => f.run(['on', '밤'], flags), error => error.exitCode === 2 && /모르는 옵션: --only-running/.test(error.message));
    assert.equal(f.autopilot().length, 0);
    assert.equal(f.sent.length, 0);
  }
});

test('CLI 입구: autopilot on --only-running은 종료 코드 2, 원장에 켜짐 없음', () => {
  const f = fixture();
  const env = {...process.env, KADAN_HOME: f.home, KADAN_WINDOW: 'none'};
  delete env.KADAN_ROLE;
  const r = spawnSync(process.execPath, [CLI, 'autopilot', 'on', '--level', 'autopilot', '--only-running', '밤'], {env, encoding: 'utf8', timeout: 20_000});
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /모르는 옵션: --only-running/);
  assert.equal(f.autopilot().length, 0);
});

test('--allow: 켜진 모든 단계(Cruise 포함)에서 받고 kyle 원문·올바른 키가 있어야 하며, on 사건과 status에 정규화한 허용이 남는다', () => {
  const f = fixture();
  const q = '이번엔 승인';
  assert.throws(() => f.run(['on', '밤'], {allow: 'acme/app'}), /--quote/); // cruise에서도 받되 kyle 원문이 필요하다
  assert.throws(() => f.run(['on', '밤'], {level: 'autopilot', allow: 'acme/app'}), /--quote/);
  assert.throws(() => f.run(['on', '밤'], {level: 'autopilot', allow: 'acme/app'}, '사람'), /--quote/);
  assert.throws(() => f.run(['on', '밤'], {level: 'autopilot', allow: true, quote: q}), /--allow에는 GitHub 소유자\/이름/);
  assert.throws(() => f.run(['on', '밤'], {level: 'autopilot', allow: ['acme/app', 'bad key'], quote: q}), /--allow에는 GitHub 소유자\/이름/);
  assert.throws(() => f.run(['on', '밤'], {level: 'autopilot', allow: 'noslash', quote: q}), /--allow에는 GitHub 소유자\/이름/);
  assert.equal(f.autopilot().length, 0);
  const r = f.run(['on', '밤 위임'], {level: 'autopilot', allow: ['Acme/App.git', 'acme/app', 'Foo/Bar'], quote: q});
  assert.deepEqual(r.allow, ['acme/app', 'foo/bar']);
  assert.deepEqual(f.autopilot()[0].allow, ['acme/app', 'foo/bar']);
  assert.deepEqual(f.run(['status']).allow, ['acme/app', 'foo/bar']);
  assert.match(f.sent[0].message, /머지 허용\(--allow\): acme\/app, foo\/bar/);
  // Cruise에서도 --allow가 저장되고 우편에 실린다
  const c = fixture();
  const rc = c.run(['on', '자리 비움'], {allow: 'Acme/App', quote: q});
  assert.equal(rc.level, 'cruise');
  assert.deepEqual(c.autopilot()[0].allow, ['acme/app']);
  assert.match(c.sent[0].message, /머지 허용\(--allow\): acme\/app/);
  assert.doesNotMatch(c.sent[0].message, /kadan autopilot picks/);
});

test('--allow 없이 켜면 status의 allow는 빈 목록이고 on 사건에 allow가 없다', () => {
  const f = fixture();
  f.run(['on', '밤'], {level: 'autopilot'});
  assert.equal('allow' in f.autopilot()[0], false);
  assert.deepEqual(f.run(['status']).allow, []);
});

test('알 수 없는 --level 값은 거절한다', () => {
  assert.throws(() => fixture().run(['on', '밤'], {level: '기본'}), /--level은 cruise\|autopilot\|full만/);
});

const GUARDED = [
  ['restart', ['x'], {force: true}],
  ['stop', ['watch'], {}],
  ['stop', ['대시보드'], {}],
  ['window', ['set', 'none'], {}],
  ['window', ['unset'], {}],
  ['runners', ['set', 'worker'], {}],
  ['runners', ['runner', 'codex'], {}],
  ['runners', ['model', 'codex'], {}],
  ['runners', ['preset', '다른설정'], {}],
  ['runners', ['block', 'm'], {}],
  ['runners', ['import', 'f.json'], {}],
  ['runners', ['fallback', 'worker'], {}],
  ['runners', ['favorite'], {}],
  ['runners', ['init'], {}],
  ['runners', ['compare', 'on'], {}],
  ['runners', ['export', 'p'], {out: 'x.json'}],
  ['runners', ['새쓰기명령'], {}],
  ['window', ['새쓰기명령'], {}],
  ['stop', ['비서'], {}],
  ['stop', ['디코'], {}],
  ['autopilot', ['on', '밤'], {level: 'full'}],
];

test('켜진 동안 역할 세션의 보호 명령은 거절, 사람·꺼짐·읽기 명령은 통과', () => {
  const f = fixture();
  f.run(['on', '밤'], {level: 'autopilot', for: '8h'});
  const entries = readLedger(f.home);
  const base = {home: f.home, now: T0 + 1000, entries};
  for (const [command, args, flags] of GUARDED) {
    assert.throws(() => autopilotGuard({...base, command, args, flags, env: {KADAN_ROLE: 'a-작업'}}),
      error => error.exitCode === 2 && /Autopilot이 켜져 있어/.test(error.message), `${command} ${args}`);
    autopilotGuard({...base, command, args, flags, env: {}}); // 사람(KADAN_ROLE 없음)
    autopilotGuard({...base, command, args, flags, env: {KADAN_ROLE: 'a-작업'}, now: T0 + 9 * 3600_000}); // 끝 시각 뒤 = 꺼짐
  }
  for (const [command, args, flags] of [['restart', ['x'], {}], ['stop', ['a-작업'], {}], ['window', ['show'], {}], ['runners', ['show'], {}], ['runners', ['report'], {}],
    ['runners', ['compare', 'show'], {}], ['runners', ['export', 'p'], {}], ['runners', [], {}], ['window', [], {}],
    ['stop', ['a-검수'], {}], ['restart', ['x', '--help'], {}]])
    assert.equal(guardedReason(command, args, flags), null, `${command} ${args}`);
});

test('Autopilot이 한 번도 안 켜졌으면 역할 세션도 통과한다', () => {
  const f = fixture();
  autopilotGuard({home: f.home, command: 'stop', args: ['watch'], flags: {}, env: {KADAN_ROLE: 'a-작업'}, now: T0, entries: readLedger(f.home), decisionEvents: []});
});

test('CLI 입구: 켜진 홈에서 역할 세션의 stop watch·window unset은 종료 코드 2', () => {
  const f = fixture();
  // 켜진 상태를 실제 시계 기준 끝 시각의 사건으로 직접 만든다(CLI 자식 프로세스는 가짜 시계를 쓰지 않는다).
  appendLedger({kind: 'autopilot', phase: 'on', by: '사람', text: 'cli', viaChat: false, until: new Date(Date.now() + 3600_000).toISOString(),
    to: [], delivered: [], t: new Date().toISOString()}, f.home);
  const env = {...process.env, KADAN_HOME: f.home, KADAN_ROLE: 'a-작업', KADAN_WINDOW: 'none'};
  for (const argv of [['stop', 'watch'], ['window', 'unset'], ['restart', 'a-작업', '--force']]) {
    const r = spawnSync(process.execPath, [CLI, ...argv], {env, encoding: 'utf8', timeout: 20_000});
    assert.equal(r.status, 2, `${argv.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /Autopilot이 켜져 있어/);
  }
});

function autopilotOnHome(f) {
  appendLedger({kind: 'autopilot', phase: 'on', by: '사람', text: 'cli', viaChat: false, until: new Date(Date.now() + 3600_000).toISOString(),
    to: [], delivered: [], t: new Date().toISOString()}, f.home);
}
const cli = (f, argv, role) => spawnSync(process.execPath, [CLI, ...argv], {
  env: {...process.env, KADAN_HOME: f.home, KADAN_WINDOW: 'none', ...(role ? {KADAN_ROLE: role} : {KADAN_ROLE: ''})},
  encoding: 'utf8', timeout: 20_000,
});

test('F1: 켜진 홈의 역할 세션은 --help를 붙여도 거절되고 설정·종료는 일어나지 않는다', () => {
  const f = fixture();
  autopilotOnHome(f);
  const before = readLedger(f.home).length;
  for (const argv of [['window', 'set', 'none', '--help'], ['window', 'unset', '--help'], ['stop', 'watch', '--help'],
    ['restart', 'a-작업', '--force', '--help'], ['runners', 'preset', '다른설정', '--help']]) {
    const r = cli(f, argv, 'a-작업');
    assert.equal(r.status, 2, `${argv.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Autopilot이 켜져 있어/);
  }
  assert.equal(fs.existsSync(path.join(f.home, 'window-setting.json')), false);
  assert.equal(fs.existsSync(path.join(f.home, 'runner-settings.json')), false);
  assert.equal(readLedger(f.home).length, before, 'stop·restart 기록이 늘지 않는다');
});

test('F1: 사람이거나 꺼진 홈에서 window·stop·restart --help는 사용법만 보이고 아무것도 하지 않는다', () => {
  for (const [argv, usage] of [[['window', 'set', 'none', '--help'], /사용법: kadan window/], [['stop', 'watch', '--help'], /사용법: kadan stop/],
    [['restart', 'a-작업', '--force', '--help'], /사용법: kadan restart/]]) {
    for (const autopilotOn of [false, true]) {
      const g = fixture();
      if (autopilotOn) autopilotOnHome(g);
      const before = readLedger(g.home).length;
      const r = cli(g, argv, autopilotOn ? '' : 'a-작업'); // 켜짐+사람 / 꺼짐+역할
      assert.equal(r.status, 0, `${argv.join(' ')} autopilot=${autopilotOn}: ${r.stderr}`);
      assert.match(r.stdout, usage);
      assert.equal(fs.existsSync(path.join(g.home, 'window-setting.json')), false);
      assert.equal(readLedger(g.home).length, before);
    }
  }
});

test('F2: 켜진 홈의 역할 세션은 runners preset·block을 거절하고 설정 파일을 만들지 않으며 show는 통과', () => {
  const f = fixture();
  autopilotOnHome(f);
  for (const argv of [['runners', 'preset', '다른설정', '--revision', '1', '--reason', 'x'], ['runners', 'block', 'm', '--revision', '1', '--reason', 'x']]) {
    const r = cli(f, argv, 'a-작업');
    assert.equal(r.status, 2, `${argv.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /Autopilot이 켜져 있어/);
  }
  assert.equal(fs.existsSync(path.join(f.home, 'runner-settings.json')), false);
  const show = cli(f, ['runners', 'show'], 'a-작업');
  assert.equal(show.status, 0, show.stderr);
});

test('역할 세션의 decision answer는 Autopilot과 무관하게 거절된다(기존 동작 확인)', () => {
  const f = fixture();
  f.run(['on', '밤'], {level: 'autopilot'});
  const store = new DecisionStore(f.home);
  assert.throws(() => store.answer('없는-결정', {revision: 1, text: '승인'}, 'a-감독'), /사용자 답변은 사람 명의로만 기록/);
});
