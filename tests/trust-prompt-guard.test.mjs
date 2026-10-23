// 발령의 Enter가 Claude '폴더 신뢰' 창의 "No, exit"를 눌러 역할이 사라진 사고(2026-10-23)의 재발 방지.
// 전송 직전 화면 검사(sendTmux)와 start·restart의 작업 폴더 검사를 시험한다. 운영 tmux·Rottie는 쓰지 않는다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {sendTmux, hasTrustPrompt} from '../src/floor-tmux.mjs';
import {workdirInsideHome} from '../src/cli-start-support.mjs';
import {restartRole} from '../src/restart.mjs';
import {readLedger} from '../src/ledger.mjs';
import {settingsWith} from './helpers/runner-table.mjs';

const CLI = path.resolve(import.meta.dirname, '../src/cli.mjs');
const noopSpawn = () => ({});

const PROMPT = [
  ' Accessing workspace:',
  '',
  ' /home/user/.kadan',
  '',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
  ' project, or work from your team). If not, take a moment to review what\'s in this folder first.',
  '',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');
// 화면 기록에서 공백이 빠진 실제 꼴.
const PROMPT_NO_SPACES = 'Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?\n❯1.Yes,Itrustthisfolder\n2.No,exit\nEntertoconfirm·Esctocancel';
// 줄바꿈으로 낱말이 갈린 꼴(좁은 폭).
const PROMPT_WRAPPED = 'Is this a project you cre\nated or one you trust?\n❯ 1. Yes, I tr\nust this folder\n2. No, exit\nEnter to con\nfirm · Esc to cancel';
// 사고 원본(2026-10-23, rottie WL2 작업자)의 마지막 화면. 공백이 빠진 꼴이고 선택 표시 ❯는 "No, exit"에 있다.
const INCIDENT = [
  'Accessingworkspace:', '', '/home/user/.kadan', '',
  'Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?(Likeyourowncode,awell-knownopensource',
  "project,orworkfromyourteam).Ifnot,takeamomenttoreviewwhat'sinthisfolderfirst.", '',
  "ClaudeCode'llbeabletoread,edit,andexecutefileshere.", '', 'Security guide', '',
  '❯No,exit', 'Yes,Itrustthisfolder', '', 'EntertoconfirmESCtocancel',
].join('\n');
// 정상 화면 바닥: 빈 입력창과 상태 줄.
const INPUT_BOX = ['─'.repeat(40), '❯ ', '─'.repeat(40), '  ? for shortcuts'].join('\n');
const QUESTION = 'Is this a project you created or one you trust?', YES = 'Yes, I trust this folder';
// 검수자의 오검출 반증 화면 4종: 두 문구를 인용만 했고 아래에 정상 입력창이 있다.
const QUOTED = {
  '인용 문단': `사용자: "${QUESTION}"라는 창과 "${YES}"를 설명해 줘.\n${INPUT_BOX}`,
  '코드 블록': `예시 문구:\n\`\`\`text\n${QUESTION}\n${YES}\n\`\`\`\n${INPUT_BOX}`,
  '인용문': `> ${QUESTION}\n> ${YES}\n${INPUT_BOX}`,
  '흩어진 줄': `${QUESTION}\n${Array.from({length: 8}, (_, i) => `중간 줄 ${i}`).join('\n')}\n${YES}\n${INPUT_BOX}`,
};

function fakeRun(screen, calls) {
  return args => {
    calls.push(args);
    if (args[0] === 'capture-pane') { if (screen instanceof Error) throw screen; return screen; }
    if (args[0] === 'display-message') return '0\n';
    if (args[0] === 'list-clients') return '';
    return undefined;
  };
}
const keysSent = calls => calls.filter(c => ['load-buffer', 'paste-buffer', 'send-keys'].includes(c[0])).length;

test('hasTrustPrompt: 사고 원본·옛 꼴·공백 빠진 꼴·낱말이 갈린 꼴은 신뢰 창이다', () => {
  for (const screen of [INCIDENT, PROMPT, PROMPT_NO_SPACES, PROMPT_WRAPPED]) assert.equal(hasTrustPrompt(screen), true);
  assert.equal(hasTrustPrompt(''), false);
  assert.equal(hasTrustPrompt(undefined), false);
});

test('hasTrustPrompt: 질문·선택지·Enter 안내 중 하나라도 없으면 신뢰 창이 아니다', () => {
  assert.equal(hasTrustPrompt(`${QUESTION}\n${YES}`), false, '선택지·안내 없음');
  assert.equal(hasTrustPrompt(`${QUESTION}\n❯ No, exit\n${YES}`), false, 'Enter 안내 없음');
  assert.equal(hasTrustPrompt(`❯ No, exit\n${YES}\nEnter to confirm`), false, '질문 없음');
  assert.equal(hasTrustPrompt(`${QUESTION}\n${YES}\nEnter to confirm`), false, 'No, exit 선택지 없음');
  assert.equal(hasTrustPrompt('대화: "Yes, I trust this folder" 를 눌렀다'), false);
});

test('오검출 반증(검수 F1): 두 문구를 인용한 정상 화면 4종은 아래에 입력창이 있어 신뢰 창이 아니고, 그대로 보낸다', () => {
  for (const [name, screen] of Object.entries(QUOTED)) {
    assert.equal(hasTrustPrompt(screen), false, name);
    const calls = [];
    assert.equal(sendTmux('kadan-trust', '본문', {run: fakeRun(screen, calls), spawn: noopSpawn}).keyDelivery, 'sent', name);
    assert.equal(calls.filter(c => c[0] === 'send-keys').length, 1, name);
  }
});

test('오검출 반증: 인용에 선택지·Enter 안내까지 다 있어도 아래에 정상 입력창이 있으면 보낸다', () => {
  const screen = `예시:\n${QUESTION}\n❯ No, exit\n${YES}\nEnter to confirm · Esc to cancel\n${INPUT_BOX}`;
  assert.equal(hasTrustPrompt(screen), false);
});

test('이미 고르고 지나가 아래에 정상 입력창이 생긴 화면은 보낸다', () => {
  assert.equal(hasTrustPrompt(`${INCIDENT}\n\n${INPUT_BOX}`), false);
  assert.equal(hasTrustPrompt(`${PROMPT}\n${INPUT_BOX}`), false);
});

test('놓침 반증(검수 F2): 사고 원본 아래에 빈 줄이 24·40·50·60줄 남아도 모두 막고 키 0회', () => {
  for (const height of [24, 40, 50, 60]) {
    const screen = `${INCIDENT}${'\n'.repeat(height - INCIDENT.split('\n').length + 1)}`;
    assert.equal(hasTrustPrompt(screen), true, `높이 ${height}`);
    const calls = [];
    assert.throws(() => sendTmux('kadan-trust', '본문', {run: fakeRun(screen, calls), spawn: noopSpawn}), e => e.code === 'KADAN_TRUST_PROMPT' && e.delivery === 'not-sent', `높이 ${height}`);
    assert.equal(keysSent(calls), 0, `높이 ${height}: 키 0회`);
  }
  // 공백만 있는 끝 줄도 빈 줄로 본다.
  assert.equal(hasTrustPrompt(`${INCIDENT}\n${'   \n'.repeat(30)}`), true);
});

test('확인 창이 보이면 일반·카드·알림 전송 모두 키 0회 + KADAN_TRUST_PROMPT + not-sent', () => {
  const identity = {currentPid: '1', harness: 'claude', model: 'm'};
  const variants = {
    '일반 우편': {},
    '카드 발령(cardIdentity)': {cardIdentity: identity},
    '감시 알림(강제 차례)': {notificationGuard: {force: true, humanIdleMs: 30000}},
  };
  for (const screen of [INCIDENT, PROMPT, PROMPT_NO_SPACES, PROMPT_WRAPPED]) {
    for (const [name, options] of Object.entries(variants)) {
      const calls = [];
      assert.throws(() => sendTmux('kadan-trust', '본문', {run: fakeRun(screen, calls), spawn: noopSpawn, ...options}), error => {
        assert.equal(error.code, 'KADAN_TRUST_PROMPT', name);
        assert.equal(error.delivery, 'not-sent', name);
        assert.equal(error.inputAcceptance, 'unconfirmed');
        assert.match(error.message, /폴더 신뢰 확인 창/);
        assert.match(error.message, /No, exit/);
        return true;
      }, name);
      assert.equal(keysSent(calls), 0, `${name}: 키 0회`);
      assert.deepEqual(calls.map(c => c[0]), ['capture-pane'], `${name}: 화면 읽기 한 번뿐`);
    }
  }
});

test('확인 창 문구를 한 줄만 인용한 화면은 그대로 보낸다', () => {
  for (const screen of [`사용자: "${QUESTION}" 창이 뜨면?\n❯ `, `${YES} 를 고르세요\n❯ `]) {
    const calls = [];
    const receipt = sendTmux('kadan-trust', '본문', {run: fakeRun(screen, calls), spawn: noopSpawn});
    assert.equal(receipt.keyDelivery, 'sent');
    assert.equal(calls.filter(c => c[0] === 'send-keys').length, 1);
  }
});

test('화면 읽기가 실패하면 지금까지처럼 보낸다(새 실패 원인을 만들지 않는다)', () => {
  const calls = [];
  const receipt = sendTmux('kadan-trust', '본문', {run: fakeRun(new Error('capture 실패'), calls), spawn: noopSpawn});
  assert.equal(receipt.keyDelivery, 'sent');
  assert.equal(calls.filter(c => c[0] === 'paste-buffer').length, 1);
  assert.equal(calls.filter(c => c[0] === 'send-keys').length, 1);
});

test('비지 않은 마지막 25줄 밖에 남은 옛 확인 창은 막지 않는다', () => {
  const screen = `${PROMPT}\n${Array.from({length: 40}, (_, i) => `작업 줄 ${i}`).join('\n')}`;
  const calls = [];
  assert.equal(hasTrustPrompt(screen), false);
  assert.equal(sendTmux('kadan-trust', '본문', {run: fakeRun(screen, calls), spawn: noopSpawn}).keyDelivery, 'sent');
});

test('workdirInsideHome: 홈 자신·안쪽은 거절, 바깥·이름만 비슷한 옆 폴더는 통과, 심볼릭 링크는 실경로로 본다', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-trust-wd-')));
  const home = path.join(root, 'home'), nested = path.join(home, 'cards/kadan/x'), sibling = path.join(root, 'home-other'), link = path.join(root, 'link');
  for (const dir of [nested, sibling]) fs.mkdirSync(dir, {recursive: true});
  fs.symlinkSync(home, link);
  assert.equal(workdirInsideHome(home, home), home);
  assert.equal(workdirInsideHome(nested, home), home);
  assert.equal(workdirInsideHome(link, home), home);
  assert.equal(workdirInsideHome(sibling, home), null);
  assert.equal(workdirInsideHome(root, home), null);
});

test('workdirInsideHome(검수 F3): 이름이 ..로 시작하는 홈 하위 폴더는 홈 안, 형제 폴더는 홈 밖', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-trust-dots-')));
  const home = path.join(root, 'home'), dotted = path.join(home, '..review'), sibling = path.join(root, 'x');
  for (const dir of [dotted, sibling]) fs.mkdirSync(dir, {recursive: true});
  assert.equal(workdirInsideHome(dotted, home), home);
  assert.equal(workdirInsideHome(path.join(home, '..review/deep'), home), home);
  assert.equal(workdirInsideHome(path.join(home, '../x'), home), null);
  assert.equal(workdirInsideHome(sibling, home), null);
});

// 격리 tmux: 운영 소켓·홈과 분리된 소켓·홈에서 CLI를 실제로 돌린다.
const hasTmux = () => spawnSync('tmux', ['-V']).status === 0;
function world(t, tag) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `kadan-trust-${tag}-`)));
  const home = path.join(root, 'home'), work = path.join(root, 'work');
  fs.mkdirSync(path.join(home, 'cards/x'), {recursive: true}); fs.mkdirSync(work);
  const socket = `kt${process.pid}${tag}`;
  const env = {...process.env, KADAN_HOME: home, KADAN_SOCKET: socket, KADAN_FLOOR: 'tmux', KADAN_WINDOW: 'none', KADAN_NOTIFY: 'off', KADAN_ALT_CHECK_MS: '0'};
  for (const name of ['KADAN_ROLE', 'KADAN_ROTTIE_BIN']) delete env[name];
  const kadan = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], {env, cwd, encoding: 'utf8', timeout: 60000});
  const tmux = (...args) => spawnSync('tmux', ['-u', '-L', socket, ...args], {encoding: 'utf8'});
  t.after(() => { tmux('kill-server'); });
  return {root, home, work, env, kadan, tmux};
}

test('start: 작업 폴더가 KADAN_HOME이거나 그 안이면 거절하고 세션을 만들지 않는다, 정상 폴더는 시작된다', t => {
  if (!hasTmux()) return t.skip('tmux 없음');
  const w = world(t, 's');
  for (const cwd of [w.home, path.join(w.home, 'cards/x')]) {
    const r = w.kadan(cwd, 'start', 'trust-w', '--hidden', '--cmd', 'sleep 600', '--reason', 'trust test', '--no-prompt');
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /작업 폴더가 카단 기록 폴더\(.+\) 안이다 — 작업 저장소\(worktree\)에서 다시 실행하라/);
    assert.notEqual(w.tmux('has-session', '-t', '=kadan-trust-w').status, 0, '세션 0');
    assert.equal(readLedger(w.home).filter(e => e.kind === 'start').length, 0, 'start 원장 0');
  }
  const ok = w.kadan(w.work, 'start', 'trust-w', '--hidden', '--cmd', 'sleep 600', '--reason', 'trust test', '--no-prompt');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(w.tmux('has-session', '-t', '=kadan-trust-w').status, 0);
  assert.equal(readLedger(w.home).filter(e => e.kind === 'start').at(-1).cwd, w.work);
});

test('격리 tmux: 바닥에 확인 창이 떠 있으면 send·mail 모두 키 0회, 원장 send 없음, 확인 창이 사라지면 보낸다', t => {
  if (!hasTmux()) return t.skip('tmux 없음');
  const w = world(t, 'm');
  const script = path.join(w.work, 'trust.sh'), shown = path.join(w.work, 'screen.txt');
  fs.writeFileSync(shown, `${PROMPT}\n`);
  // 화면 파일을 보여 준 뒤 flag 파일이 있는 동안 기다리고, 없어지면(사람이 창에서 고른 것) 화면을 지우고 입력을 파일로 남긴다.
  const flag = path.join(w.work, 'prompt.flag');
  fs.writeFileSync(flag, '');
  fs.writeFileSync(script, `#!/bin/sh\ncat '${shown}'\nwhile [ -e '${flag}' ]; do sleep 0.1; done\nprintf '\\033c'\nexec cat > '${path.join(w.work, 'typed.txt')}'\n`, {mode: 0o755});
  const started = w.kadan(w.work, 'start', 'trust-m', '--hidden', '--cmd', `sh ${script}`, '--reason', 'trust test', '--no-prompt');
  assert.equal(started.status, 0, started.stdout + started.stderr);
  const waitScreen = () => { for (let i = 0; i < 50; i++) { if (hasTrustPrompt(w.tmux('capture-pane', '-p', '-J', '-t', '=kadan-trust-m:').stdout)) return; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); } };
  waitScreen();
  assert.equal(hasTrustPrompt(w.tmux('capture-pane', '-p', '-J', '-t', '=kadan-trust-m:').stdout), true, '가짜 바닥에 확인 창이 떠야 시험이 성립한다');
  // 보관 우편의 send(transport: mailbox)는 저장 사건이지 창 전달이 아니다. 창 전달 send만 센다.
  const delivered = () => readLedger(w.home).filter(e => e.kind === 'send' && e.transport !== 'mailbox').length;
  const sendsBefore = delivered();
  for (const argv of [['send', 'trust-m', '본문1'], ['mail', 'trust-m', '본문2']]) {
    const r = w.kadan(w.work, ...argv);
    const output = r.stdout + r.stderr;
    // 일반 우편은 입력 보호 보류와 같이 보관으로 돌린다(종료 0). 키는 한 번도 보내지 않는다. 발령(--task)은 보관할 수 없어 오류로 끝난다.
    assert.equal(r.status, 0, `${argv[0]}: ${output}`);
    assert.match(output, /"status":"stored"/, `${argv[0]}: ${output}`);
    assert.match(output, /폴더 신뢰 확인 창/, `${argv[0]}: ${output}`);
  }
  assert.equal(delivered(), sendsBefore, '원장에 창 전달 send 없음');
  assert.equal(readLedger(w.home).filter(e => e.kind === 'send' && e.transport === 'mailbox').length, 2, '두 편지는 보관됨');
  assert.equal(fs.existsSync(path.join(w.work, 'typed.txt')) ? fs.readFileSync(path.join(w.work, 'typed.txt'), 'utf8') : '', '', '받는 쪽에 키가 한 번도 들어가지 않았다');
  // 확인 창이 사라지면(flag 파일을 옆으로 치운다) 같은 명령이 보낸다.
  fs.renameSync(flag, `${flag}.done`);
  for (let i = 0; i < 50 && hasTrustPrompt(w.tmux('capture-pane', '-p', '-J', '-t', '=kadan-trust-m:').stdout); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  const after = w.kadan(w.work, 'send', 'trust-m', '--raw', '본문3');
  assert.equal(after.status, 0, after.stdout + after.stderr);
  assert.equal(delivered(), sendsBefore + 1, '이제 창 전달 send 1건');
  const typedFile = path.join(w.work, 'typed.txt');
  for (let i = 0; i < 50 && !(fs.existsSync(typedFile) && fs.readFileSync(typedFile, 'utf8').includes('본문3')); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  assert.match(fs.readFileSync(typedFile, 'utf8'), /본문3/);
});

test('restart: 마지막 start의 작업 폴더가 KADAN_HOME 안이면 끄기 전에 거절한다', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-trust-restart-')));
  const cwd = path.join(home, 'cards/x');
  fs.mkdirSync(cwd, {recursive: true});
  const entries = [{kind: 'start', floor: 'tmux', role: 'w', session: 'kadan-w', cmd: 'claude --model claude-haiku-5-5 --effort low', cwd,
    panePid: '100', roleProfile: 'worker', by: 'boss', t: '2026-10-14T00:00:00Z'}];
  const log = [];
  const floor = {name: 'tmux', alive: () => true, pid: () => '100', stop: () => log.push('stop'), create: () => { log.push('create'); return {panePid: '2'}; }};
  const deps = {read: () => entries, record: () => log.push('record'), pendingCards: () => [], closeWindow: () => ({}), openWindow: () => ({}),
    paneInfo: () => ({panePid: '100', location: 'kadan-w:@1.%1'}), processTree: () => [], openFiles: () => [], readJson: () => ({}), homeDir: home};
  assert.throws(() => restartRole({home, role: 'w', session: 'kadan-w', flags: {}, floor, settings: settingsWith(), deps}),
    /작업 폴더가 카단 기록 폴더\(.+\) 안이다 — 작업 저장소\(worktree\)에서 다시 실행하라/);
  assert.deepEqual(log, [], '끄기·만들기·기록 0');
});
