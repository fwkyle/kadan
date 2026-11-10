// Why: kadan status가 살아 있는 세션마다 원장 전체를 두 번씩 읽어, 세션 38개면 약 76번 읽고 부하가 높을 때 75~100초 걸렸다.
// 원장은 세션 수와 상관없이 한 번만 읽고, 출력은 글자 하나까지 그대로여야 한다(2026-11-10).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const child = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers/status-ledger-reads-child.mjs');

function run(floorName, extra) {
  const out = spawnSync(process.execPath, [child, floorName, String(extra)], {encoding: 'utf8', timeout: 60_000});
  assert.equal(out.status, 0, out.stderr);
  const result = JSON.parse(out.stdout.trim().split('\n').at(-1));
  assert.equal(result.outcome, 'ok');
  return result;
}

for (const extra of [0, 6, 34]) {
  test(`세션 ${4 + extra}개: kadan status 한 번의 원장 읽기는 1회다`, () => {
    const result = run('tmux', extra);
    assert.equal(result.sessions, 4 + extra);
    assert.equal(result.lines.length, 4 + extra);
    assert.equal(result.reads, 1);
  });
}

test('tmux 꼴 출력: PID일치·PID변경·기록없음과 실행기·모델·계열 표시가 그대로다', () => {
  assert.deepEqual(run('tmux', 1).lines, [
    'kadan-옛  백그라운드  시작=2023-11-14T22:13:20.000Z  PID일치  모름 · 모름 · 모름',
    'kadan-일치  창붙음  시작=2023-11-14T22:13:21.000Z  PID일치  claude · opus · claude',
    'kadan-변경  백그라운드  시작=2023-11-14T22:13:22.000Z  PID변경(31→32)  kimi · 모름 · 모름',
    'kadan-없음  창붙음  시작=2023-11-14T22:13:23.000Z  기록없음  모름 · 모름 · 모름',
    'kadan-덤0  백그라운드  시작=2023-11-14T22:13:24.000Z  PID일치  모름 · sonnet · claude',
  ]);
});

test('herdr 꼴 출력도 그대로다', () => {
  assert.deepEqual(run('herdr', 0).lines, [
    'kadan-옛  herdr=term-0  상태=idle  PID일치  모름 · 모름 · 모름',
    'kadan-일치  herdr=term-1  상태=idle  PID일치  claude · opus · claude',
    'kadan-변경  herdr=term-2  상태=idle  PID변경(31→32)  kimi · 모름 · 모름',
    'kadan-없음  herdr=term-3  상태=idle  기록없음  모름 · 모름 · 모름',
  ]);
});

test('세션별 마지막 시작: start·stop·window만 읽은 것과 원장 전체를 읽은 것이 같다(옛 원장 영역·재시작 포함)', () => {
  const {picks} = run('tmux', 3);
  for (const pick of picks) assert.deepEqual(pick.narrow, pick.full, pick.session);
  const by = Object.fromEntries(picks.map(pick => [pick.session, pick.full]));
  assert.equal(by['kadan-옛'].panePid, '10'); // 옛 원장 영역에만 있는 시작
  assert.equal(by['kadan-일치'].panePid, '21'); // 옛 영역 시작 뒤 새 영역에서 두 번 다시 시작 — 가장 나중이 이긴다
  assert.equal(by['kadan-변경'].rottiePid, '31');
  assert.equal(by['kadan-없음'], null);
});
