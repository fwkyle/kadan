// 업무별 프리셋 지정(kadan/work-per-work-preset) 통합·단위 시험.
// 실제 agy/claude/codex 바이너리를 절대 실행하지 않고 격리 홈 안 가짜 셸 스크립트만 사용한다.
// tmux는 시험마다 격리 소켓(-L)만 쓰며 TMUX/TMUX_PANE을 제거한다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {WorkStore} from '../src/work-store.mjs';
import {workCommand} from '../src/work-command.mjs';
import {CardStore} from '../src/card-store.mjs';
import {AutomaticReview} from '../src/automatic-review.mjs';
import {DEFAULT_FAMILIES, readSettings, removePreset} from '../src/runner-settings.mjs';
import {setCompare} from '../src/runner-compare.mjs';
import {calculateCompareReport} from '../src/compare-report.mjs';
import {reviewerLaunch} from '../src/reviewer-launch.mjs';
import {inspectDispatchRunnerGuard} from '../src/dispatch-runner-guard.mjs';
import {guardedSend} from '../src/cli-guarded-send.mjs';
import {inspectCardSendIdentity} from '../src/ai-identity.mjs';
import {restartRole} from '../src/restart.mjs';
import {reopenRole} from '../src/reopen.mjs';
import {startDigest} from '../src/secretary-resume.mjs';
import {limitFallbackLine} from '../src/watch-limit-fallback.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {TABLE, settingsWith} from './helpers/runner-table.mjs';
import {generationLog} from './helpers/generation-log.mjs';

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
const hasTmux = spawnSync('tmux', ['-V']).status === 0;

function makeSettings() {
  return {
    version: 1,
    revision: 1,
    activePreset: 'B',
    families: {...DEFAULT_FAMILIES, gemini: ['gemini-', 'google/gemini-']},
    runners: {
      agy: {
        spawn: 'agy --model {model} --dangerously-skip-permissions',
        models: [
          {model: 'gemini-4-neon-xhigh', efforts: []},
          {model: 'gemini-4-neon-high', efforts: []},
        ],
      },
      claude: {
        spawn: 'claude --model {model} --effort {effort} --dangerously-skip-permissions',
        models: [
          {model: 'claude-fable-5-2', efforts: ['high']},
          {model: 'claude-sonnet-5-5', efforts: ['high']},
        ],
      },
      codex: {
        spawn: 'codex -p lite --model {model} -c model_reasoning_effort={effort}',
        models: [
          {model: 'gpt-6-sol', efforts: ['high']},
          {model: 'gpt-6-astra', efforts: ['high']},
          {model: 'gpt-6-hard-b', efforts: ['high']},
          {model: 'gpt-6-hard-fb', efforts: ['high']},
        ],
      },
    },
    presets: {
      B: {
        label: '기본 활성 프리셋',
        roles: {
          conductor: {runner: 'codex', model: 'gpt-6-sol', effort: 'high'},
          worker: {runner: 'codex', model: 'gpt-6-sol', effort: 'high'},
          'worker-hard': {runner: 'codex', model: 'gpt-6-hard-b', effort: 'high'},
          reviewer: {runner: 'claude', model: 'claude-sonnet-5-5', effort: 'high'},
        },
        fallback: {
          worker: [{runner: 'claude', model: 'claude-sonnet-5-5', effort: 'high'}],
          reviewer: [{runner: 'codex', model: 'gpt-6-astra', effort: 'high'}],
        },
      },
      'neon-루프': {
        label: 'neon 시험 루프',
        roles: {
          conductor: {runner: 'agy', model: 'gemini-4-neon-xhigh'},
          worker: {runner: 'agy', model: 'gemini-4-neon-high'},
          'worker-hard': {runner: 'agy', model: 'gemini-4-neon-xhigh'},
          reviewer: {runner: 'claude', model: 'claude-fable-5-2', effort: 'high'},
        },
        fallback: {
          worker: [{runner: 'codex', model: 'gpt-6-astra', effort: 'high'}],
          'worker-hard': [{runner: 'codex', model: 'gpt-6-hard-fb', effort: 'high'}],
          reviewer: [{runner: 'codex', model: 'gpt-6-sol', effort: 'high'}],
        },
      },
      'partial-only': {
        label: '작업자만 있는 프리셋',
        roles: {
          worker: {runner: 'codex', model: 'gpt-6-astra', effort: 'high'},
        },
      },
    },
    blocked: [],
  };
}

function makeHome({withSettings = true, settings = makeSettings()} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-work-preset-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-work-preset-repo-'));
  if (withSettings) {
    fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify(settings, null, 2));
  }
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  // 실제 agy/claude/codex를 실행하지 않고 잠만 자는 가짜 스크립트만 둔다.
  for (const name of ['agy', 'claude', 'codex']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexec sleep 60\n', {mode: 0o755});
  }
  return {home, repo, bin};
}

function cliRig(name, {home, repo, bin}) {
  const socket = `kadan-wpreset-${name}-${process.pid}-${Date.now()}`;
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    KADAN_HOME: home,
    KADAN_SOCKET: socket,
    KADAN_FLOOR: 'tmux',
    KADAN_WINDOW: 'none',
    KADAN_NOTIFY: 'off',
    KADAN_ALT_CHECK_MS: '0',
    KADAN_TRUST_TRIES: '1',
    KADAN_TRUST_INTERVAL_MS: '1',
  };
  delete env.TMUX;
  delete env.TMUX_PANE;
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], {
    env, cwd: repo, encoding: 'utf8', timeout: 15000,
  });
  const ok = (...args) => {
    const r = run(...args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    return r;
  };
  const cleanup = () => {
    console.log(`격리 소켓 kill-server: ${socket}`);
    spawnSync('tmux', ['-L', socket, 'kill-server'], {env});
  };
  return {env, socket, run, ok, cleanup};
}

const startsOf = (home, role) => readLedger(home).filter(e => e.kind === 'start' && e.role === role && e.cmd);

test('업무 프리셋: create/update/list/show 저장·변경·비우기 및 없는 프리셋·설정 없음 종료 2 거절', () => {
  const {home, repo} = makeHome();
  const ctx = {home, by: 'boss'};
  const base = {title: '업무', goal: '목표', scope: '범위', acceptance: '조건', owner: 'boss', 'repo-path': repo, board: '판'};

  // 프리셋을 안 준 업무는 그때의 기본(활성) 프리셋이 자동으로 고정된다(tests/work-preset-pin.test.mjs가 자세히 본다).
  const plain = workCommand(['create', 'repo-a/w-plain'], base, ctx);
  assert.equal(plain.preset, 'B');
  assert.equal(plain.presetAuto, true);

  // 지정 업무는 preset이 저장되고 show·list에 보인다.
  const neon = workCommand(['create', 'repo-a/w-neon'], {...base, preset: 'neon-루프'}, ctx);
  assert.equal(neon.preset, 'neon-루프');
  assert.equal('presetAuto' in neon, false);
  assert.equal(workCommand(['show', 'repo-a/w-neon'], {}, ctx).preset, 'neon-루프');
  const listed = workCommand(['list'], {}, ctx);
  assert.equal(listed.find(w => w.key === 'repo-a/w-neon').preset, 'neon-루프');
  assert.equal(listed.find(w => w.key === 'repo-a/w-plain').presetAuto, true);

  // update로 변경 및 ""로 비우기.
  const changed = workCommand(['update', 'repo-a/w-neon'], {revision: '1', preset: 'B', note: '변경'}, ctx);
  assert.equal(changed.preset, 'B');
  const cleared = workCommand(['update', 'repo-a/w-neon'], {revision: '2', preset: '', note: '비우기'}, ctx);
  assert.equal('preset' in cleared, false);

  // 거절 사례(모두 exitCode 2, revision 불변).
  for (const [label, fn, pattern] of [
    ['없는 프리셋 create', () => workCommand(['create', 'repo-a/w-bad1'], {...base, preset: 'no-such'}, ctx), /없는 프리셋: no-such/],
    ['빈 문자열 create', () => workCommand(['create', 'repo-a/w-bad2'], {...base, preset: ''}, ctx), /프리셋 이름/],
    ['값 없는 --preset create', () => workCommand(['create', 'repo-a/w-bad3'], {...base, preset: true}, ctx), /프리셋 이름/],
    ['없는 프리셋 update', () => workCommand(['update', 'repo-a/w-neon'], {revision: '3', preset: 'no-such', note: 'x'}, ctx), /없는 프리셋: no-such/],
    ['공백만 update', () => workCommand(['update', 'repo-a/w-neon'], {revision: '3', preset: '   ', note: 'x'}, ctx), /프리셋 이름/],
    ['값 없는 --preset update', () => workCommand(['update', 'repo-a/w-neon'], {revision: '3', preset: true, note: 'x'}, ctx), /--preset에는/],
  ]) {
    assert.throws(fn, err => err.exitCode === 2 && pattern.test(err.message), label);
  }
  assert.equal(new WorkStore(home).get('repo-a/w-neon').revision, 3);

  // 설정 파일 없음 거절.
  const noSettings = makeHome({withSettings: false});
  assert.throws(
    () => workCommand(['create', 'repo-a/w-noset'], {...base, 'repo-path': noSettings.repo, preset: 'B'}, {home: noSettings.home, by: 'boss'}),
    err => err.exitCode === 2 && /실행 모델 설정이 없다/.test(err.message),
  );
  // --help 안내 확인.
  const help = workCommand(['create'], {help: true}, ctx);
  assert.match(help, /--preset 프리셋/);
});

test('automatic-review: preset 변경 시 workStamp가 달라져 guard가 감지하고, 미지정 업무 해시는 불변', () => {
  const {home, repo} = makeHome();
  const works = new WorkStore(home), cards = new CardStore(home);
  const w = works.create({key: 'r/w1', title: '자동', goal: '목표', scope: '범위', acceptance: '조건', owner: 'boss', repoPath: repo, board: 'p', preset: 'neon-루프'});
  const impl = cards.create({repo: 'r', id: 'impl-ref', repoPath: repo, body: '# impl'});
  const rev = cards.create({repo: 'r', id: 'rev-ref', repoPath: repo, body: '# rev'});
  cards.update(impl.key, {status: 'ready', scope: '범위'}, {revision: 1, note: '준비'});
  cards.update(rev.key, {status: 'ready', scope: '범위'}, {revision: 1, note: '준비'});
  appendLedger({kind: 'start', role: 'w-role', session: 'kadan-w-role', floor: 'fake', panePid: '11', cmd: 'agy --model gemini-4-neon-high', model: 'gemini-4-neon-high'}, home);
  appendLedger({kind: 'start', role: 'r-role', session: 'kadan-r-role', floor: 'fake', panePid: '12', cmd: 'claude --model claude-fable-5-2 --effort high', model: 'claude-fable-5-2'}, home);
  appendLedger({kind: 'start', role: 'boss', session: 'kadan-boss', floor: 'fake', panePid: '13', cmd: 'agy --model gemini-4-neon-xhigh', model: 'gemini-4-neon-xhigh'}, home);
  const pids = {'kadan-w-role': '11', 'kadan-r-role': '12', 'kadan-boss': '13'};
  const floor = {name: 'fake', alive: s => Object.hasOwn(pids, s), pid: s => pids[s], read: () => ''};
  const auto = new AutomaticReview({home, by: 'boss', floor, send: () => ({})});
  const state = auto.configure(w.key, {revision: w.revision, implementation: impl.key, review: rev.key, worker: 'w-role', reviewer: 'r-role', notify: 'boss'});
  assert.doesNotThrow(() => auto.guard(state));
  works.change(w.key, 'update', {preset: 'B'}, {revision: w.revision, by: 'boss', note: '프리셋 변경'});
  assert.throws(() => auto.guard(state), /업무 범위·담당·실행 연결 변경/);
});

test('실물 CLI+격리 tmux: neon-루프 업무의 감독·작업자·어려움 작업자·검수자(--for) 시작, 원장·발령 검사·미지정 업무 거절·실패 닫힘', {skip: !hasTmux}, () => {
  const f = makeHome();
  const r = cliRig('neon', f);
  try {
    // (1) neon-루프 업무와 미지정 업무 생성
    const neonWork = JSON.parse(r.ok('work', 'create', 'repo-p/w-neon', '--title', '네온 업무', '--goal', '목표',
      '--scope', '범위', '--acceptance', '조건', '--owner', 'wp-cond', '--board', 'wp', '--repo-path', f.repo,
      '--preset', 'neon-루프').stdout);
    assert.equal(neonWork.preset, 'neon-루프');
    // 프리셋 없는 옛 업무(자동 고정 전에 만든 업무)를 만든다: 만든 뒤 프리셋을 비우면 지금처럼 활성 프리셋을 따른다.
    r.ok('work', 'create', 'repo-p/w-default', '--title', '기본 업무', '--goal', '목표',
      '--scope', '범위', '--acceptance', '조건', '--owner', 'wp-cond', '--board', 'wp', '--repo-path', f.repo);
    const defaultWork = JSON.parse(r.ok('work', 'update', 'repo-p/w-default', '--revision', '1', '--preset', '',
      '--note', '프리셋 없는 옛 업무 재현').stdout);
    assert.equal('preset' in defaultWork, false);

    // (2) 감독·작업자·어려움 작업자·검수자(--for 상속) 띄우기
    r.ok('start', 'wp-cond', '--hidden', '--no-prompt', '--profile', 'conductor', '--work', 'repo-p/w-neon');
    r.ok('start', 'wp-worker', '--hidden', '--no-prompt', '--profile', 'worker', '--work', 'repo-p/w-neon');
    r.ok('start', 'wp-hard', '--hidden', '--no-prompt', '--profile', 'worker', '--difficulty', 'hard', '--preset', 'neon-루프');
    r.ok('start', 'wp-rev', '--hidden', '--no-prompt', '--profile', 'reviewer', '--for', 'wp-worker');
    // 대조군: 활성 프리셋(B) 작업자
    r.ok('start', 'wp-b-worker', '--hidden', '--no-prompt', '--profile', 'worker');

    const [condStart] = startsOf(f.home, 'wp-cond');
    const [workerStart] = startsOf(f.home, 'wp-worker');
    const [hardStart] = startsOf(f.home, 'wp-hard');
    const [revStart] = startsOf(f.home, 'wp-rev');
    const [bWorkerStart] = startsOf(f.home, 'wp-b-worker');

    assert.equal(condStart.harness, 'agy');
    assert.equal(condStart.model, 'gemini-4-neon-xhigh');
    assert.equal(condStart.settingsPreset, 'neon-루프');
    assert.equal(condStart.presetSource, 'work');
    assert.equal(condStart.presetWorkKey, 'repo-p/w-neon');

    assert.equal(workerStart.harness, 'agy');
    assert.equal(workerStart.model, 'gemini-4-neon-high');
    assert.equal(workerStart.launchSource, 'settings');
    assert.equal(workerStart.settingsPreset, 'neon-루프');
    assert.equal(workerStart.presetSource, 'work');
    assert.equal(workerStart.presetWorkKey, 'repo-p/w-neon');
    assert.deepEqual(workerStart.runnerChoice, {runner: 'agy', model: 'gemini-4-neon-high'});

    assert.equal(hardStart.harness, 'agy');
    assert.equal(hardStart.model, 'gemini-4-neon-xhigh');
    assert.equal(hardStart.difficulty, 'hard');
    assert.equal(hardStart.settingsPreset, 'neon-루프');
    assert.equal(hardStart.presetSource, 'preset');
    assert.equal(hardStart.presetWorkKey, undefined);

    assert.equal(revStart.harness, 'claude');
    assert.equal(revStart.model, 'claude-fable-5-2');
    assert.equal(revStart.launchSource, 'review-for');
    assert.equal(revStart.settingsPreset, 'neon-루프');
    assert.equal(revStart.presetSource, 'review-for');
    assert.equal(revStart.presetWorkKey, 'repo-p/w-neon');
    assert.deepEqual(revStart.runnerChoice, {runner: 'claude', model: 'claude-fable-5-2', effort: 'high'});

    assert.equal(bWorkerStart.harness, 'codex');
    assert.equal(bWorkerStart.model, 'gpt-6-sol');
    assert.equal(bWorkerStart.settingsPreset, 'B');
    assert.equal(bWorkerStart.presetSource, undefined);

    // (3) 발령 검사(guardedSend): neon-루프 업무 카드 → neon-루프 작업자·검수자·어려움 작업자 통과
    const cards = new CardStore(f.home), works = new WorkStore(f.home);
    const makeCard = (id, role, step, workKey = null, difficulty = undefined) => {
      const card = cards.create({repo: 'repo-p', id, repoPath: f.repo, body: '# 지시', difficulty});
      cards.update(card.key, {status: 'assigned', role, board: 'wp', scope: '범위',
        rallyId: 'w', rallyTitle: '네온', rallyRound: '1', rallyStep: step}, {revision: 1, note: '배정'});
      if (workKey) {
        const cur = works.get(workKey);
        works.change(workKey, 'link', {execution: card.key, phase: step, round: 1}, {revision: cur.revision, by: 'wp-cond', note: '연결'});
      }
      return card;
    };
    const fakeFloor = pid => ({name: 'fake', alive: () => true, pid: () => String(pid), send: () => ({})});
    const sendCard = (card, start, {workKey = null} = {}) => {
      const warnings = [], orig = console.error;
      console.error = (...a) => warnings.push(a.join(' '));
      try {
        const entry = guardedSend({
          floor: fakeFloor(start.panePid), session: start.session, role: start.role,
          message: '카드 수행', taskId: card.id, recordedPid: String(start.panePid),
          mailContext: workKey ? {workKey, executionKey: card.key} : undefined,
          env: r.env, readEntries: () => readLedger(f.home),
          record: e => appendLedger(e, f.home), saveBody: () => {},
        });
        return {entry, warnings};
      } finally { console.error = orig; }
    };

    // workKey 명시 발령 + executionKey만 있는 발령(listLatest 조회) 모두 통과
    const cImpl1 = makeCard('c-neon-1', 'wp-worker', 'implementation', 'repo-p/w-neon');
    const sImpl1 = sendCard(cImpl1, workerStart, {workKey: 'repo-p/w-neon'});
    assert.equal(sImpl1.entry.settingsPreset, 'neon-루프');
    assert.deepEqual(sImpl1.entry.runnerChoice, {runner: 'agy', model: 'gemini-4-neon-high'});
    assert.equal(sImpl1.entry.runnerGuard, undefined);

    const cImpl2 = makeCard('c-neon-2', 'wp-worker', 'fix', 'repo-p/w-neon');
    const sImpl2 = sendCard(cImpl2, workerStart); // workKey 생략 → executionKey로 연결 업무 조회
    assert.equal(sImpl2.entry.settingsPreset, 'neon-루프');
    assert.equal(sImpl2.entry.runnerGuard, undefined);

    const cRev = makeCard('c-neon-rev', 'wp-rev', 'review', 'repo-p/w-neon');
    const sRev = sendCard(cRev, revStart, {workKey: 'repo-p/w-neon'});
    assert.equal(sRev.entry.settingsPreset, 'neon-루프');
    assert.deepEqual(sRev.entry.runnerChoice, {runner: 'claude', model: 'claude-fable-5-2', effort: 'high'});
    assert.equal(sRev.entry.runnerGuard, undefined);

    // 어려움 카드 → neon-루프 hard 작업자는 통과, 보통 작업자는 difficultyMismatch 경고(--preset neon-루프 포함)
    const cHard = makeCard('c-neon-hard', 'wp-hard', 'implementation', 'repo-p/w-neon', 'hard');
    assert.equal(sendCard(cHard, hardStart, {workKey: 'repo-p/w-neon'}).entry.difficulty, 'hard');
    const cHardToNormal = makeCard('c-neon-hard2', 'wp-worker', 'implementation', 'repo-p/w-neon', 'hard');
    const sMismatch = sendCard(cHardToNormal, workerStart, {workKey: 'repo-p/w-neon'});
    assert.equal(sMismatch.entry.difficultyMismatch, true);
    assert.ok(sMismatch.warnings.some(line => line.includes('--preset neon-루프')), sMismatch.warnings.join('\n'));

    // (4) 미지정 업무(B)에 neon-루프 세션을 섞어 보내면 거절 (기존 activePreset 문구 유지)
    const cDefToNeon = makeCard('c-def-neon', 'wp-worker', 'implementation', 'repo-p/w-default');
    assert.throws(() => sendCard(cDefToNeon, workerStart, {workKey: 'repo-p/w-default'}), e => {
      assert.equal(e.code, 'KADAN_STALE_RUNNER');
      assert.match(e.message, /worker 기본값 = codex · gpt-6-sol · high/);
      assert.doesNotMatch(e.message, /--preset/);
      return true;
    });
    // 반대: neon-루프 업무에 활성 프리셋(B) 세션을 보내면 거절 + --preset neon-루프 안내
    const cNeonToB = makeCard('c-neon-b', 'wp-b-worker', 'implementation', 'repo-p/w-neon');
    assert.throws(() => sendCard(cNeonToB, bWorkerStart, {workKey: 'repo-p/w-neon'}), e => {
      assert.equal(e.code, 'KADAN_STALE_RUNNER');
      assert.match(e.message, /프리셋 neon-루프 worker 기본값 = agy · gemini-4-neon-high/);
      assert.match(e.message, /--preset neon-루프/);
      return true;
    });
    // 미지정 업무(B)에 B 세션은 통과
    const cDefToB = makeCard('c-def-b', 'wp-b-worker', 'implementation', 'repo-p/w-default');
    assert.equal(sendCard(cDefToB, bWorkerStart, {workKey: 'repo-p/w-default'}).entry.settingsPreset, 'B');

    // (5) 업무 밖 단독 카드 → 지정 프리셋 세션 통과(pinnedKind='session')
    const cStandalone = makeCard('c-standalone', 'wp-worker', 'implementation', null);
    assert.equal(sendCard(cStandalone, workerStart).entry.runnerGuard, undefined);

    // (6) neon-루프 폴백 세션 → neon-루프 업무에서는 폴백 경고로 통과, 미지정 업무에서는 거절
    r.ok('start', 'wp-fb', '--hidden', '--no-prompt', '--profile', 'worker', '--preset', 'neon-루프', '--fallback', '1', '--reason', '한도');
    const [fbStart] = startsOf(f.home, 'wp-fb');
    assert.equal(fbStart.settingsPreset, 'neon-루프');
    assert.equal(fbStart.presetSource, 'preset');
    assert.equal(fbStart.model, 'gpt-6-astra');
    const cFbNeon = makeCard('c-fb-neon', 'wp-fb', 'implementation', 'repo-p/w-neon');
    const sFb = sendCard(cFbNeon, fbStart, {workKey: 'repo-p/w-neon'});
    assert.equal(sFb.entry.runnerGuard.code, 'fallback');
    assert.equal(sFb.entry.runnerGuard.fallbackIndex, 1);
    assert.ok(sFb.warnings.some(line => line.includes('프리셋 neon-루프 worker 폴백 1번')), sFb.warnings.join('\n'));
    const cFbDef = makeCard('c-fb-def', 'wp-fb', 'implementation', 'repo-p/w-default');
    assert.throws(() => sendCard(cFbDef, fbStart, {workKey: 'repo-p/w-default'}), e => e.code === 'KADAN_STALE_RUNNER');

    // (7) 충돌 옵션·없는 프리셋·빈 역할·--for 프리셋 불일치 모두 종료 2 거절(세션 생성 0)
    const badCases = [
      ['--preset+--work', ['x1', '--profile', 'worker', '--preset', 'neon-루프', '--work', 'repo-p/w-neon'], /함께 쓸 수 없다/],
      ['--preset+--cmd', ['x2', '--profile', 'worker', '--preset', 'neon-루프', '--cmd', 'codex --model gpt-6-sol'], /--cmd와 함께 쓸 수 없다/],
      ['--work+--cmd', ['x3', '--profile', 'worker', '--work', 'repo-p/w-neon', '--cmd', 'codex --model gpt-6-sol'], /--cmd와 함께 쓸 수 없다/],
      ['빈 --preset', ['x4', '--profile', 'worker', '--preset', ''], /프리셋 이름이 필요/],
      ['값 없는 --preset', ['x5', '--profile', 'worker', '--preset'], /프리셋 이름이 필요/],
      ['없는 프리셋', ['x6', '--profile', 'worker', '--preset', 'ghost'], /없는 프리셋: ghost/],
      ['없는 업무', ['x7', '--profile', 'worker', '--work', 'repo-p/no-work'], /업무를 찾을 수 없다/],
      ['재사용 세션에 --preset', ['wp-worker', '--profile', 'worker', '--preset', 'neon-루프'], /새로 띄울 때만/],
      ['PROFILE_ROLES 밖 프로필', ['x8', '--profile', 'secretary', '--preset', 'neon-루프'], /worker\|reviewer\|conductor\|super에서만/],
      ['역할 값 없는 프리셋', ['x9', '--profile', 'conductor', '--preset', 'partial-only'], /프리셋 partial-only에 conductor 역할 값이 없다/],
      ['--for 프리셋 불일치', ['x10', '--profile', 'reviewer', '--for', 'wp-worker', '--preset', 'B'], /작업자 wp-worker의 프리셋\(neon-루프\)과 다르다/],
    ];
    for (const [label, args, pattern] of badCases) {
      const out = r.run('start', ...args, '--hidden', '--no-prompt');
      assert.equal(out.status, 2, `${label}: status=${out.status}, stderr=${out.stderr}`);
      assert.match(out.stderr, pattern, label);
    }
    for (const role of ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8', 'x9', 'x10']) {
      assert.equal(startsOf(f.home, role).length, 0, role);
    }

    // (8) 열린 업무가 쓰는 프리셋은 지울 수 없다. 설정 파일을 손으로 고쳐 이름이 사라진 경우에는 start --work와 발령 검사 모두 실패 닫힘
    assert.throws(() => removePreset(f.home, {name: 'neon-루프', revision: readSettings(f.home).revision, by: 'test', reason: '삭제 시험', record: () => {}}),
      /열린 업무 1건이 쓰고 있어.*repo-p\/w-neon/);
    const edited = readSettings(f.home);
    delete edited.presets['neon-루프'];
    fs.writeFileSync(path.join(f.home, 'runner-settings.json'), JSON.stringify(edited, null, 2));
    const deletedStart = r.run('start', 'wp-deleted', '--hidden', '--no-prompt', '--profile', 'worker', '--work', 'repo-p/w-neon');
    assert.equal(deletedStart.status, 2);
    assert.match(deletedStart.stderr, /없는 프리셋: neon-루프/);
    const cAfterDel = makeCard('c-after-del', 'wp-worker', 'implementation', 'repo-p/w-neon');
    assert.throws(() => sendCard(cAfterDel, workerStart, {workKey: 'repo-p/w-neon'}), e => {
      assert.equal(e.code, 'KADAN_STALE_RUNNER');
      assert.match(e.message, /없는 프리셋: neon-루프/);
      return true;
    });
    assert.throws(() => reviewerLaunch({
      settings: readSettings(f.home), entries: readLedger(f.home),
      workerRole: 'wp-worker', workerSession: 'kadan-wp-worker', currentPid: String(workerStart.panePid),
    }), /없는 프리셋: neon-루프/);
  } finally { r.cleanup(); }
});

test('비교 모드 ON: 명시 프리셋 우선(compare-pick 없음), 미지정 업무는 비교 모드 유지, compareReport 정상 집계', {skip: !hasTmux}, () => {
  const f = makeHome();
  setCompare(f.home, {enabled: true, presets: 'B,neon-루프', revision: 1, by: 'test', reason: '비교 켜기', record: () => {}});
  const r = cliRig('compare', f);
  try {
    r.ok('work', 'create', 'repo-c/w-neon', '--title', '네온', '--goal', '목표', '--scope', '범위',
      '--acceptance', '조건', '--owner', 'c-boss', '--board', 'c', '--repo-path', f.repo, '--preset', 'neon-루프');
    r.ok('work', 'create', 'repo-c/w-plain', '--title', '기본', '--goal', '목표', '--scope', '범위',
      '--acceptance', '조건', '--owner', 'c-boss', '--board', 'c', '--repo-path', f.repo);

    // 명시 --preset 및 preset 있는 --work: compare-pick 0건, compareMode·pickId 없음
    r.ok('start', 'cmp-explicit', '--hidden', '--no-prompt', '--profile', 'worker', '--preset', 'neon-루프');
    r.ok('start', 'cmp-work', '--hidden', '--no-prompt', '--profile', 'worker', '--work', 'repo-c/w-neon');
    assert.equal(readLedger(f.home).filter(e => e.kind === 'compare-pick').length, 0);
    for (const role of ['cmp-explicit', 'cmp-work']) {
      const [s] = startsOf(f.home, role);
      assert.equal(s.settingsPreset, 'neon-루프');
      assert.equal(s.compareMode, undefined);
      assert.equal(s.pickId, undefined);
      assert.ok(s.presetSource);
    }

    // 미지정 업무 --work: 기존 비교 모드 유지(compare-pick 1건)
    r.ok('start', 'cmp-plain', '--hidden', '--no-prompt', '--profile', 'worker', '--work', 'repo-c/w-plain');
    const [plainStart] = startsOf(f.home, 'cmp-plain');
    assert.equal(plainStart.compareMode, true);
    assert.ok(plainStart.pickId);
    assert.equal(plainStart.presetSource, undefined);
    assert.equal(readLedger(f.home).filter(e => e.kind === 'compare-pick').length, 1);

    // compareReport 정상 집계 확인(지정 프리셋 업무가 unknown/mixed로 빠지지 않고 runnerChoice 행으로 집계)
    const now = new Date().toISOString();
    const report = calculateCompareReport({
      works: [{
        key: 'repo-c/w-neon', status: 'done',
        executions: [
          {key: 'repo-c/e-impl', phase: 'implementation', round: 1},
          {key: 'repo-c/e-rev', phase: 'review', round: 1},
        ],
      }],
      cards: [
        {key: 'repo-c/e-impl', result: {outcome: 'implemented'}},
        {key: 'repo-c/e-rev', result: {outcome: 'pass'}},
      ],
      entries: [
        {kind: 'send', t: now, role: 'cmp-work', taskId: 'e-impl', executionKey: 'repo-c/e-impl',
          settingsPreset: 'neon-루프', compareMode: false, pickId: null, launchSource: 'settings',
          runnerChoice: {runner: 'agy', model: 'gemini-4-neon-high'}},
        {kind: 'done', t: now, role: 'cmp-work', taskId: 'e-impl', executionKey: 'repo-c/e-impl', result: 'ok'},
        {kind: 'send', t: now, role: 'cmp-rev', taskId: 'e-rev', executionKey: 'repo-c/e-rev',
          settingsPreset: 'neon-루프', compareMode: false, pickId: null, launchSource: 'review-for',
          runnerChoice: {runner: 'claude', model: 'claude-fable-5-2', effort: 'high'},
          reviewFor: {role: 'cmp-work'}},
        {kind: 'done', t: now, role: 'cmp-rev', taskId: 'e-rev', executionKey: 'repo-c/e-rev', result: 'ok'},
      ],
    });
    assert.equal(report.unknown.count, 0);
    assert.deepEqual(report.unknown.workIds, []);
    assert.equal(report.groups.length, 1);
    assert.equal(report.groups[0].rows[0].samples, 1);
    assert.equal(report.groups[0].rows[0].firstRoundPasses, 1);
    assert.deepEqual(report.groups[0].rows[0].presets, ['neon-루프']);
  } finally { r.cleanup(); }
});

test('restart · reopen · watch-limit-fallback: 지정 프리셋 이어 적기, --model-from-settings, 삭제 시 거절, 한도 안내 --preset', () => {
  const ID = '0197aaaa-1111-4222-8333-444455556666';
  const OLD = 'claude --model claude-haiku-5-5 --effort low --dangerously-skip-permissions';
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-preset-carry-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-preset-carry-u-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-preset-carry-cwd-'));
  fs.mkdirSync(path.join(homeDir, '.claude/sessions'), {recursive: true});
  fs.mkdirSync(path.join(homeDir, '.claude/projects/-x'), {recursive: true});
  fs.writeFileSync(path.join(homeDir, '.claude/sessions/150.json'), JSON.stringify({sessionId: ID, tmux: 'kadan-w:@3.%3'}));
  fs.writeFileSync(path.join(homeDir, `.claude/projects/-x/${ID}.jsonl`), '{}');

  const settings = {
    ...settingsWith(),
    revision: 5,
    activePreset: 'B',
    presets: {
      B: {roles: {worker: {runner: 'claude', model: 'claude-opus-5-5', effort: 'high'}}},
      'neon-루프': {roles: {worker: {runner: 'claude', model: 'claude-sonnet-5-5', effort: 'high'}}},
    },
  };
  const makeRestart = (extra = {}) => {
    const entries = [{kind: 'start', floor: 'tmux', role: 'w', session: 'kadan-w', cmd: OLD, cwd, panePid: '100',
      roleProfile: 'worker', by: 'boss', t: '2026-11-26T00:00:00Z', ...extra}];
    let pid = '100';
    const log = [];
    const floor = {name: 'tmux', alive: () => true, pid: () => pid,
      stop: s => log.push(['stop', s]), create: () => { pid = '200'; return {panePid: '200'}; }};
    const deps = {
      read: () => entries, record: e => entries.push({t: new Date().toISOString(), ...e}),
      pendingCards: () => [], closeWindow: () => ({}), openWindow: () => ({method: 'manual'}),
      paneInfo: () => ({panePid: '100', location: 'kadan-w:@3.%3'}),
      processTree: () => [{pid: '100', ppid: '1', args: '-zsh'}, {pid: '150', ppid: '100', args: OLD}],
      openFiles: () => [], processStartedAt: () => 1000,
      readJson: f => JSON.parse(fs.readFileSync(f, 'utf8')), homeDir, beforeStop: () => {},
    };
    return {entries, log, run: (flags, s = settings) => restartRole({home, role: 'w', session: 'kadan-w', flags, floor, settings: s, deps})};
  };

  // (1) 평소 restart: presetSource·settingsPreset·presetWorkKey 이어 적기
  const plain = makeRestart({presetSource: 'work', settingsPreset: 'neon-루프', presetWorkKey: 'r/w1'});
  plain.run({});
  const restarted = plain.entries.at(-1);
  assert.equal(restarted.presetSource, 'work');
  assert.equal(restarted.settingsPreset, 'neon-루프');
  assert.equal(restarted.presetWorkKey, 'r/w1');

  // (2) restart --model-from-settings: 활성 프리셋(opus)이 아니라 지정 프리셋 neon-루프(sonnet)를 읽는다
  const fromSet = makeRestart({presetSource: 'work', settingsPreset: 'neon-루프', presetWorkKey: 'r/w1'});
  const receipt = fromSet.run({'model-from-settings': true});
  assert.equal(receipt.model, 'claude-sonnet-5-5');
  assert.equal(receipt.modelFromSettings.preset, 'neon-루프');
  const nextStart = fromSet.entries.at(-1);
  assert.equal(nextStart.presetSource, 'work');
  assert.equal(nextStart.settingsPreset, 'neon-루프');
  assert.equal(nextStart.presetWorkKey, 'r/w1');

  // (3) 지정 프리셋 삭제 시 끄기 전 거절
  const deleted = structuredClone(settings);
  delete deleted.presets['neon-루프'];
  const blocked = makeRestart({presetSource: 'preset', settingsPreset: 'neon-루프'});
  assert.throws(() => blocked.run({'model-from-settings': true}, deleted), /지정 프리셋\(neon-루프\)이 없다/);
  assert.equal(blocked.log.length, 0);

  // (4) reopen: presetSource·settingsPreset·presetWorkKey 이어 적기
  const startEntry = {
    kind: 'start', floor: 'tmux', role: 'w', session: 'kadan-w', cmd: OLD, cwd, panePid: '100',
    roleProfile: 'worker', by: 'boss', outputLog: generationLog('kadan-w', 1),
    launchSource: 'settings', presetSource: 'work', settingsPreset: 'neon-루프', presetWorkKey: 'r/w1',
    t: '2026-11-26T00:00:00Z',
  };
  const reopenEntries = [
    startEntry,
    {kind: 'stop', role: 'w', session: 'kadan-w', by: 'boss', conversation: ID,
      conversationStart: startDigest(startEntry), t: '2026-11-26T01:00:00Z'},
  ];
  let alive = false;
  reopenRole({
    home, role: 'w', session: 'kadan-w',
    floor: {name: 'tmux', alive: () => alive, pid: () => '200', stop: () => {}, create: () => { alive = true; return {panePid: '200'}; }},
    settings: {...settingsWith(TABLE), presets: settings.presets},
    deps: {
      read: () => reopenEntries, record: e => reopenEntries.push({t: '2026-11-26T02:00:00Z', ...e}),
      modelChoices: () => new Map([['claude-haiku-5-5', ['low']]]),
      windowPolicy: () => ({}), openWindow: () => ({method: 'manual'}),
      register: () => ({registered: false, reason: '이미 등록됨'}),
      pendingCards: () => [], exists: () => true, homeDir,
    },
  });
  const reopened = reopenEntries.at(-1);
  assert.equal(reopened.presetSource, 'work');
  assert.equal(reopened.settingsPreset, 'neon-루프');
  assert.equal(reopened.presetWorkKey, 'r/w1');

  // (5) watch-limit-fallback: 지정 프리셋의 폴백 목록을 보고 --preset <이름> 포함(추가 읽기 0건)
  const limitSettings = makeSettings();
  const limitLine = limitFallbackLine({
    alert: {kind: '한도', role: 'w', session: 'kadan-w', line: "You've hit your session limit · resets 3pm"},
    entries: [{
      kind: 'start', role: 'w', session: 'kadan-w', roleProfile: 'worker',
      cmd: 'agy --model gemini-4-neon-high --dangerously-skip-permissions',
      presetSource: 'work', settingsPreset: 'neon-루프',
    }],
    settings: limitSettings,
    ocx: null,
  });
  assert.match(limitLine, /--profile worker --preset neon-루프 --fallback 1 /);
  // 지정 프리셋에 폴백이 없으면 활성 프리셋 폴백으로 내려가지 않는다.
  const noFb = limitFallbackLine({
    alert: {kind: '한도', role: 'w', session: 'kadan-w', line: "You've hit your session limit · resets 3pm"},
    entries: [{
      kind: 'start', role: 'w', session: 'kadan-w', roleProfile: 'worker',
      cmd: 'agy --model gemini-4-neon-high --dangerously-skip-permissions',
      presetSource: 'preset', settingsPreset: 'partial-only',
    }],
    settings: limitSettings,
    ocx: null,
  });
  assert.equal(noFb, null);
  assert.equal(limitFallbackLine.length, 1);

  // (6) dispatch-runner-guard 실패 닫힘: pinnedKind 있을 때 설정 없음/역할 없음 모두 settings-unreadable
  const noSetGuard = inspectDispatchRunnerGuard({
    home, role: 'w', session: 'kadan-w', profile: 'worker', phaseProfile: 'worker',
    workPreset: 'neon-루프', hasWork: true,
    identity: inspectCardSendIdentity({entries: [startEntry], session: 'kadan-w', currentPid: '100'}),
    readSettingsFn: () => null,
  });
  assert.equal(noSetGuard.result, 'reject');
  assert.equal(noSetGuard.code, 'settings-unreadable');
});
