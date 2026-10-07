import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adoptCommand, adoptPrompt, detectConversation, findClaudeTranscript, runAdopt } from '../src/adopt.mjs';
import { inspectCardSendIdentity } from '../src/ai-identity.mjs';

test('실행기별 복제 이어 열기 명령: 모델은 필수이고 카드 전송 신원 확인을 통과한다', () => {
  const claude = adoptCommand({ harness: 'claude', id: 'e74e6592-6339-4e1f-8611-cbd7b3dcada0', model: 'opus', effort: 'high' });
  assert.equal(claude, 'claude --resume e74e6592-6339-4e1f-8611-cbd7b3dcada0 --fork-session --model opus --effort high');
  const codex = adoptCommand({ harness: 'codex', id: '019a-uuid', model: 'gpt-6-astra', effort: 'high' });
  assert.equal(codex, 'codex fork 019a-uuid --model gpt-6-astra -c model_reasoning_effort=high');
  for (const cmd of [claude, codex]) {
    const identity = inspectCardSendIdentity({ entries: [{ kind: 'start', session: 'kadan-r', panePid: '1', cmd }], session: 'kadan-r', currentPid: '1' });
    assert.equal(identity.ok, true, cmd);
  }
  const big = adoptCommand({ harness: 'claude', id: 'abc', model: 'claude-opus-5-5[1m]' });
  assert.equal(big, "claude --resume abc --fork-session --model 'claude-opus-5-5[1m]'", '큰 문맥 모델은 따옴표로 감싼다');
  assert.equal(inspectCardSendIdentity({ entries: [{ kind: 'start', session: 'kadan-r', panePid: '1', cmd: big }], session: 'kadan-r', currentPid: '1' }).model, 'claude-opus-5-5[1m]');
  assert.throws(() => adoptCommand({ harness: 'claude', id: 'x', model: "m'; echo" }), /--model/);
  assert.throws(() => adoptCommand({ harness: 'claude', id: 'x' }), /--model이 필요하다/);
  assert.throws(() => adoptCommand({ harness: 'claude', id: 'x; rm -rf ~', model: 'opus' }), /대화 ID/);
  assert.throws(() => adoptCommand({ harness: 'gemini', id: 'x', model: 'm' }), /--harness/);
  assert.throws(() => adoptCommand({ harness: 'claude', id: 'x', model: 'm', effort: 'high; echo' }), /--effort/);
});

test('지금 대화 ID는 Claude Code가 넘겨준 값에서 읽고, 모르면 null', () => {
  assert.deepEqual(detectConversation({ CLAUDE_CODE_SESSION_ID: 'abc-1' }), { harness: 'claude', id: 'abc-1' });
  assert.deepEqual(detectConversation({ CLAUDE_CODE_SESSION_ID: 'abc-1', CLAUDE_EFFORT: 'high' }), { harness: 'claude', id: 'abc-1', effort: 'high' }, '지금 강도를 이어받는다');
  assert.deepEqual(detectConversation({ CLAUDE_CODE_SESSION_ID: 'abc-1', CLAUDE_EFFORT: 'x y' }), { harness: 'claude', id: 'abc-1' });
  assert.equal(detectConversation({}), null);
});

function fakes({ alive = false, screen = '› ' } = {}) {
  const calls = { start: [], send: [], log: [] };
  return {
    calls,
    deps: {
      floor: { alive: () => alive, read: () => screen },
      sessionName: (role) => 'kadan-' + role,
      start: (argv, flags) => calls.start.push({ argv, flags }),
      send: (m) => calls.send.push(m),
      log: (line) => calls.log.push(line),
      sleep: () => {},
      findTranscript: () => ({ ok: true }),
    },
  };
}

test('adopt: 감독 프로필·상위 @user·이유를 붙여 start하고, 화면이 뜨면 첫 안내를 보낸다', () => {
  const { calls, deps } = fakes();
  const out = runAdopt({ role: '감독-버튼', flags: { model: 'opus' }, env: { CLAUDE_CODE_SESSION_ID: 'abc-1', CLAUDE_EFFORT: 'high' }, ...deps });
  assert.equal(calls.start.length, 1);
  assert.deepEqual(calls.start[0].argv, ['감독-버튼']);
  assert.deepEqual(calls.start[0].flags, { cmd: 'claude --resume abc-1 --fork-session --model opus --effort high', profile: 'conductor', parent: '@user', hidden: false, reason: '대화 옮기기(adopt): claude abc-1' });
  assert.equal(out.prompt, 'sent');
  assert.equal(calls.send[0].message, adoptPrompt('감독-버튼', '@user'));
  assert.doesNotMatch(calls.send[0].message, /KADAN:DONE/, '완성된 완료 마커를 지문에 쓰지 않는다');
  assert.ok(calls.log.some((l) => l.includes('원래 대화에서는 이제 지시하지 마세요')));
});

test('adopt: 직접 준 대화 ID·실행기·상위·슈퍼감독 프로필, 첫 안내 생략', () => {
  const { calls, deps } = fakes();
  const out = runAdopt({ role: 'shop-슈퍼', flags: { model: 'gpt-6-astra', resume: '019a', harness: 'codex', parent: '비서', profile: 'super', 'no-prompt': true, hidden: true }, env: {}, ...deps });
  assert.equal(calls.start[0].flags.cmd, 'codex fork 019a --model gpt-6-astra');
  assert.equal(calls.start[0].flags.parent, '비서');
  assert.equal(calls.start[0].flags.profile, 'super');
  assert.equal(calls.start[0].flags.hidden, true);
  assert.equal(out.prompt, 'skipped');
  assert.equal(calls.send.length, 0);
  assert.match(adoptPrompt('shop-슈퍼', '@user', 'super'), /슈퍼감독 'shop-슈퍼'.*kadan-super 스킬/);
  assert.match(adoptPrompt('감독', '@user'), /kadan-conductor 스킬/);
});

test('Claude 대화 기록은 시작 폴더 이름으로 찾고, 다른 폴더면 어디서 시작했는지 알려 주며 거부한다', () => {
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-adopt-home-'));
  const dir = path.join(userHome, '.claude', 'projects', '-home-someone-dev-my-app');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'abc-1.jsonl'), '');
  assert.deepEqual(findClaudeTranscript({ id: 'abc-1', cwd: '/home/someone/dev/my_app', userHome }), { ok: true }, "'_'도 '-'로 바뀐다");
  assert.deepEqual(findClaudeTranscript({ id: 'abc-1', cwd: '/home/someone/dev/other', userHome }), { ok: false, elsewhere: '-home-someone-dev-my-app' });
  assert.deepEqual(findClaudeTranscript({ id: 'zzz', cwd: '/home/someone/dev/my_app', userHome }), { ok: false, elsewhere: null });
  for (const [found, pattern] of [[{ ok: false, elsewhere: '-home-x' }, /이 폴더에서 시작한 대화가 아니다\(기록 폴더 -home-x\)/], [{ ok: false, elsewhere: null }, /대화 기록을 찾지 못했다/]]) {
    const { calls, deps } = fakes();
    deps.findTranscript = () => found;
    assert.throws(() => runAdopt({ role: 'a', flags: { model: 'm' }, env: { CLAUDE_CODE_SESSION_ID: 'x' }, ...deps }), pattern);
    assert.equal(calls.start.length, 0, '기록이 없으면 창도 관계표도 건드리지 않는다');
  }
});

test('adopt 거부: 대화를 모름·이미 살아 있는 이름·작업자 프로필·모델 없음 — 아무것도 띄우지 않는다', () => {
  for (const [args, pattern] of [
    [{ role: 'a', flags: { model: 'm' }, env: {} }, /옮길 대화를 모른다/],
    [{ role: 'a', flags: { model: 'm', profile: 'worker' }, env: { CLAUDE_CODE_SESSION_ID: 'x' } }, /--profile/],
    [{ role: 'a', flags: {}, env: { CLAUDE_CODE_SESSION_ID: 'x' } }, /--model이 필요하다/],
    [{ role: 'a b', flags: { model: 'm' }, env: { CLAUDE_CODE_SESSION_ID: 'x' } }, /사용법/],
  ]) {
    const { calls, deps } = fakes();
    assert.throws(() => runAdopt({ ...args, ...deps }), pattern);
    assert.equal(calls.start.length, 0);
  }
  const { calls, deps } = fakes({ alive: true });
  assert.throws(() => runAdopt({ role: 'a', flags: { model: 'm' }, env: { CLAUDE_CODE_SESSION_ID: 'x' }, ...deps }), /이미 살아 있음/);
  assert.equal(calls.start.length, 0);
});

test('adopt: 화면이 끝내 안 뜨면 첫 안내를 보내지 않고 알린다', () => {
  let n = 0;
  const { calls, deps } = fakes();
  deps.floor.read = () => 'frame ' + n++;
  const out = runAdopt({ role: 'a', flags: { model: 'm' }, env: { CLAUDE_CODE_SESSION_ID: 'x' }, ...deps });
  assert.equal(out.prompt, 'not-ready');
  assert.equal(calls.send.length, 0);
  assert.ok(calls.log.some((l) => l.includes('첫 안내를 보내지 않았습니다')));
});
