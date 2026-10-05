import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {findDoneMarkers, screenDoneResult, waitScreenDone} from '../src/cli.mjs';
import {CardStore} from '../src/card-store.mjs';
import {readLedger} from '../src/ledger.mjs';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const cards = [{key:'repo/card-a', id:'card-a'}, {key:'repo/card-a-2', id:'card-a-2'}];
const dispatch = (baselineMarkers = []) => ({kind:'send', session:'kadan-p-검수자', role:'p-검수자', taskId:'card-a', executionKey:'repo/card-a', baselineMarkers});
const check = (text, entries = [dispatch()], taskId = 'repo/card-a') => screenDoneResult({text, entries, role:'p-검수자', taskId, cards});

test('화면 DONE 대조: 짧은 id·정식 주소·응답 머리표(•·⏺) 모두 같은 카드로 읽는다', () => {
  assert.equal(check('끝\nKADAN:DONE card-a ok\n').result, 'ok');
  assert.equal(check('• KADAN:DONE repo/card-a failed').result, 'failed');
  assert.equal(check('⏺ KADAN:DONE card-a ok', undefined, 'card-a').result, 'ok');
  // 여러 줄이면 마지막 줄의 결과를 쓴다.
  assert.deepEqual([check('KADAN:DONE card-a failed\n• KADAN:DONE repo/card-a ok').result, check('KADAN:DONE card-a failed\n• KADAN:DONE repo/card-a ok').count], ['ok', 2]);
});

test('화면 DONE 대조: 되풀이된 지시문, 이름이 비슷한 다른 카드, 발령 전부터 있던 마커는 인정하지 않는다', () => {
  assert.equal(check('› 단독으로 KADAN:DONE repo/card-a ok 만 출력하라.').result, null);
  assert.equal(check('❯ KADAN:DONE card-a ok').result, null);
  assert.equal(check('KADAN:DONE card-a-2 ok\nKADAN:DONE other/card-a ok').result, null);
  const before = [{taskId:'card-a', result:'ok'}];
  assert.equal(check('KADAN:DONE card-a ok', [dispatch(before)]).result, null);
  assert.equal(check('KADAN:DONE card-a ok\n• KADAN:DONE card-a ok', [dispatch(before)]).result, 'ok');
  // 카드 id 없는 재출력 요청(--raw)은 발령 기준이 아니다 — 마지막 발령의 기준만 쓴다.
  const nudge = {kind:'send', session:'kadan-p-검수자', role:'p-검수자', baselineMarkers:[{taskId:'card-a', result:'ok'}]};
  assert.equal(check('KADAN:DONE card-a ok', [dispatch(), nudge]).result, 'ok');
  // 발령 기록이 없으면 화면 전체를 본다.
  const found = check('KADAN:DONE card-a ok', []);
  assert.deepEqual([found.result, found.dispatch], ['ok', null]);
});

test('--wait: 마커가 늦게 찍히면 유한 대기 안에서 다시 읽어 확정하고, 시간이 다 되면 마커 없음 그대로다 — 완료 편지가 마커보다 먼저 오는 경합(1-H1)', () => {
  let clock = 0; const sleeps = [];
  const sleep = ms => { sleeps.push(ms); clock += ms; };
  const screens = ['작업 중…', '작업 중…', '끝\nKADAN:DONE card-a ok\n'];
  let i = 0;
  const found = waitScreenDone({ readScreen: () => screens[Math.min(i++, screens.length - 1)], entries: [dispatch()], role: 'p-검수자', taskId: 'repo/card-a', cards, waitMs: 10_000, intervalMs: 2_000, sleep, now: () => clock });
  assert.deepEqual([found.result, found.reads, sleeps], ['ok', 3, [2000, 2000]]);
  // 시간 초과: 마지막 sleep은 남은 시간만큼만, 결과는 null(종료코드 3은 부르는 쪽이 유지).
  clock = 0; sleeps.length = 0;
  const none = waitScreenDone({ readScreen: () => '아직', entries: [dispatch()], role: 'p-검수자', taskId: 'repo/card-a', cards, waitMs: 5_000, intervalMs: 2_000, sleep, now: () => clock });
  assert.deepEqual([none.result, none.reads, sleeps], [null, 4, [2000, 2000, 1000]]);
  // --wait 없음(기본 0): 한 번만 읽고 기다리지 않는다.
  clock = 0; sleeps.length = 0;
  const once = waitScreenDone({ readScreen: () => '아직', entries: [dispatch()], role: 'p-검수자', taskId: 'repo/card-a', cards, sleep, now: () => clock });
  assert.deepEqual([once.result, once.reads, sleeps], [null, 1, []]);
});

test('완료 마커 읽기는 응답 머리표를 허용하고 입력 되풀이 머리표는 거부한다', () => {
  assert.deepEqual(findDoneMarkers('• KADAN:DONE x ok\n⏺ KADAN:DONE y failed\n› KADAN:DONE z ok\n  KADAN:DONE w ok'),
    [{taskId:'x', result:'ok'}, {taskId:'y', result:'failed'}, {taskId:'w', result:'ok'}]);
});

test('CLI: done --from-screen은 화면 표시로 확정하고, 없으면 기록·전송 없이 3으로 실패한다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-done-screen-'));
  const store = new CardStore(home);
  store.create({repo:'repo', id:'card-a', repoPath:home, body:'# 화면 확정', by:'사람'});
  const socket = `done-screen-test-${process.pid}-${Date.now()}`;
  const env = {...process.env, KADAN_HOME:home, KADAN_SOCKET:socket, KADAN_FLOOR:'tmux', KADAN_WINDOW:'none', KADAN_ROLE:'p-감독'};
  delete env.KADAN_LITE_HOME;
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], {env, encoding:'utf8', timeout:15000});
  const script = (name, text) => { const file = path.join(home, name); fs.writeFileSync(file, `#!/bin/sh\nprintf '${text}'\nexec sleep 30\n`, {mode:0o755}); return file; };
  const settle = () => spawnSync('sleep', ['0.5']);
  try {
    assert.equal(run('start', 'p-검수자', '--hidden', '--cmd', script('w1.sh', '검수 끝\\n• KADAN:DONE card-a ok\\n')).status, 0);
    assert.equal(run('start', 'p-빈칸', '--hidden', '--cmd', script('w2.sh', '결과만 저장\\n')).status, 0);
    settle();
    const usage = run('done', 'p-검수자', 'repo/card-a', 'ok', '--from-screen');
    assert.equal(usage.status, 2); assert.match(usage.stderr, /사용법/);
    const missing = run('done', 'p-빈칸', 'repo/card-a', '--from-screen');
    assert.equal(missing.status, 3); assert.match(missing.stderr, /화면 완료 표시 없음: 역할=p-빈칸 카드=repo\/card-a \(발령 기록 없음/);
    assert.match(run('done', 'p-없음', 'card-a', '--from-screen').stderr, /세션 없음/);
    const ok = run('done', 'p-검수자', 'repo/card-a', '--from-screen');
    assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /^완료 확정: 역할=p-검수자 카드=card-a 결과=ok 확인=p-감독/);
    const done = readLedger(home).filter(e => e.kind === 'done');
    assert.deepEqual(done.map(e => [e.role, e.executionKey, e.result, e.by]), [['p-검수자', 'repo/card-a', 'ok', 'p-감독']]);
    assert.match(run('done', 'p-검수자', 'card-a', '--from-screen').stderr, /이미 완료 확정됨/);
  } finally {
    spawnSync('tmux', ['-L', socket, 'kill-server']);
  }
});
