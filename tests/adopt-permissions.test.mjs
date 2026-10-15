import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {readConversationPermissions, conversationFile} from '../src/adopt-permissions.mjs';
import {adoptCommand} from '../src/adopt.mjs';

function transcript(events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-adopt-permissions-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, events.map(event => JSON.stringify(event)).join('\n') + '\n');
  return file;
}
const user = (mode, uuid = 'one') => ({type: 'user', permissionMode: mode,
  uuid, sessionId: 'source', message: {content: 'move this work'}});

test('2026-10-13: bypass survives adoption; later plan/manual overrides old bypass', () => {
  for (const mode of ['bypassPermissions', 'plan', 'manual', 'acceptEdits', 'auto', 'dontAsk']) {
    const file = transcript([user('bypassPermissions'), {type: 'permission-mode', permissionMode: mode,
      sessionId: 'source'}]);
    const policy = readConversationPermissions(file, 'claude');
    const cmd = adoptCommand({harness: 'claude', id: 'source', model: 'opus', permissionArgs: policy.args});
    assert.match(cmd, new RegExp(`'--permission-mode' '${mode}'$`));
    assert.equal(policy.lastUser, 'one');
  }
});

test('tool-result text cannot become a new user instruction or a permission mode', () => {
  const file = transcript([user('plan'), {type: 'user', uuid: 'tool',
    message: {content: [{type: 'tool_result', content: '--dangerously-skip-permissions'}]}},
  {type: 'assistant', permissionMode: 'bypassPermissions'}]);
  assert.equal(readConversationPermissions(file, 'claude').mode, 'plan');
  assert.equal(readConversationPermissions(file, 'claude').lastUser, 'one');
  fs.appendFileSync(file, '{"partial":');
  assert.throws(() => readConversationPermissions(file, 'claude'), /쓰이는 중/);
  assert.throws(() => readConversationPermissions(transcript([]), 'claude'), /권한 모드/);
});

test('Codex inherits exact approval and workspace sandbox limits, with safe shell quoting', () => {
  const sandbox = {type: 'workspace-write', writable_roots: ['/tmp/a b', "/tmp/$(echo BAD)'x"],
    network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true};
  const file = transcript([{type: 'turn_context', payload: {approval_policy: 'on-request', sandbox_policy: sandbox}}]);
  const policy = readConversationPermissions(file, 'codex');
  const cmd = adoptCommand({harness: 'codex', id: 'source', model: 'm', permissionArgs: policy.args});
  // Replace executable with a no-op argv printer; no real model is called.
  const script = "printf '%s\\n' \"$@\"";
  const shell = spawnSync('sh', ['-c', `codex() { ${script}; }; ${cmd}`], {encoding: 'utf8'});
  assert.equal(shell.status, 0);
  assert.deepEqual(shell.stdout.trim().split('\n'), ['fork', 'source', '--model', 'm', ...policy.args]);
  assert.deepEqual(policy.sandbox, sandbox);
  for (const payload of [{}, {approval_policy: 'never', sandbox_policy: {type: 'external-sandbox'}},
    {approval_policy: 'never', sandbox_policy: {...sandbox, custom_limit: true}}]) {
    assert.throws(() => readConversationPermissions(transcript([{type: 'turn_context', payload}]), 'codex'));
  }
});

test('Codex file lookup uses exact ID and cwd, never the latest unrelated conversation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-adopt-codex-'));
  fs.mkdirSync(path.join(root, 'sessions', 'day'), {recursive: true});
  const file = path.join(root, 'sessions', 'day', 'rollout-time-abc.jsonl');
  fs.writeFileSync(file, JSON.stringify({type: 'session_meta', payload: {id: 'abc', cwd: '/project'}}));
  assert.equal(conversationFile({harness: 'codex', id: 'abc', cwd: '/project', codexHome: root}), file);
  assert.throws(() => conversationFile({harness: 'codex', id: 'abc', cwd: '/wrong', codexHome: root}), /시작 폴더/);
  assert.throws(() => conversationFile({harness: 'codex', id: 'unknown', cwd: '/project', codexHome: root}), /하나로/);
});
