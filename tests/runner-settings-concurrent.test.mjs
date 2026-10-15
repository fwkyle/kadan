import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {readSettings, setFallback} from '../src/runner-settings.mjs';

async function until(check) {
  const end = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < end, '자식 프로세스의 읽기 또는 잠금 대기 신호');
    await delay(10);
  }
}

test('프로세스 간 설정 저장은 한 번만 성공하고 충돌한 변경은 최신 revision으로 다시 저장한다', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-settings-concurrent-'));
  const file = path.join(home, 'runner-settings.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1, revision: 1, activePreset: 'default',
    runners: {demo: {spawn: 'demo --model {model}', models: [{model: 'a'}, {model: 'b'}]}},
    presets: {default: {roles: {worker: {runner: 'demo', model: 'a'}}}}, blocked: [],
  }));
  const run = writer => {
    const script = fileURLToPath(new URL('./helpers/runner-settings-writer.mjs', import.meta.url));
    const child = spawn(process.execPath, [script, home, writer]);
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let output = '';
    child.stdout.on('data', data => output += data);
    child.stderr.on('data', data => output += data);
    return new Promise(resolve => child.on('close', code => resolve({code, output})));
  };
  const first = run('a');
  await until(() => fs.existsSync(path.join(home, 'a-read')));
  const second = run('b');
  await until(() => ['b-read', 'b-waiting'].some(name => fs.existsSync(path.join(home, name))));
  fs.writeFileSync(path.join(home, 'release'), 'release');
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.code, 0, a.output);
  assert.equal(b.code, 1, b.output);
  assert.match(b.output, /설정이 바뀌었다/);
  assert.equal(fs.existsSync(path.join(home, 'event-b.json')), false, '거부된 저장의 성공 기록 없음');
  const saved = readSettings(home);
  assert.equal(saved.revision, 2);
  assert.deepEqual(saved.favorites, [{runner: 'demo', model: 'a'}]);
  const meta = {revision: 2, by: 'b', reason: '최신 설정으로 저장', record: () => {}};
  assert.throws(() => setFallback(home, {...meta, role: 'worker', items: [{runner: 'demo', model: 'missing'}]}));
  const next = setFallback(home, {...meta, role: 'worker', items: [{runner: 'demo', model: 'b'}]});
  assert.equal(next.revision, 3);
  assert.deepEqual(next.favorites, saved.favorites);
  assert.deepEqual(next.presets.default.fallback.worker, [{runner: 'demo', model: 'b'}]);
});
