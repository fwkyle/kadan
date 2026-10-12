import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ledgerHome, appendLedger, readSystemLedger} from '../src/ledger.mjs';
import {tmuxFloor, tmux} from '../src/floor-tmux.mjs';
import {inspectRecovery, restoreRecovery} from '../src/recovery.mjs';

test('real tmux server loss restores role generations over two restarts', {
  skip: spawnSync('tmux', ['-V']).status !== 0,
}, t => {
  const home = ledgerHome();
  process.env.KADAN_SOCKET = `recovery-${process.pid}`;
  process.env.TMUX_TMPDIR = home;
  t.after(() => {
    tmux(['kill-server']); // Only this test-owned named server.
    delete process.env.KADAN_SOCKET;
    delete process.env.TMUX_TMPDIR;
  });
  const bin = path.join(home, 'fixture-rottie');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0] !== 'terminal' || args[1] !== 'create')process.exit(2);
console.log(JSON.stringify({ok:true,result:{terminal:{id:'terminal-'+process.pid}}}));
`, {mode: 0o700});
  const cwd = path.join(home, 'workspace'); fs.mkdirSync(cwd);
  const hierarchy = path.join(home, 'hierarchy.txt');
  fs.writeFileSync(hierarchy, 'director -> supervisor\n');
  const original = tmuxFloor.create({session: 'kadan-director', role: 'director', cwd,
    cmd: 'sleep 120'});
  appendLedger({kind: 'start', floor: 'tmux', role: 'director', session: 'kadan-director',
    cwd, cmd: 'sleep 120', roleProfile: 'conductor', by: 'supervisor', ...original,
    rottieTerminalId: 'original'});
  let context = inspectRecovery({terminal: 'original', 'pane-pid': original.panePid});
  for (let reboot = 0; reboot < 2; reboot++) {
    assert.equal(tmux(['kill-server']).status, 0);
    const receipt = restoreRecovery({context: JSON.stringify(context), command: 'sleep 120',
      'rottie-bin': bin, 'allow-reuse': 'false'});
    assert.equal(receipt.role, 'director');
    assert.equal(receipt.context.cwd, cwd);
    assert.equal(tmuxFloor.alive('kadan-director'), true);
    assert.equal(tmuxFloor.pid('kadan-director'), receipt.context.panePid);
    assert.notEqual(receipt.context.startDigest, context.startDigest);
    const start = readSystemLedger().filter(e => e.kind === 'start').at(-1);
    assert.equal(start.roleProfile, 'conductor');
    assert.equal(start.by, 'supervisor');
    assert.equal(start.cmd, 'sleep 120');
    assert.equal(fs.readFileSync(hierarchy, 'utf8'), 'director -> supervisor\n');
    assert.throws(() => restoreRecovery({context: JSON.stringify(context), command: 'sleep 120',
      'rottie-bin': bin, 'allow-reuse': 'false'}), /교체되거나/);
    context = receipt.context;
  }
});
