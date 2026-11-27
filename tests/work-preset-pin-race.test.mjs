// 기본 프리셋 고정 2라운드(검수 발견 수정): 인계 반영 미리 보기, 이름 변경·삭제와 업무 쓰기의 경합, 다시 열기 경고,
// 저장소 없는 홈, 비교 모드 중 전환 안내. 격리 홈만 쓰고 tmux는 쓰지 않는다.
// 경합 시험은 시간 맞추기(sleep)에 기대지 않는다: 설정 파일을 바꾸는 바로 그 순간(확인 뒤·쓰기 직전)에 다른 DB 연결과
// 다른 프로세스를 끼워 넣어 순서를 고정한다. 같은 프로세스에서 업무를 만들면 같은 DB 연결을 다시 쓰므로(트랜잭션 재진입)
// 실제 경합이 아니다 — 그래서 다른 연결·다른 프로세스로 본다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {WorkStore} from '../src/work-store.mjs';
import {CardStore} from '../src/card-store.mjs';
import {workCommand} from '../src/work-command.mjs';
import {runnersCommand} from '../src/runners-command.mjs';
import {launchFor, readSettings, removePreset, renamePreset} from '../src/runner-settings.mjs';
import {setCompare} from '../src/runner-compare.mjs';
import {relaunchLines} from '../src/relaunch-preview.mjs';
import {storagePath} from '../src/storage.mjs';
import {readWorkHeads, isOpenWork} from '../src/work-heads.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {SETTINGS_FILE, makeCard, makeHome, sendCard, startOf, workFields} from './helpers/preset-pin-rig.mjs';

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
const meta = home => ({revision: readSettings(home).revision, by: 'test', reason: '시험', record: () => {}});
const pairs = list => list.map(item => `${item.role}@${item.work ?? '-'}`).sort();
const create = (home, repo, key, fields = {}) => workCommand(['create', key], {...workFields(repo), ...fields}, {home, by: 'boss'});
// 열린 업무가 적어 둔 프리셋 가운데 지금 설정에 없는 이름.
const danglingPresets = home => readWorkHeads(home).filter(work => isOpenWork(work) && work.preset
  && !Object.hasOwn(readSettings(home).presets, work.preset)).map(work => `${work.key}→${work.preset}`);

function startWorker(home, pids, role, preset = 'B') {
  const launch = launchFor(readSettings(home), 'worker', preset), pid = String(200 + Object.keys(pids).length);
  pids[`kadan-${role}`] = pid;
  appendLedger({kind: 'start', role, session: `kadan-${role}`, floor: 'fake', panePid: pid, cmd: launch.cmd, model: launch.model,
    roleProfile: 'worker', launchSource: 'settings', settingsPreset: launch.preset}, home);
  return startOf(home, role);
}
const fakeFloor = pids => ({name: 'fake', alive: session => Object.hasOwn(pids, session), pid: session => pids[session]});

test('인계 반영: 업무를 넘겨받은 후임은 다시 띄울 목록에 나오고, 넘겨준 선임은 그 카드 때문에 나오지 않는다', () => {
  const {home, repo} = makeHome();
  const work = create(home, repo, 'pin/w-handover');
  const pids = {};
  const before = startWorker(home, pids, 'ho-old'), after = startWorker(home, pids, 'ho-new');
  // 카드 두 장: 하나는 정식 주소로, 하나는 짧은 ID로 인계한다(발령과 같은 주소 풀이를 쓰는지 본다).
  const full = makeCard(home, repo, 'ho-card-1', 'ho-old', 'implementation', work.key);
  const short = makeCard(home, repo, 'ho-card-2', 'ho-old', 'fix', work.key);
  appendLedger({kind: 'handover', phase: 'transferred', handoverId: 'ho-1', from: 'ho-old', to: 'ho-new', taskIds: [full.key, short.id]}, home);
  const cards = new CardStore(home);
  assert.equal(cards.get(full.key).role, 'ho-old'); // 카드에 적힌 담당은 그대로 선임이다
  for (const card of [full, short]) {
    assert.equal(cards.checkSend(card.key, 'ho-new', cards.listSummaries(), readLedger(home)).role, 'ho-new');
    assert.throws(() => cards.checkSend(card.key, 'ho-old', cards.listSummaries(), readLedger(home)), /중앙 카드 발령 불가/);
  }
  assert.equal(sendCard(home, full, after, work.key).entry.runnerGuard, undefined);

  // 업무 프리셋 B → C: 후임만 이 업무의 다시 띄울 목록에 나온다(업무 지정 없이 뜬 세션이어도).
  const moved = workCommand(['update', work.key], {revision: String(new WorkStore(home).get(work.key).revision), preset: 'C', note: '변경'},
    {home, by: 'boss', floor: fakeFloor(pids)});
  assert.deepEqual(pairs(moved.relaunchPreview.relaunch), ['ho-new@pin/w-handover']);
  assert.equal(moved.relaunchPreview.checked, 1);
  // 실제 발령도 같은 판정이다.
  assert.throws(() => sendCard(home, short, after, work.key), error => error.code === 'KADAN_STALE_RUNNER' && /프리셋 C worker 기본값/.test(error.message));

  // 설정 쪽 변경의 미리 보기도 같다: 선임은 이 업무가 아니라 "열린 업무 없음"으로만 본다.
  const edited = runnersCommand(['set', 'worker'], {runner: 'codex', model: 'gpt-6-astra', effort: 'high', preset: 'B',
    revision: String(readSettings(home).revision), reason: '모델 변경'}, {home, by: 'test', record: () => {}, floor: fakeFloor(pids)});
  const all = [...edited.relaunchPreview.relaunch, ...edited.relaunchPreview.fallbackOk];
  assert.equal(all.some(item => item.role === 'ho-old' && item.work === work.key), false);
  assert.ok(pairs(edited.relaunchPreview.relaunch).includes('ho-new@pin/w-handover'));
  assert.equal(before.role, 'ho-old');
});

test('이름 변경의 확인과 쓰기 사이에는 다른 연결·다른 프로세스가 업무를 쓰지 못하고, 끝난 뒤에는 새 이름을 본다', async t => {
  const {home, repo} = makeHome();
  const other = create(home, repo, 'pin/w-on-c', {preset: 'C'}); // 저장소를 만들고, 경합 중 update 대상으로 쓴다
  const settingsFile = path.join(home, SETTINGS_FILE), realRename = fs.renameSync;
  const env = {...process.env, KADAN_HOME: home, KADAN_BUSY_TIMEOUT_MS: '200'};
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], {env, cwd: repo, encoding: 'utf8', timeout: 15000});
  const createArgs = key => ['work', 'create', key, '--title', '업무', '--goal', '목표', '--scope', '범위', '--acceptance', '조건',
    '--owner', 'boss', '--board', '판', '--repo-path', repo];
  const seen = {};
  t.mock.method(fs, 'renameSync', (...args) => {
    if (args[1] === settingsFile && !seen.done) {
      seen.done = true;
      // (1) 다른 DB 연결: 기다리지 않게 하면 쓰기 트랜잭션을 시작하지 못한다(업무 저장소 쓰기 잠금을 이름 변경이 쥐고 있다).
      const db = new DatabaseSync(storagePath(home));
      try { db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); seen.began = true; db.exec('ROLLBACK'); }
      catch (error) { seen.lock = error.message; }
      finally { db.close(); }
      // (2) 다른 프로세스의 업무 생성·업무 프리셋 수정: 잠금을 기다리다(여기서는 0.2초 한도) 쓰지 못하고 끝난다.
      seen.create = cli(...createArgs('pin/w-during'));
      seen.update = cli('work', 'update', other.key, '--revision', String(other.revision), '--preset', 'B', '--note', '경합');
      // (3) 기다리는 한도가 넉넉한(기본값) 다른 프로세스의 업무 생성: 이름 변경이 끝난 뒤에야 쓰기를 시작한다.
      const {KADAN_BUSY_TIMEOUT_MS, ...patient} = env;
      seen.waiting = spawn(process.execPath, [CLI, ...createArgs('pin/w-waited')], {env: patient, cwd: repo, stdio: ['ignore', 'pipe', 'pipe']});
    }
    return realRename(...args);
  });
  const saved = renamePreset(home, {from: 'B', to: 'B2', ...meta(home)});
  t.mock.restoreAll();
  assert.equal(saved.activePreset, 'B2');
  assert.equal(seen.began, undefined);
  assert.match(seen.lock, /locked|busy/i);
  assert.notEqual(seen.create.status, 0);
  assert.match(seen.create.stderr, /locked|busy/i);
  assert.notEqual(seen.update.status, 0);
  assert.match(seen.update.stderr, /locked|busy/i);
  const store = new WorkStore(home);
  assert.throws(() => store.get('pin/w-during'), /기록 없음/);
  assert.equal(store.get(other.key).preset, 'C');

  // 기다린 생성은 이름 변경 뒤의 설정을 읽어 새 이름(B2)에 고정된다.
  let out = '';
  seen.waiting.stdout.on('data', chunk => { out += chunk; });
  const code = await new Promise(resolve => seen.waiting.on('close', resolve));
  assert.equal(code, 0);
  assert.deepEqual([JSON.parse(out).preset, JSON.parse(out).presetAuto], ['B2', true]);

  // 끝난 뒤: 새 업무는 B2에 고정되고, 사라진 이름으로의 업무 프리셋 수정은 "없는 프리셋"으로 거절된다.
  const after = cli(...createArgs('pin/w-after'));
  assert.equal(after.status, 0, after.stderr);
  assert.equal(JSON.parse(after.stdout).preset, 'B2');
  const refused = cli('work', 'update', other.key, '--revision', String(other.revision), '--preset', 'B', '--note', '뒤늦게');
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /없는 프리셋: B/);
  // 어느 쪽이든 열린 업무가 없는 이름을 가리키지 않는다.
  assert.deepEqual(danglingPresets(home), []);
});

test('업무 쪽이 먼저 끝났으면 이름 변경·삭제가 거절된다(생성·프리셋 수정 모두)', () => {
  const {home, repo} = makeHome();
  create(home, repo, 'pin/w-first'); // B에 자동 고정
  assert.throws(() => renamePreset(home, {from: 'B', to: 'B2', ...meta(home)}), /프리셋 B은\(는\) 열린 업무 1건이 쓰고 있어.*pin\/w-first/);
  const manual = create(home, repo, 'pin/w-manual', {preset: 'B'});
  workCommand(['update', manual.key], {revision: String(manual.revision), preset: 'C', note: 'C로'}, {home, by: 'boss'});
  assert.throws(() => removePreset(home, {name: 'C', ...meta(home)}), /프리셋 C은\(는\) 열린 업무 1건이 쓰고 있어.*pin\/w-manual/);
  assert.equal(readSettings(home).revision, 1);
  assert.deepEqual(danglingPresets(home), []);
});

test('다시 열기: 그사이 지워진 프리셋을 가리키는 닫힌 업무는 그대로 열리고 경고 칸과 stderr 안내가 나온다', () => {
  const {home, repo} = makeHome();
  const ctx = {home, by: '사람'};
  const work = create(home, repo, 'pin/w-reopen', {preset: 'C'});
  const closed = workCommand(['cancel', work.key], {revision: String(work.revision), result: '취소', note: '닫기'}, ctx);
  removePreset(home, {name: 'C', ...meta(home)}); // 닫힌 업무만 쓰는 프리셋은 지울 수 있다
  const reopened = spawnSync(process.execPath, [CLI, 'work', 'reopen', work.key, '--revision', String(closed.revision), '--note', '다시 열기'],
    {env: {...process.env, KADAN_HOME: home}, cwd: repo, encoding: 'utf8', timeout: 15000});
  assert.equal(reopened.status, 0, reopened.stderr);
  const result = JSON.parse(reopened.stdout);
  assert.deepEqual([result.status, result.preset], ['open', 'C']);
  const guide = /프리셋 C이\(가\) 없다 — 이 업무의 발령은 프리셋 C 기준이라 거절된다\. kadan work update pin\/w-reopen --revision 3 --preset <이름\|""> --note <이유>로 바꾼다/;
  assert.match(result.presetWarning, guide);
  assert.match(reopened.stderr, /경고: 프리셋 C이\(가\) 없다/);
  // 안내대로 풀린다.
  const fixed = workCommand(['update', work.key], {revision: '3', preset: 'B', note: '프리셋 교체'}, ctx);
  assert.equal(fixed.preset, 'B');
  assert.deepEqual(danglingPresets(home), []);

  // 프리셋이 그대로 있거나 프리셋이 없는 업무를 다시 열면 경고가 없다.
  const again = workCommand(['cancel', work.key], {revision: String(fixed.revision), result: '취소', note: '닫기'}, ctx);
  assert.equal('presetWarning' in workCommand(['reopen', work.key], {revision: String(again.revision), note: '다시'}, ctx), false);
});

test('저장소가 없는 홈에서는 이름 변경·삭제가 지금과 같이 되고 저장소를 만들지 않는다', () => {
  const {home} = makeHome();
  assert.equal(fs.existsSync(storagePath(home)), false);
  assert.equal(renamePreset(home, {from: 'B', to: 'B2', ...meta(home)}).activePreset, 'B2');
  assert.equal(Object.hasOwn(removePreset(home, {name: 'C', ...meta(home)}).presets, 'C'), false);
  assert.deepEqual(Object.keys(readSettings(home).presets), ['B2']);
  assert.equal(fs.existsSync(storagePath(home)), false);
});

test('비교 모드가 켜진 채 기본 프리셋을 바꾸면 "고정되지 않는다"고 안내한다(실제 생성 동작과 같다)', () => {
  const {home, repo} = makeHome();
  setCompare(home, {enabled: true, presets: 'B,C', ...meta(home)});
  const switched = runnersCommand(['preset', 'C'], {revision: String(readSettings(home).revision), reason: '전환'},
    {home, by: 'test', record: () => {}, floor: fakeFloor({})});
  assert.deepEqual(switched.relaunchPreview.activeChanged, {from: 'B', to: 'C', pinsNewWorks: false});
  const lines = relaunchLines(switched.relaunchPreview).join('\n');
  assert.match(lines, /기본 프리셋 B → C: 지금부터 만드는 업무는 고정되지 않는다\(비교 모드가 켜져 있거나/);
  assert.doesNotMatch(lines, /C에 고정된다/);
  assert.equal('preset' in create(home, repo, 'pin/w-in-compare'), false);
});
