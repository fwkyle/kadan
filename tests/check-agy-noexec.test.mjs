import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// 재확인 스크립트(scripts/check-agy-noexec.mjs)를 가짜 agy로 시험한다. 진짜 agy·인증·네트워크는 쓰지 않는다.
const script = new URL('../scripts/check-agy-noexec.mjs', import.meta.url).pathname;
const FAKE = `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('fake-agy 0.0'); process.exit(0); }
import('node:fs').then(fs => {
  const mode = process.env.FAKE_AGY_MODE;
  const agent = argv[argv.indexOf('--agent') + 1];
  const prompt = argv[argv.indexOf('--print') + 1];
  if (agent !== 'kadan-noexec' || !fs.existsSync('.agents/agents/kadan-noexec/agent.md')) { console.error('agent missing'); process.exit(1); }
  if (mode === 'exec' && prompt.includes('cp a.txt')) fs.copyFileSync('a.txt', 'b.txt');
  if (mode === 'leak' && prompt.includes('fake-secret')) console.log(JSON.stringify({response: fs.readFileSync(prompt.match(/\\S*fake-secret.txt/)[0], 'utf8')}));
  else console.log(JSON.stringify({response: mode === 'plain' ? '글' : '\`\`\`json\\n{"ok": true}\\n\`\`\`'}));
});
`;

function runScript(mode) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-fake-agy-'));
  fs.writeFileSync(path.join(bin, 'agy'), FAKE, {mode: 0o755});
  const res = spawnSync(process.execPath, [script], {encoding: 'utf8', env: {...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_AGY_MODE: mode}});
  return {status: res.status, out: res.stdout + res.stderr};
}

test('재확인 스크립트: 가짜 agy가 안전하면 모두 통과하고 agy를 3번 부른다', () => {
  const r = runScript('safe');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /agy 호출 3회\. 판정: 모두 통과/);
  assert.ok(!/^실패/m.test(r.out));
});

test('재확인 스크립트: 가짜 agy가 cp를 실행하면 실패(종료 코드 1)로 보고한다', () => {
  const r = runScript('exec');
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /실패  명령 실행 0건 \(cp·ln·mkdir\)/);
});

test('재확인 스크립트: 가짜 agy가 폴더 밖 표식을 읽으면 실패로 보고한다', () => {
  const r = runScript('leak');
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /실패  작업 폴더 밖 읽기 거부/);
});

test('재확인 스크립트: JSON이 아닌 답은 실패로 보고한다', () => {
  const r = runScript('plain');
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /실패  JSON 응답 정상 \(요약 요청 호출\)/);
});
