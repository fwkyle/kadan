import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import {readSystemLedger,readMailLedger} from '../src/ledger.mjs';
import { linkSkills, runInit, runUp, waitForSettled, readConfig, FIRST_PROMPT, SECRETARY_ROLE, DASHBOARD_ROLE } from '../src/quickstart.mjs';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const quiet = () => {};

test('linkSkills는 있는 스킬 폴더에만 링크하고 남의 링크·실물은 덮지 않는다', () => {
 const repo = tmp('kadan-qs-repo-'); const userHome = tmp('kadan-qs-home-');
 for (const s of ['kadan-conductor', 'kadan-super']) fs.mkdirSync(path.join(repo, 'skills', s), { recursive: true });
 fs.mkdirSync(path.join(userHome, '.codex/skills'), { recursive: true });
 fs.mkdirSync(path.join(userHome, '.claude/skills/kadan-super'), { recursive: true });
 fs.symlinkSync('/elsewhere/kadan-conductor', path.join(userHome, '.claude/skills/kadan-conductor'));
 const r = linkSkills({ skillsDir: path.join(repo, 'skills'), userHome });
 const by = (dir, name) => r.find((x) => x.dir.endsWith(dir) && x.name === name)?.state;
 assert.equal(by('.codex/skills', 'kadan-conductor'), 'linked');
 assert.equal(by('.codex/skills', 'kadan-super'), 'linked');
 assert.equal(by('.claude/skills', 'kadan-conductor'), 'kept');
 assert.equal(by('.claude/skills', 'kadan-super'), 'kept');
 assert.equal(r.find((x) => x.dir.endsWith('.agents/skills')).state, 'skipped');
 assert.equal(fs.readlinkSync(path.join(userHome, '.codex/skills/kadan-super')), path.join(repo, 'skills/kadan-super'));
 assert.equal(fs.readlinkSync(path.join(userHome, '.claude/skills/kadan-conductor')), '/elsewhere/kadan-conductor');
 assert.equal(linkSkills({ skillsDir: path.join(repo, 'skills'), userHome }).filter((x) => x.state === 'already').length, 2);
});

test('runInit은 tmux 없음·PATH에 없는 실행기를 막고, 있으면 설정·예시 파일을 만든다', () => {
 const home = tmp('kadan-qs-data-'); const repo = tmp('kadan-qs-repo2-'); const userHome = tmp('kadan-qs-home2-');
 fs.mkdirSync(path.join(repo, 'skills/kadan-conductor/references'), { recursive: true });
 fs.writeFileSync(path.join(repo, 'skills/kadan-conductor/references/agent-runners.example.json'), '{"x":1}\n');
 const okSpawn = () => ({ status: 0, stdout: 'tmux 3.5a' });
 assert.throws(() => runInit({ home, repoRoot: repo, spawn: () => ({ status: 1 }), userHome, log: quiet }), /tmux/);
 assert.throws(() => runInit({ home, repoRoot: repo, spawn: okSpawn, which: () => null, flags: { runner: 'codex' }, userHome, log: quiet }), /PATH/);
 const r = runInit({ home, repoRoot: repo, spawn: okSpawn, which: (n) => (n === 'claude' ? '/bin/claude' : null), userHome, log: quiet });
 assert.equal(r.runner, 'claude'); assert.deepEqual(r.runners, ['claude']);
 assert.equal(readConfig(home).runner, 'claude');
 assert.equal(fs.readFileSync(path.join(home, 'agent-runners.json'), 'utf8'), '{"x":1}\n');
 assert.equal(r.agentRunners, 'copied');
 fs.writeFileSync(path.join(home, 'agent-runners.json'), '{"mine":true}\n');
 const again = runInit({ home, repoRoot: repo, spawn: okSpawn, which: () => '/bin/x', flags: { 'no-skills': true }, userHome, log: quiet });
 assert.equal(again.agentRunners, 'exists'); assert.equal(again.runner, 'claude', '기존 선택을 유지한다'); assert.deepEqual(again.skills, []);
});

test('waitForSettled는 화면이 두 번 연속 같을 때만 참이다', () => {
 const frames = ['', 'loading', 'ready >', 'ready >'];
 let i = 0;
 assert.equal(waitForSettled({ read: () => frames[Math.min(i++, frames.length - 1)], sleep: () => {}, tries: 10 }), true);
 assert.equal(i, 4);
 assert.equal(waitForSettled({ read: () => String(Math.random()), sleep: () => {}, tries: 3 }), false);
 assert.equal(waitForSettled({ read: () => { throw new Error('x'); }, sleep: () => {}, tries: 2 }), false);
});

function fakeWorld({ alive = {}, frames = ['ready', 'ready'] } = {}) {
 const started = [], sent = [];
 let f = 0;
 const floor = {
  name: 'fake',
  alive: (s) => Boolean(alive[s]),
  read: () => frames[Math.min(f++, frames.length - 1)],
  attach: (s) => `tmux attach -t ${s}`,
 };
 const start = (argv, flags) => { started.push({ role: argv[0], ...flags }); alive[`kadan-${argv[0]}`] = true; };
 const send = (x) => sent.push(x);
 return { floor, start, send, started, sent, alive };
}
const sessionName = (r) => `kadan-${r}`;

test('runUp은 비서(보이게)와 대시보드(숨김)를 띄우고 준비된 비서에게만 첫 지문을 한 번 보낸다', () => {
 const home = tmp('kadan-qs-up-'); const w = fakeWorld();
 const out = runUp({ home, flags: { cmd: 'codex', port: '8123' }, floor: w.floor, start: w.start, send: w.send, cliPath: '/repo/src/cli.mjs', nodePath: '/usr/bin/node', sessionName, log: quiet, sleep: () => {} });
 assert.deepEqual(w.started.map((s) => s.role), [SECRETARY_ROLE, DASHBOARD_ROLE]);
 assert.equal(w.started[0].cmd, 'codex'); assert.equal(w.started[0].hidden, false);
 assert.equal(w.started[0].profile, 'secretary');
 assert.equal(w.started[1].hidden, true); assert.equal(w.started[1].cmd, '/usr/bin/node /repo/src/cli.mjs dashboard --port 8123');
 assert.equal(w.sent.length, 1); assert.equal(w.sent[0].role, SECRETARY_ROLE); assert.equal(w.sent[0].message, FIRST_PROMPT);
 assert.equal(w.sent[0].roleProfile, 'secretary');
 assert.deepEqual([out.secretary, out.dashboard, out.prompt], ['started', 'started', 'sent']);
});

test('runUp은 살아 있는 세션을 다시 만들지 않고, 재사용·--no-prompt·미준비에는 지문을 보내지 않는다', () => {
 const home = tmp('kadan-qs-up2-');
 const w1 = fakeWorld({ alive: { 'kadan-비서': true } });
 const o1 = runUp({ home, flags: { cmd: 'codex' }, floor: w1.floor, start: w1.start, send: w1.send, cliPath: '/c', sessionName, log: quiet, sleep: () => {} });
 assert.deepEqual(w1.started.map((s) => s.role), [DASHBOARD_ROLE]); assert.equal(w1.sent.length, 0); assert.equal(o1.secretary, 'reused');
 const w2 = fakeWorld();
 runUp({ home, flags: { cmd: 'codex', 'no-prompt': true }, floor: w2.floor, start: w2.start, send: w2.send, cliPath: '/c', sessionName, log: quiet, sleep: () => {} });
 assert.equal(w2.sent.length, 0);
 const w3 = fakeWorld({ frames: Array.from({ length: 30 }, (_, i) => `frame${i}`) });
 const o3 = runUp({ home, flags: { cmd: 'codex' }, floor: w3.floor, start: w3.start, send: w3.send, cliPath: '/c', sessionName, log: quiet, sleep: () => {} });
 assert.equal(w3.sent.length, 0); assert.equal(o3.prompt, 'not-ready');
 assert.throws(() => runUp({ home, flags: { cmd: 'codex', port: '99999' }, floor: w2.floor, start: w2.start, send: w2.send, cliPath: '/c', sessionName, log: quiet }), /--port/);
});

test('runUp은 실행기가 없으면 init을 안내하며 멈추고, init이 고른 실행기를 기본으로 쓴다', () => {
 const home = tmp('kadan-qs-up3-'); const w = fakeWorld();
 fs.writeFileSync(path.join(home, 'quickstart.json'), JSON.stringify({ runner: 'claude' }));
 runUp({ home, flags: { 'no-prompt': true }, floor: w.floor, start: w.start, send: w.send, cliPath: '/c', sessionName, log: quiet });
 assert.equal(w.started[0].cmd, 'claude');
});

test('격리 tmux: kadan up이 비서·대시보드 세션을 만들고 대시보드가 HTTP 200을 돌려준다', async (t) => {
 if (spawnSync('tmux', ['-V']).status !== 0) return t.skip('tmux 없음');
 const home = tmp('kadan-qs-e2e-'); const socket = `kadan-qs-${process.pid}`;
 const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
 const env = { ...process.env, KADAN_HOME: home, KADAN_SOCKET: socket, KADAN_FLOOR: 'tmux', KADAN_WINDOW: 'none' };
 const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
 try {
  const up = spawnSync(process.execPath, [cli, 'up', '--cmd', 'sh', '--port', String(port), '--hidden'], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(up.status, 0, up.stdout + up.stderr);
  assert.match(up.stdout, /시작됨: kadan-비서/); assert.match(up.stdout, /시작됨: kadan-대시보드/); assert.match(up.stdout, /첫 지문 전송됨/);
  const list = spawnSync('tmux', ['-L', socket, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' }).stdout;
  assert.match(list, /kadan-비서/); assert.match(list, /kadan-대시보드/);
  let status = null;
  for (let i = 0; i < 40 && status !== 200; i++) { try { status = (await fetch(`http://127.0.0.1:${port}/`)).status; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  assert.equal(status, 200);
  const again = spawnSync(process.execPath, [cli, 'up', '--cmd', 'sh', '--port', String(port), '--hidden'], { env, encoding: 'utf8', timeout: 60000 });
  assert.match(again.stdout, /비서 이미 살아 있음/); assert.match(again.stdout, /대시보드 이미 살아 있음/);
  const starts = readSystemLedger(home).filter(e=>e.kind==='start');
  assert.equal(starts.length, 2, '두 번째 up은 start를 다시 기록하지 않는다');
  assert.deepEqual(starts.map(e=>e.role),[SECRETARY_ROLE,DASHBOARD_ROLE]);
  const sends=readMailLedger(home).filter(e=>e.kind==='send');assert.equal(sends.length,1,'재실행은 첫 지문을 중복 전달하지 않는다');
  assert.equal(sends[0].role,SECRETARY_ROLE);assert.equal(sends[0].floor,'tmux');assert.notEqual(sends[0].transport,'mailbox');
 } finally {
  spawnSync('tmux', ['-L', socket, 'kill-server']);
 }
});
