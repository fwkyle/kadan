// Real child processes and the production acceptance/close path, with a fake Rottie CLI.
// Never starts a model or touches an existing terminal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork, spawn} from 'node:child_process';
import {once} from 'node:events';
import {stopChild} from './helpers/child-cleanup.mjs';
import {prepareTransfer, transferStatus} from '../src/adopt-transfer.mjs';
import {processIdentity} from '../src/adopt-process.mjs';
import {readConversationPermissions} from '../src/adopt-permissions.mjs';

const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value) + '\n');

test('real receiver process acknowledges; only the captured fake Rottie source process is closed',
  {timeout: 20000}, async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-adopt-roundtrip-'));
    const source = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
    t.after(() => stopChild(source));
    const original = path.join(home, 'original.jsonl');
    const current = path.join(home, 'current.jsonl');
    const event = id => ({type: 'user', sessionId: id, uuid: 'message',
      permissionMode: 'bypassPermissions', message: {content: 'Continue the approved local fix.'}});
    save(original, event('original'));
    save(current, event('receiver'));
    const stateFile = path.join(home, 'rottie.json');
    save(stateFile, {closed: 0, removed: 0});
    const fakeRottie = path.join(home, 'rottie');
    fs.writeFileSync(fakeRottie, `#!${process.execPath}
const fs = require('node:fs');
const file = ${JSON.stringify(stateFile)};
const state = JSON.parse(fs.readFileSync(file));
const action = process.argv[3];
if (process.argv[5] !== 'original-tab') process.exit(2);
if (action === 'close') { state.closed++; process.kill(${source.pid}, 'SIGTERM'); }
if (action === 'remove') state.removed++;
fs.writeFileSync(file, JSON.stringify(state));
console.log(JSON.stringify({ok:true, runtime:{bundleId:'test.app',build:'test'},
 result:{terminal:{id:'original-tab',pid:${source.pid},state:'running'}}}));
`, {mode: 0o700});
    const receiverFile = path.join(home, 'receiver.mjs');
    const transferModule = new URL('../src/adopt-transfer.mjs', import.meta.url).href;
    fs.writeFileSync(receiverFile, `
import {acceptTransfer} from ${JSON.stringify(transferModule)};
process.on('message', ({id}) => {
  try {
    const result = acceptTransfer({home:${JSON.stringify(home)}, id,
      flags:{summary:'Continue the approved local fix and run its tests.'},
      floor:{alive:()=>true,pid:()=>String(process.pid)},
      locate:()=>${JSON.stringify(current)}});
    process.send({result}, () => process.exit(0));
  } catch (error) { process.send({error:error.message}, () => process.exit(1)); }
});
process.send({ready:true});
`);
    const receiver = fork(receiverFile, [], {stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {...process.env, KADAN_HOME: home, KADAN_ROLE: 'new', CLAUDE_CODE_SESSION_ID: 'receiver'}});
    t.after(() => stopChild(receiver));
    const [ready] = await once(receiver, 'message');
    assert.equal(ready.ready, true);
    const originalProcess = processIdentity(source.pid);
    const transfer = prepareTransfer({home, role: 'new', session: 'kadan-new',
      conversation: {harness: 'claude', id: 'original', file: original, cwd: home},
      permissions: readConversationPermissions(original, 'claude'),
      source: {terminalId: 'original-tab', bin: fakeRottie,
        runtime: {bundleId: 'test.app', build: 'test'}, shell: originalProcess, ai: originalProcess},
      floor: {alive: () => true, pid: () => String(receiver.pid)}});
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile)), {closed: 0, removed: 0});
    assert.equal(transferStatus(home, transfer.id).status, 'awaiting-acceptance');
    const reply = once(receiver, 'message');
    receiver.send({id: transfer.id});
    const [message] = await reply;
    assert.equal(message.error, undefined);
    assert.equal(message.result.source, 'removed');
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile)), {closed: 1, removed: 1});
    assert.equal(transferStatus(home, transfer.id).source, 'removed');
  });
