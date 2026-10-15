import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {appendLedger} from '../src/ledger.mjs';
import {rottieFloor} from '../src/floor-rottie.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-rottie-list-'));
  const bin = path.join(home, 'rottie.mjs');
  const calls = path.join(home, 'calls.jsonl');
  const config = path.join(home, 'responses.json');
  fs.writeFileSync(config, '{}');
  fs.writeFileSync(bin, `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2), id = args[args.indexOf('--terminal') + 1];
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(id) + '\\n');
const responses = JSON.parse(fs.readFileSync(${JSON.stringify(config)}, 'utf8'));
const code = responses[id];
if (code === 'invalid-json') console.log('broken');
else if (code) {
  console.log(JSON.stringify({ok:false,error:{code,message:'fixture error',effect:'none'}}));
  process.exitCode = 1;
} else console.log(JSON.stringify({ok:true,result:{terminal:{id,pid:123,state:'running'}}}));
`, {mode: 0o700});
  const before = {KADAN_HOME: process.env.KADAN_HOME, KADAN_ROTTIE_BIN: process.env.KADAN_ROTTIE_BIN};
  process.env.KADAN_HOME = home;
  process.env.KADAN_ROTTIE_BIN = bin;
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const start = (role, id = role, floor = 'rottie') => appendLedger({
    kind: 'start', role, session: `kadan-${role}`, floor, rottieTerminalId: id, rottiePid: '123',
  }, home);
  return {home, config, start, calls: () => fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse)};
}

test('종료된 세대·바닥이 바뀐 세대·사라진 개별 터미널을 제외하고 살아 있는 목록을 반환한다', t => {
  const f = fixture(t);
  f.start('stopped');
  appendLedger({kind: 'stop', role: 'stopped', session: 'kadan-stopped'}, f.home);
  f.start('changed');
  f.start('changed', 'new-tmux', 'tmux');
  f.start('missing');
  f.start('restarted', 'old');
  appendLedger({kind: 'stop', role: 'restarted', session: 'kadan-restarted'}, f.home);
  f.start('restarted', 'new');
  f.start('live');
  fs.writeFileSync(f.config, JSON.stringify({
    stopped: 'ROTTIE_TERMINAL_NOT_FOUND', changed: 'ROTTIE_TERMINAL_NOT_FOUND',
    missing: 'ROTTIE_TERMINAL_NOT_FOUND', old: 'ROTTIE_TERMINAL_NOT_FOUND',
  }));
  assert.deepEqual(rottieFloor.list().map(row => [row.session, row.terminalId, row.alive]), [
    ['kadan-restarted', 'new', true], ['kadan-live', 'live', true],
  ]);
  assert.deepEqual(f.calls(), ['missing', 'new', 'live']);
});

for (const code of ['ROTTIE_APP_NOT_RUNNING', 'ROTTIE_INTERNAL', 'invalid-json']) {
  test(`목록 조회의 ${code} 오류는 빈 목록으로 숨기지 않는다`, t => {
    const f = fixture(t);
    f.start('live');
    fs.writeFileSync(f.config, JSON.stringify({live: code}));
    assert.throws(() => rottieFloor.list(), error =>
      error.code === (code === 'invalid-json' ? 'ROTTIE_JSON_PARSE' : code));
  });
}
