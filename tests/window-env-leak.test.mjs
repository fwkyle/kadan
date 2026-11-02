// 창 없음(KADAN_WINDOW=none)이 tmux 서버 전역 환경에 남지 않는지 격리 소켓으로 잠근다(2026-11-02).
// 재부팅 뒤 launchd의 `up --hidden --auto`가 서버를 처음 만들 때 클라이언트 환경이 서버 전역으로 복사되어,
// 그 뒤 감독들이 모두 KADAN_WINDOW=none을 물려받았다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {tmux, currentSocket, tmuxClientEnv} from '../src/floor-tmux.mjs';
import {inheritedWindowWarning} from '../src/cli-start-support.mjs';
import {setWindowSetting} from '../src/window-setting.mjs';

const BIN = '/apps/Rottie/Contents/MacOS/rottie';

function withEnv(values, fn) {
  const before = {};
  for (const key of Object.keys(values)) { before[key] = process.env[key]; process.env[key] = values[key]; }
  try { return fn(); } finally {
    for (const key of Object.keys(values)) {
      if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
    }
  }
}

test('tmuxClientEnv는 창 값 둘만 빼고 나머지는 그대로 둔다', () => {
  const clean = tmuxClientEnv({KADAN_WINDOW: 'none', KADAN_ROTTIE_BIN: BIN, KADAN_HOME: '/h', KADAN_SOCKET: 's', PATH: '/p'});
  assert.deepEqual(clean, {KADAN_HOME: '/h', KADAN_SOCKET: 's', PATH: '/p'});
});

test('서버를 처음 만드는 호출의 KADAN_WINDOW·KADAN_ROTTIE_BIN이 서버 전역과 두 번째 세션 pane에 남지 않는다', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-env-leak-')), 'env.txt');
  try {
    withEnv({KADAN_WINDOW: 'none', KADAN_ROTTIE_BIN: BIN}, () => {
      const first = tmux(['new-session', '-d', '-s', 'leakprobe-a', 'sleep 30']);
      assert.equal(first.status, 0, first.stderr);
      const second = tmux(['new-session', '-d', '-s', 'leakprobe-b', `env > '${out}'; sleep 30`]);
      assert.equal(second.status, 0, second.stderr);
    });
    for (const name of ['KADAN_WINDOW', 'KADAN_ROTTIE_BIN']) {
      const shown = tmux(['show-environment', '-g', name]);
      assert.doesNotMatch(shown.stdout, new RegExp(`^${name}=`), `${name}이 서버 전역 환경에 남았다: ${shown.stdout}`);
    }
    const until = Date.now() + 3000;
    while (!fs.existsSync(out) && Date.now() < until) spawnSync('sleep', ['0.1']);
    const paneEnv = fs.readFileSync(out, 'utf8');
    assert.doesNotMatch(paneEnv, /^KADAN_WINDOW=/m);
    assert.doesNotMatch(paneEnv, /^KADAN_ROTTIE_BIN=/m);
  } finally {
    tmux(['kill-server']); // 이 시험의 격리 소켓 서버만 끈다
  }
});

test('사람이 준 none은 그 실행의 판단에 그대로 쓰인다(process.env는 건드리지 않는다)', () => {
  withEnv({KADAN_WINDOW: 'none'}, () => {
    tmuxClientEnv();
    assert.equal(process.env.KADAN_WINDOW, 'none');
  });
});

test('상속 경고: 카단 pane 안에서 환경 none + 기계 설정 rottie면 한 줄, 같거나 설정이 없거나 pane 밖이면 없다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-env-warn-'));
  const socket = currentSocket();
  const tmuxEnv = `/tmp/tmux-501/${socket},123,0`;
  assert.equal(inheritedWindowWarning({env: {TMUX: tmuxEnv, KADAN_WINDOW: 'none'}, home, socket}), null, '설정 없음');
  setWindowSetting(home, {window: 'rottie', rottieBin: BIN});
  const line = inheritedWindowWarning({env: {TMUX: tmuxEnv, KADAN_WINDOW: 'none'}, home, socket});
  assert.match(line, /^경고: 환경변수 KADAN_WINDOW=none이 기계 설정 rottie보다 우선한다/);
  assert.equal(line.includes('\n'), false);
  assert.equal(inheritedWindowWarning({env: {TMUX: tmuxEnv, KADAN_WINDOW: 'rottie'}, home, socket}), null, '같은 값');
  assert.equal(inheritedWindowWarning({env: {KADAN_WINDOW: 'none'}, home, socket}), null, 'pane 밖');
  assert.equal(inheritedWindowWarning({env: {TMUX: '/tmp/tmux-501/default,1,0', KADAN_WINDOW: 'none'}, home, socket}), null, '다른 소켓');
  assert.equal(inheritedWindowWarning({env: {TMUX: tmuxEnv}, home, socket}), null, '환경 값 없음');
});
