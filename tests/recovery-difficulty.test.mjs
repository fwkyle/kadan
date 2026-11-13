// 로티 탭 복원이 어려운 일 표시(start의 difficulty: hard)를 잇는지. restart·reopen은 이미 잇는다.
// 이 칸이 빠지면 복원된 어려운 일 작업자가 보통 작업자 기본값과 대조돼, 카드 발령이 "옛 세션"으로 거절된다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {inspectRecovery, restoreRecovery} from '../src/recovery.mjs';
import {DEFAULT_FAMILIES, readSettings, launchFor, launchForHard} from '../src/runner-settings.mjs';
import {guardedSend} from '../src/cli-guarded-send.mjs';
import {CardStore} from '../src/card-store.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';

const ID = '22222222-2222-4222-8222-222222222222';
const choice = model => ({runner: 'codex', model, effort: 'high'});

// 작업자 기본값과 어려운 일 자리가 서로 다른 모델인 설정, 그리고 격리 홈의 실제 원장.
function rig({difficulty, slot = difficulty === 'hard' ? 'hard' : 'worker'} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-recovery-difficulty-'));
  fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify({
    version: 1, revision: 1, activePreset: 'A', families: DEFAULT_FAMILIES,
    runners: {codex: {spawn: 'codex --model {model} -c model_reasoning_effort={effort}',
      models: ['fixture-normal', 'fixture-hard', 'fixture-hard-next', 'fixture-review'].map(model => ({model, efforts: ['high']}))}},
    presets: {A: {roles: {worker: choice('fixture-normal'), reviewer: choice('fixture-review'),
      'worker-hard': choice('fixture-hard')}}},
  }));
  const settings = readSettings(home);
  // slot: 어느 자리의 명령으로 띄웠나. difficulty: 시작 기록에 표시가 있나. 둘을 따로 줄 수 있다(대조용).
  const launch = slot === 'hard' ? launchForHard(settings) : launchFor(settings, 'worker');
  appendLedger({kind: 'start', floor: 'tmux', role: 'hw', session: 'kadan-hw', cwd: home, cmd: launch.cmd,
    panePid: '20', roleProfile: 'worker', by: 'lead', rottieTerminalId: 'old', harness: 'codex',
    model: launch.model, settingsRevision: 1, ...(difficulty ? {difficulty} : {})}, home);
  let pane = null, pid = 30, terminal = 0;
  const deps = {home, livePane: () => pane, warn: () => {},
    create: () => { pane = {pid: String(pid), dead: false, created: String(pid)}; return {panePid: String(pid++)}; },
    spawn: () => ({status: 0, stdout: JSON.stringify({ok: true, result: {terminal: {id: `new-${++terminal}`}}})})};
  // Rottie가 다시 만든 꼴: 절대경로 실행 파일 + resume + 카단이 알려 준 모델.
  const restore = (model, terminalId = 'old') => {
    const context = inspectRecovery({terminal: terminalId}, deps);
    pane = null;
    const receipt = restoreRecovery({context: JSON.stringify(context), 'rottie-bin': '/fixture/rottie',
      command: `exec '/tools/codex' 'resume' '${ID}' '--model' '${model}'`, 'allow-reuse': 'false'}, deps);
    return {receipt, start: readLedger(home).findLast(e => e.kind === 'start' && e.role === 'hw')};
  };
  // 그 세션에 어려움 카드를 실제 발령 경로로 보낸다(예외 옵션 없음).
  const dispatch = (start, id) => {
    const store = new CardStore(home);
    const card = store.create({repo: 'test', id, repoPath: home, body: '# 시험', difficulty: 'hard'});
    store.update(card.key, {status: 'assigned', role: 'hw', board: 'test', scope: '시험', rallyId: 'test',
      rallyTitle: '난이도', rallyRound: '1', rallyStep: 'implementation'}, {revision: 1, note: '시험 배정'});
    return guardedSend({floor: {name: 'fake', alive: () => true, pid: () => String(start.panePid), send: () => ({})},
      session: start.session, role: 'hw', message: '시험', taskId: card.id, recordedPid: String(start.panePid),
      env: {...process.env, KADAN_HOME: home, KADAN_ROLE: 'lead'}, readEntries: () => readLedger(home),
      record: e => appendLedger(e, home), saveBody: () => {}});
  };
  return {home, restore, dispatch, sends: () => readLedger(home).filter(e => e.kind === 'send' && e.role === 'hw')};
}

test('a restored hard worker keeps the mark and takes a hard card without an exception option', () => {
  const r = rig({difficulty: 'hard'});
  const {start} = r.restore('fixture-hard');
  assert.equal(start.difficulty, 'hard');
  assert.equal(start.restoredFrom, 'old');
  assert.ok(r.dispatch(start, 'hard-card'), '발령이 거절되지 않았다');
  const [sent] = r.sends();
  assert.equal(sent.difficulty, 'hard');
  assert.equal('difficultyMismatch' in sent, false);
  assert.equal('allowOldRunner' in sent, false);
});

test('the mark survives the next recovery generation too', () => {
  const r = rig({difficulty: 'hard'});
  const first = r.restore('fixture-hard');
  const second = r.restore('fixture-hard', first.receipt.terminalId);
  assert.equal(second.start.difficulty, 'hard');
  assert.equal(second.start.restoredFrom, first.receipt.terminalId);
  assert.ok(r.dispatch(second.start, 'hard-card-2'));
});

test('a normal worker gains no mark', () => {
  const r = rig();
  const {start} = r.restore('fixture-normal');
  assert.equal('difficulty' in start, false);
});

// 대조: 같은 명령·같은 모델로 떠 있어도 표시가 없던 세대는 표시 없이 복원되고, 그 세션은 보통 작업자 기본값과
// 대조돼 거절된다. 위 시험에서 발령이 통과한 까닭이 이어진 표시라는 것을 보인다.
test('without the mark the same restored session is checked against the worker default and refused', () => {
  const r = rig({slot: 'hard'});
  const {start} = r.restore('fixture-hard');
  assert.equal('difficulty' in start, false);
  assert.throws(() => r.dispatch(start, 'hard-card-control'),
    error => /카드 발령 거절: 옛 실행기·모델 세션이다/.test(error.message) && /worker 기본값/.test(error.message)
      && !/어려운 일 작업자 자리/.test(error.message));
});

// 표시는 "이 세션은 어려운 일 자리와 대조하라"는 뜻일 뿐이다. 실행 명령의 모델은 바꾸지 않으므로,
// 복원된 세션의 모델이 지금 자리 값과 다르면 발령은 여전히 거절된다(자리 값이 바뀐 옛 세션과 같은 판정).
test('the mark does not make a session with another model pass', () => {
  const r = rig({difficulty: 'hard'});
  const file = path.join(r.home, 'runner-settings.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.presets.A.roles['worker-hard'] = choice('fixture-hard-next');
  fs.writeFileSync(file, JSON.stringify(doc));
  const {start} = r.restore('fixture-hard');
  assert.equal(start.difficulty, 'hard');
  assert.throws(() => r.dispatch(start, 'hard-card-3'),
    error => /카드 발령 거절: 옛 실행기·모델 세션이다/.test(error.message)
      && /어려운 일 작업자 자리 = codex · fixture-hard-next/.test(error.message)
      && /--difficulty hard/.test(error.message) && !/설정을 읽을 수 없다/.test(error.message));
});
