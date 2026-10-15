import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {conversationMetas, recoveryLine} from '../scripts/recover-sessions.mjs';
import {commandWords, inspectCardSendIdentity} from '../src/ai-identity.mjs';
import {conversationOf} from '../src/conversation-ref.mjs';

const id = '00000000-0000-4000-8000-000000000001';

test('대화 파일의 현재 id와 이전 session_id 형식에서 복구 주소를 읽는다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-recover-meta-'));
  for (const key of ['id', 'session_id']) fs.writeFileSync(path.join(root, `${key}.jsonl`),
    JSON.stringify({type: 'session_meta', payload: {[key]: id, cwd: root, timestamp: '2026-01-01'}}) + '\n');
  assert.deepEqual(conversationMetas(root).map(({id: value, cwd}) => [value, cwd]), [[id, root], [id, root]]);
});

function shellFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-recover-script-'));
  const cwd = path.join(root, "space $(touch cwd-marker) `touch backtick-marker` ' quoted");
  fs.mkdirSync(cwd);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  // 실행기·카단은 인자를 출력하는 모의 프로그램뿐이다. 외부 모델이나 세션을 띄우지 않는다.
  for (const name of ['kadan', 'codex']) fs.writeFileSync(path.join(bin, name),
    `#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));\n`,
    {mode: 0o700});
  const run = command => {
    const result = spawnSync('/bin/sh', ['-c', command], {
      cwd: root, env: {...process.env, PATH: `${bin}:${process.env.PATH}`}, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  t.after(() => {
    const markers = ['cwd-marker', 'backtick-marker', 'role-marker', 'cmd-marker'];
    for (const dir of [root, cwd]) for (const marker of markers) {
      assert.equal(fs.existsSync(path.join(dir, marker)), false);
    }
  });
  return {cwd, run};
}

for (const form of ['new', 'resume-first', 'resume-last']) {
  test(`복구 안내 ${form}: 모델·강도·권한 옵션과 셸 인자 경계 보존`, t => {
    const f = shellFixture(t);
    const options = `--model fixture-model -p fixture-profile -c 'model_reasoning_effort="high"' ` +
      `--dangerously-bypass-approvals-and-sandbox -c 'note="$(touch cmd-marker)"'`;
    const cmd = form === 'new' ? `codex ${options}` : form === 'resume-first'
      ? `codex resume ${id} ${options}` : `codex ${options} resume ${id}`;
    const role = "role ' $(touch role-marker)";
    const outer = f.run(recoveryLine({role, cwd: f.cwd, cmd, id}));
    assert.equal(outer.cwd, fs.realpathSync(f.cwd));
    assert.deepEqual(outer.args.slice(0, 3), ['start', role, '--cmd']);
    const recovered = outer.args[3];
    const identity = inspectCardSendIdentity({session: 'kadan-test', currentPid: '1', entries: [
      {kind: 'start', session: 'kadan-test', panePid: '1', cmd: recovered},
    ]});
    assert.equal(identity.ok, true);
    assert.equal(identity.model, 'fixture-model');
    assert.deepEqual(conversationOf(recovered), {conversationMode: 'resume', conversationRef: id});
    const actual = f.run(recovered).args;
    const expected = commandWords(cmd).slice(1);
    assert.deepEqual(actual, form === 'new' ? [...expected, 'resume', id] : expected);
  });
}

test('모델·명령을 모르거나 다른 대화인 경우 실행 가능한 복구 안내를 만들지 않는다', () => {
  for (const cmd of ['codex', 'codex --model x; echo other', `codex fork ${id} --model x`,
    'codex resume other --model x', 'claude --model x']) {
    assert.throws(() => recoveryLine({role: 'test', cwd: '.', cmd, id}));
  }
});
