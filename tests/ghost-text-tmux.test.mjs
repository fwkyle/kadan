import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { capturePane, capturePaneView, tmux } from '../src/floor-tmux.mjs';
import { splitGhostText } from '../src/ghost-text.mjs';
import { assessIdleStop, readStatusLine } from '../src/watch-status-line.mjs';
import { changeDigest } from '../src/watch-roles.mjs';
import { findDoneMarkers } from '../src/done-marker.mjs';

test('격리 tmux: 실제 -p와 본문 바이트가 같고 kadan read에만 추천 표시', async () => {
  const session = 'kadan-ghost-live-fixture';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-pane-'));
  const script = path.join(dir, 'screen.mjs');
  const body = '\x1b[2m흐린 본문\x1b[0m\r\n' +
    '\x1b[38;5;2m색 본문\x1b[0m\r\n' +
    'KADAN:DONE fixture-only ok\r\n' +
    '────────────────────\r\n' +
    '❯\u00a0\x1b[2mTry\x1b[0m \x1b[2mhello\x1b[0m\r\n' +
    '────────────────────\r\n  Haiku 5.5 | effort:low';
  fs.writeFileSync(script, `process.stdout.write(${JSON.stringify(body)});\nsetInterval(() => {}, 1000);\n`);
  const created = tmux(['new-session', '-d', '-s', session, '-x', '80', '-y', '12', process.execPath, script]);
  assert.equal(created.status, 0, created.stderr);
  try {
    let plain = '';
    const deadline = Date.now() + 5_000;
    while (!plain.includes('effort:low') && Date.now() < deadline) {
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

// 검수 F1~F3 고정 화면을 실제 tmux로 다시 그린다. AI·운영 소켓은 쓰지 않는다.
async function fixedScreen(name, body, ready = 'READY-END', width = 80) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-boundary-'));
  const script = path.join(dir, 'screen.mjs');
  const session = `kadan-ghost-boundary-${name}`;
  fs.writeFileSync(script, `process.stdout.write(${JSON.stringify(body)});\nsetInterval(() => {}, 1000);\n`);
  const created = tmux(['new-session', '-d', '-s', session, '-x', String(width), '-y', '35',
    process.execPath, script]);
  assert.equal(created.status, 0, created.stderr);
  try {
    let plain = '';
    const deadline = Date.now() + 5_000;
    while (!plain.includes(ready) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
      plain = tmux(['capture-pane', '-p', '-t', `=${session}:`]).stdout;
    }
    assert.ok(plain.includes(ready), `고정 화면 렌더링: ${name}`);
    const ansi = tmux(['capture-pane', '-e', '-p', '-t', `=${session}:`]).stdout;
    return { plain, ansi, ...splitGhostText(ansi), captured: capturePane(session) };
  } finally {
    assert.equal(tmux(['kill-session', '-t', `=${session}`]).status, 0);
  }
}

test('F1: 입력칸 없는 흐린 본문 인용 보존, 4분 뒤 거짓 멈춤 경보 0건', async () => {
  const out = await fixedScreen('no-composer',
    '• 답변 출력 중\r\n\x1b[2m› 응답 본문의 인용\x1b[0m\r\nREADY-END');
  assert.equal(out.judge, out.plain);
  assert.equal(out.view, out.plain);
  assert.equal(out.captured, out.plain);
  assert.equal(readStatusLine(out.judge).kind, 'unknown');
  const observations = new Map([['kadan-fixture', {
    role: 'fixture', alive: true, screen: out.judge, digest: out.judge,
  }]]);
  const options = { elapsedMs: 240_000, intervalMs: 240_000, afterMs: 240_000,
    tasks: [{ role: 'fixture', t: '2026-10-19T00:00:00Z' }] };
  const first = assessIdleStop(new Map(), observations, options);
  assert.equal(assessIdleStop(first.states, observations, options).alerts.length, 0);
});

test('F2: 배경색 뒤 공백·탭·넓은 공백·NBSP의 -p 바이트와 변화 지문 보존', async t => {
  const out = await fixedScreen('spaces', [
    '\x1b[48;5;22m배경색 뒤 공백     \x1b[0m',
    '탭\t', '중간\t탭', '한글 😀 全角\u3000', 'NBSP\u00a0',
    '\x1b[48;5;22m색 NBSP\u00a0   \x1b[0m',
    '\x1b[48;5;22m     \x1b[0m', 'READY-END',
  ].join('\r\n'));
  t.diagnostic(JSON.stringify({ plain: out.plain.trimEnd(), ansi: out.ansi.trimEnd() }));
  assert.equal(out.judge, out.plain);
  assert.equal(out.view, out.plain);
  assert.equal(changeDigest(out.judge), changeDigest(out.plain));
  assert.ok(out.plain.includes('NBSP\u00a0\n'));
  assert.ok(out.plain.includes('全角\u3000\n'));
});

test('F3: 확장 밑줄·색·하이퍼링크·문자 집합의 -p 바이트와 DONE 보존', async t => {
  const E = '\x1b';
  const out = await fixedScreen('formats', [
    `${E}[4:3mKADAN:DONE styled-fixture ok${E}[0m`,
    `${E}[4:2m이중 밑줄${E}[0m ${E}[4:5m점선${E}[0m`,
    `${E}[38:2::2:20:30m콜론 RGB${E}[0m`,
    `${E}[38;2;2;20;30m세미콜론 RGB${E}[0m`,
    `${E}[58:2::2:20:30m${E}[4m밑줄 색${E}[0m`,
    `${E}]8;;https://example.com/${E}\\링크${E}]8;;${E}\\`,
    `${E}]8;;https://example.com/\x07BEL 링크${E}]8;;\x07`,
    `${E}(0lqqk${E}(B`, `${E}[1;2;3;4;5;7;8;9m서식 모음${E}[0m`, 'READY-END',
  ].join('\r\n'));
  t.diagnostic(JSON.stringify({ plain: out.plain.trimEnd(), ansi: out.ansi.trimEnd() }));
  assert.equal(out.judge, out.plain);
  assert.equal(out.view, out.plain);
  assert.deepEqual(findDoneMarkers(out.judge), findDoneMarkers(out.plain));
  assert.equal(findDoneMarkers(out.judge).length, 1);
});

test('한글·이모지·자동 줄바꿈·표·박스·본문 흐림은 입력칸 밖에서 바이트 보존', async () => {
  const out = await fixedScreen('wide', [
    '한글 😀 全角\t탭', '┌──────┬──────┐', '│ 이름 │ 수량 │', '└──────┴──────┘',
    '\\literal [2m text', '긴 줄 '.repeat(30), '\x1b[2m› 흐린 본문 인용\x1b[0m',
    '────────────────────', '❯ \x1b[2mhint\x1b[m실제 글\x1b[2mtail\x1b[0m',
    '────────────────────', '  Haiku 5.5 | effort:low',
  ].join('\r\n'), 'effort:low', 64);
  assert.equal(out.judge, out.plain.replace('❯ hint실제 글tail', '❯ 실제 글'));
  assert.equal(out.view, out.plain.replace('hint실제 글tail', '(추천 문구: hint)실제 글(추천 문구: tail)'));
});

test('#180 codex 두 줄 바닥글: 본문 인용 보존, 입력칸만 추천 표시', async () => {
  const out = await fixedScreen('codex-footer', [
    '\x1b[2m› 흐린 본문 인용\x1b[0m', '',
    '› \x1b[2mAsk Codex to do anything\x1b[0m', '',
    '  gpt-6.1-sol high · ~/Dev/example · Context 32% used',
    '  ← for agents · ? for shortcuts     ⚠ 1 warning · f2 to view',
  ].join('\r\n'), '? for shortcuts');
  assert.equal(out.judge, out.plain.replace('› Ask Codex to do anything', '›'));
  assert.equal(out.view, out.plain.replace('Ask Codex to do anything',
    '(추천 문구: Ask Codex to do anything)'));
});

test('여러 줄 실제 입력·추천은 모양이 불확실하면 전체 보존한다', async () => {
  for (const text of ['첫째 줄 실제 입력\r\n  > 둘째 줄 실제 입력',
    '\x1b[2m첫째 줄 추천\r\n  둘째 줄 추천\x1b[0m']) {
    const out = await fixedScreen('multiline', `› ${text}\r\nREADY-END`);
    assert.equal(out.judge, out.plain);
    assert.equal(out.view, out.plain);
  }
});
