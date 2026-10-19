import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { capturePane, capturePaneView, tmux } from '../src/floor-tmux.mjs';

test('격리 tmux: 실제 -p와 본문 바이트가 같고 kadan read에만 추천 표시', async () => {
  const session = 'kadan-ghost-live-fixture';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-pane-'));
  const script = path.join(dir, 'screen.mjs');
  const body = '\x1b[2m흐린 본문\x1b[0m\r\n' +
    '\x1b[38;5;2m색 본문\x1b[0m\r\n' +
    'KADAN:DONE fixture-only ok\r\n' +
    '❯\u00a0\x1b[2mTry\x1b[0m \x1b[2mhello\x1b[0m';
  fs.writeFileSync(script, `process.stdout.write(${JSON.stringify(body)});\nsetInterval(() => {}, 1000);\n`);
  const created = tmux(['new-session', '-d', '-s', session, '-x', '80', '-y', '12', process.execPath, script]);
  assert.equal(created.status, 0, created.stderr);
  try {
    let plain = '';
    const deadline = Date.now() + 5_000;
    while (!plain.includes('Try hello') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
      plain = tmux(['capture-pane', '-p', '-t', `=${session}:`]).stdout;
    }
    assert.ok(plain.includes('Try hello'), '고정 시험 화면 렌더링');
    const judge = capturePane(session);
    const view = capturePaneView(session);
    assert.equal(judge, plain.replace('❯\u00a0Try hello', '❯\u00a0'));
    assert.equal(view, plain.replace('Try hello', '(추천 문구: Try hello)'));
    const cli = spawnSync(process.execPath, ['src/cli.mjs', 'read', 'ghost-live-fixture', '--lines', '12'], {
      encoding: 'utf8', env: process.env, timeout: 10_000,
    });
    assert.equal(cli.status, 0, cli.stderr);
    // read 명령은 기존대로 화면 끝의 빈 줄을 접는다.
    assert.equal(cli.stdout, view.replace(/\n+$/u, '\n'));
  } finally {
    const stopped = tmux(['kill-session', '-t', `=${session}`]);
    assert.equal(stopped.status, 0, stopped.stderr);
  }
});
