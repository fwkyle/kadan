import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script = fileURLToPath(new URL('../scripts/watch-judge.sh', import.meta.url));

test('감시 폴더만 실행 중 untrusted로 지정하고 기존 쓰기 경계를 유지한다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-judge-trust-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'),
    '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n',
    {mode: 0o755});
  const alias = path.join(root, 'home-alias');
  fs.symlinkSync(home, alias);

  for (const name of ['ordinary', 'dot.quote".back\\slash.$(touch nope)\n한글']) {
    const dir = path.join(home, name);
    fs.mkdirSync(dir);
    const result = spawnSync('bash', [script], {
      encoding: 'utf8', input: '관찰 자료',
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`,
        KADAN_HOME: alias, KADAN_JUDGE_DIR: path.join(alias, name),
        KADAN_JUDGE_MODEL: 'probe', KADAN_JUDGE_EFFORT: 'low',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(fs.readFileSync(path.join(dir, 'diagnostic.log'), 'utf8'));
    const configs = args.flatMap((arg, i) => arg === '-c' ? [args[i + 1]] : []);
    assert.deepEqual(configs.filter(value => value.startsWith('projects=')), [
      `projects={${JSON.stringify(fs.realpathSync(dir))}={trust_level="untrusted"}}`,
    ]);
    assert.equal(args[args.indexOf('-C') + 1], fs.realpathSync(dir));
    assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
    assert.equal(args[args.indexOf('-a') + 1], 'never');
    assert.deepEqual(args.flatMap((arg, i) => arg === '--add-dir' ? [args[i + 1]] : []),
      [fs.realpathSync(home)]);
    assert.ok(configs.includes('project_doc_max_bytes=0'));
    assert.ok(configs.includes('sandbox_workspace_write.network_access=true'));
    assert.ok(!args.some(arg => arg.includes('dangerously')));
    assert.equal(fs.readFileSync(path.join(dir, 'input.txt'), 'utf8'), '관찰 자료');
  }
});
