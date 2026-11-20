// Why: 복구할 대화가 확정되지 않으면 실제 main 출력에도 실행 가능한 명령이 없어야 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

const id = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const script = new URL('../scripts/recover-sessions.mjs', import.meta.url).pathname;
const options = '--model fixture-model -c \'model_reasoning_effort="high"\' ' +
  '--dangerously-bypass-approvals-and-sandbox';

function runMain(t, cmd, refs, extraArgs = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-recover-ambiguity-'));
  const home = path.join(root, 'home');
  const kadan = path.join(root, 'kadan');
  const sessions = path.join(home, '.codex', 'sessions');
  const bin = path.join(root, 'bin');
  for (const dir of [sessions, kadan, bin]) fs.mkdirSync(dir, {recursive: true});
  // 실제 SQLite 입력이며 기본 DELETE journal을 쓴다. 운영 원장·tmux는 접근하지 않는다.
  const db = new DatabaseSync(path.join(kadan, 'kadan.sqlite'));
  try {
    db.exec('CREATE TABLE events (payload TEXT NOT NULL)');
    db.prepare('INSERT INTO events (payload) VALUES (?)').run(JSON.stringify({
      kind: 'start', role: 'fixture-worker', cwd: home, cmd, t: '2026-10-15T00:00:00Z',
    }));
  } finally {
    db.close();
  }
  for (const [index, ref] of refs.entries()) {
    fs.writeFileSync(path.join(sessions, `${index}.jsonl`), JSON.stringify({
      type: 'session_meta',
      payload: {id: ref, cwd: home, timestamp: '2026-10-15T00:00:01Z'},
    }) + '\n');
  }
  const trace = path.join(root, 'tmux-calls.jsonl');
  fs.writeFileSync(path.join(bin, 'tmux'), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(1);
`, {mode: 0o700});
  const result = spawnSync(process.execPath, [script, ...extraArgs], {
    cwd: root,
    env: {
      ...process.env, HOME: home, KADAN_HOME: kadan, KADAN_LITE_HOME: kadan,
      KADAN_WINDOW: 'none', KADAN_NOTIFY: 'off', PATH: `${bin}:${process.env.PATH}`,
    },
    encoding: 'utf8', timeout: 10000,
  });
  fs.writeFileSync(path.join(root, 'main.log'), result.stdout + result.stderr);
  t.diagnostic(`보존 자료: ${root}\n${result.stdout}${result.stderr}`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse), [
    ['-u', '-L', 'kadan', 'ls', '-F', '#{session_name}'],
  ]);
  return result.stdout;
}

const heldCases = [
  ['후보 없음', `codex ${options}`, []],
  ['복수 후보', `codex ${options}`, [id, otherId]],
  ['resume --last', `codex resume --last ${options}`, []],
  ['resume --last와 유일 후보', `codex resume --last ${options}`, [id]],
  ['주소 없는 resume', `codex resume ${options}`, []],
  ['주소 없는 fork', `codex fork ${options}`, []],
  ['명시 fork', `codex fork ${id} ${options}`, [id]],
  ['잘못된 명시 ID', `codex resume unknown ${options}`, []],
  ['ID 없는 유일 메타', `codex ${options}`, [null]],
  ['잘못된 유일 후보 ID', `codex ${options}`, ['------------------------------------']],
];

for (const [name, cmd, refs] of heldCases) {
  test(`main ${name}: 복구 명령 보류`, t => {
    const output = runMain(t, cmd, refs);
    assert.doesNotMatch(output, /복구>/);
    assert.doesNotMatch(output, /기억 없이 새로/);
    assert.match(output, /복구 명령 보류:/);
    assert.match(output, /되살릴 수 있음 0/);
    if (refs.length > 1) assert.match(output, /후보 2개 — 사람이 골라야 함/);
  });
}

for (const [name, cmd, refs] of [
  ['명시 ID', `codex resume ${id} ${options}`, [id, otherId]],
  ['유일 후보', `codex ${options}`, [id]],
]) {
  test(`main ${name}: 같은 대화의 복구 명령 제시(--show-commands)`, t => {
    const output = runMain(t, cmd, refs, ['--show-commands']);
    assert.equal(output.match(/복구>/g)?.length, 1);
    assert.match(output, new RegExp(id));
    assert.match(output, /--model fixture-model/);
    assert.match(output, /model_reasoning_effort="high"/);
    assert.match(output, /--dangerously-bypass-approvals-and-sandbox/);
    assert.match(output, /되살릴 수 있음 1/);
    assert.doesNotMatch(output, /복구 명령 보류:|기억 없이 새로/);
  });
}

// 시작 명령 원문에는 토큰·프롬프트가 실릴 수 있다(#435 후속). 기본 출력은 요약뿐이고 원문은 --show-commands 뒤에만 나온다.
// 시험의 비밀은 모두 가짜 값이다: 환경변수 앞머리, `-c api_key="…"`, `--` 뒤 프롬프트.
const SECRETS = ['가짜토큰값', '가짜키값', '가짜프롬프트값'];
const secretCmd = `TOKEN=${SECRETS[0]} codex ${options} -c api_key="${SECRETS[1]}"`;
const secretPromptCmd = `${secretCmd} -- ${SECRETS[2]}`;

for (const [name, cmd] of [['복구 가능한 명령', secretCmd], ['프롬프트가 붙어 보류되는 명령', secretPromptCmd]]) {
  test(`main 기본 출력: ${name}의 비밀 값 0건, 요약과 --show-commands 안내만`, t => {
    const output = runMain(t, cmd, [id]);
    for (const secret of SECRETS) assert.equal(output.includes(secret), false, `${secret} 노출\n${output}`);
    assert.doesNotMatch(output, /복구>|^ {4}원래 /m);
    assert.match(output, /실행기 codex · 모델 fixture-model · 강도 high/);
    assert.match(output, /옵션 이름 .*-c api_key/);
    assert.match(output, /--show-commands/);
  });
}

test('main --show-commands: 이 옵션을 줬을 때만 원문(원래 명령·복구 줄)이 나온다', t => {
  const output = runMain(t, secretCmd, [id], ['--show-commands']);
  assert.match(output, new RegExp(`원래 TOKEN=${SECRETS[0]} codex`));
  assert.equal(output.match(/복구>/g)?.length, 1);
  assert.match(output, new RegExp(SECRETS[1]));
});
