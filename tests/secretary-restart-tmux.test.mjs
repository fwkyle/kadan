// 실제 CLI(kadan restart 비서)·실제 tmux·ps·lsof로 비서 자리 값이 다시 띄운 프로세스의 인자까지 가는지 본다.
// 실행기는 가짜 Node 스크립트(이름만 codex)이고 격리 홈·격리 tmux 서버만 쓴다. 모델·대화 ID는 가짜 값이다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ledgerHome, appendLedger, readLedger} from '../src/ledger.mjs';
import {tmuxFloor, tmux} from '../src/floor-tmux.mjs';
import {DEFAULT_FAMILIES} from '../src/runner-settings.mjs';

const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
const skip = spawnSync('tmux', ['-V']).status !== 0;
const SESSION = 'kadan-비서';
// 가짜 실행기는 부모(창 안 프로세스)가 사라지면 스스로 끝난다(창을 끄는 쪽이 못 끄면 고아로 남는다).
const WATCH_PARENT = 'const pp=process.ppid;setInterval(()=>{try{process.kill(pp,0)}catch{process.exit(0)}},200);';
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function setup(t) {
  const home = ledgerHome();
  const prior = {socket: process.env.KADAN_SOCKET, tmpdir: process.env.TMUX_TMPDIR};
  process.env.KADAN_SOCKET = `s${process.pid}secretary`;
  const work = fs.mkdtempSync('/tmp/ks-'); // 소켓 경로가 길면 tmux가 거절한다. 비서의 작업 폴더로도 쓴다.
  process.env.TMUX_TMPDIR = work;
  // 원래 값으로 되돌린다: 지우면 뒤 시험과 자식이 운영 기본 소켓으로 돌아간다.
  t.after(() => {
    tmux(['kill-server']);
    fs.rmSync(work, {recursive: true, force: true});
    for (const [key, value] of [['KADAN_SOCKET', prior.socket], ['TMUX_TMPDIR', prior.tmpdir]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const dir = path.join(home, 'secretary-restart');
  fs.mkdirSync(dir, {recursive: true});
  const transcript = path.join(dir, 'rollout-live.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({type: 'session_meta', payload: {id: 'live-exact', cwd: fs.realpathSync(work)}}) + '\n');
  const launches = path.join(dir, 'launches.jsonl');
  // 가짜 codex: 받은 인자를 한 줄 적고 대화 파일을 연 채 머문다.
  const fake = path.join(dir, 'codex');
  fs.writeFileSync(fake, `#!${process.execPath}
const fs=require('fs');const fd=fs.openSync(${JSON.stringify(transcript)},'r');
fs.appendFileSync(${JSON.stringify(launches)},JSON.stringify(process.argv.slice(2))+'\\n');
console.log('›');${WATCH_PARENT}`, {mode: 0o700});
  const launchCount = () => fs.existsSync(launches) ? fs.readFileSync(launches, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  const waitLaunch = count => {
    for (let i = 0; i < 200 && launchCount() < count; i++) sleep(50);
    assert.equal(launchCount(), count, `가짜 실행기가 ${count}번째로 떴다`);
    return JSON.parse(fs.readFileSync(launches, 'utf8').trim().split('\n').at(-1));
  };
  const cwd = fs.realpathSync(work);
  const cmd = `${fake} --model gpt-6-luna -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox`;
  const created = tmuxFloor.create({session: SESSION, role: '비서', cwd, cmd});
  appendLedger({kind: 'start', floor: 'tmux', role: '비서', session: SESSION, cwd, cmd, by: 'test', roleProfile: 'secretary', ...created});
  waitLaunch(1);
  const restart = (...flags) => spawnSync(process.execPath, [cli, 'restart', '비서', '--force', '--reason', '시험', ...flags],
    {encoding: 'utf8', timeout: 60000, env: {...process.env, KADAN_WINDOW: 'none', KADAN_FLOOR: 'tmux'}});
  const writeSettings = secretary => fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify({
    version: 1, revision: 4, activePreset: 'A', families: DEFAULT_FAMILIES, blocked: [],
    runners: {codex: {spawn: 'codex --model {model} -c model_reasoning_effort="{effort}"', models: []}},
    presets: {A: {label: '시험', roles: secretary ? {secretary} : {}}}}));
  const latestStart = () => readLedger(home).findLast(e => e.kind === 'start' && e.session === SESSION);
  return {home, restart, writeSettings, waitLaunch, launchCount, latestStart};
}

const effortArgs = args => args.filter(word => word.startsWith('model_reasoning_effort='));

test('실제 CLI: 설정 파일이 깨져 있어도 비서는 저장된 명령 그대로 다시 뜨고, 자리 값이 생기면 그 모델·강도로 뜬다', {skip}, t => {
  const f = setup(t);

  // 1) 설정 파일 깨짐: 막지 않고 저장된 명령 그대로, 경고 한 줄과 원장 이유.
  fs.writeFileSync(path.join(f.home, 'runner-settings.json'), '{"version": 1, "revision":');
  const broken = f.restart();
  assert.equal(broken.status, 0, broken.stderr);
  assert.match(broken.stderr, /경고: 비서 실행 모델 설정을 적용하지 못해 저장된 명령 그대로 연다\(실행 모델 설정 파일을 읽지 못함\)/);
  assert.doesNotMatch(broken.stdout, /설정 반영|설정과 같음/);
  const kept = f.waitLaunch(2);
  assert.deepEqual(kept.slice(0, 4), ['resume', 'live-exact', '--model', 'gpt-6-luna']);
  assert.deepEqual(effortArgs(kept), ['model_reasoning_effort=high']);
  assert.ok(kept.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.equal(f.latestStart().modelFromSettingsSkipped, 'settings-unreadable');
  assert.equal('modelFromSettings' in f.latestStart(), false);

  // 2) 비서 자리 sol·medium: 같은 대화, 모델·강도만 설정값. 실제 프로세스 인자에서 옵션이 한 벌이다.
  f.writeSettings({runner: 'codex', model: 'gpt-6-sol', effort: 'medium'});
  const applied = f.restart();
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /설정 반영: gpt-6-luna · high → gpt-6-sol · medium \(설정 revision 4, 프리셋 A\)/);
  assert.doesNotMatch(applied.stderr, /경고: 비서 실행 모델 설정/);
  const swapped = f.waitLaunch(3);
  assert.deepEqual(swapped.slice(0, 4), ['resume', 'live-exact', '--model', 'gpt-6-sol']);
  assert.equal(swapped.filter(word => word === '--model').length, 1);
  assert.deepEqual(effortArgs(swapped), ['model_reasoning_effort="medium"']);
  assert.ok(swapped.includes('--dangerously-bypass-approvals-and-sandbox'));
  const start = f.latestStart();
  assert.equal(start.modelFromSettings, true);
  assert.deepEqual(start.runnerChoice, {runner: 'codex', model: 'gpt-6-sol', effort: 'medium'});
  assert.deepEqual([start.settingsRevision, start.settingsPreset, start.previousModel, start.previousEffort], [4, 'A', 'gpt-6-luna', 'high']);
  assert.equal(start.reason, '시험');

  // 3) 한 번 더: 이미 설정값이라 바뀐 것이 없고 옵션은 여전히 한 벌이다.
  const again = f.restart();
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /설정과 같음: 바뀐 것 없음 — gpt-6-sol · medium/);
  const same = f.waitLaunch(4);
  assert.equal(same.filter(word => word === '--model').length, 1);
  assert.deepEqual(effortArgs(same), ['model_reasoning_effort="medium"']);

  // 4) --model-from-settings인데 자리가 비어 있으면 끄기 전에 거절한다(새로 뜨지 않는다).
  f.writeSettings(null);
  const pid = tmuxFloor.pid(SESSION);
  const refused = f.restart('--model-from-settings');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /비서 자리가 비어 있다/);
  assert.equal(tmuxFloor.pid(SESSION), pid, '기존 세션은 그대로다');
  assert.equal(f.launchCount(), 4);
});
