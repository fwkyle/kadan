import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildPreview, formatPreview, previewJson, readAccounts, claudeLimitMatch, claudeScreenTail} from '../src/claude-refresh.mjs';

const SCREENS = JSON.parse(fs.readFileSync(new URL('./fixtures/claude-limit-screens.json', import.meta.url), 'utf8'));
const CLAUDE = 'claude --model claude-haiku-5-5 --effort low';
const CODEX = 'codex -p lite --model gpt-6-sol';
const EMAIL = 'someone@example.test';

// 가짜 바닥: read만 화면을 주고 send는 호출되면 기록한다(미리보기는 0이어야 한다).
function world(roles) {
  const entries = [], keys = [], screens = {};
  const live = [];
  for (const r of roles) {
    const session = `kadan-${r.role}`;
    if (!r.noStart) entries.push({kind: 'start', floor: 'tmux', role: r.role, session, cmd: r.cmd ?? CLAUDE, panePid: String(r.pid ?? 100), roleProfile: r.profile ?? 'worker', t: '2026-10-23T00:00:00Z'});
    screens[session] = r.screen;
    live.push({session, alive: true, pid: String(r.pid ?? 100), failRead: r.failRead});
  }
  const floor = {name: 'tmux', list: () => live, alive: () => true, pid: s => live.find(i => i.session === s).pid,
    read: s => { const i = live.find(x => x.session === s); if (i.failRead) throw new Error('tmux 읽기 실패'); return screens[s]; },
    send: (...a) => keys.push(a), sendEnter: (...a) => keys.push(a)};
  return {entries, floor, keys, snapshot: JSON.stringify(entries)};
}
const preview = (w, extra = {}) => buildPreview({entries: w.entries, floor: w.floor, pendingCards: (_, role) => (extra.cards?.[role] ?? []), self: extra.self ?? 'me', select: extra.select ?? 'limit'});
const rowOf = (rows, role) => rows.find(r => r.role === role);

test('양성: 줄 맨 앞이 한도 머리말이면 대상 — 기호 없음·⏺·⎿·둘째 줄 안내·reached·Usage limit', () => {
  for (const name of Object.keys(SCREENS).filter(k => k.startsWith('pos-'))) { // pos-after-* 는 F6 양성
    const rows = preview(world([{role: 'a', screen: SCREENS[name]}]));
    assert.equal(rows[0].verdict, 'target', name); assert.equal(rows[0].reason, '한도로 보임(규칙)', name);
  }
});

test('양성 세부: 초기화 줄 원문·카드 수·둥근 아포스트로피·조치 문구', () => {
  const w = world([{role: 'a', screen: SCREENS['pos-plain']}, {role: 'b', screen: SCREENS['pos-two-lines']}, {role: 'c', screen: SCREENS['pos-reached']}]);
  const rows = preview(w, {cards: {a: ['c1', 'c2']}});
  assert.equal(rowOf(rows, 'a').resetLine, "You've hit your session limit · resets 3pm (Asia/Seoul)");
  assert.equal(rowOf(rows, 'a').cards, 2);
  assert.equal(rowOf(rows, 'b').resetLine, '⏺ You’ve hit your session limit · resets 3pm'); // 줄 원문 그대로(앞 공백만 뺌)
  assert.equal(rowOf(rows, 'c').resetLine, null);
  assert.match(formatPreview(rows, null), /다시 켜기 대상\(카드 2건 — 카드 유지 재시작은 kyle 결정 대기\)/);
});

test('음성: 목록·본문·번호·표·인용·울타리·백틱·떨어진 도구 출력·사이에 낀 응답/입력 → 대상 아님(검수 F1 재현 포함)', () => {
  for (const name of Object.keys(SCREENS).filter(k => k.startsWith('neg-') && k !== 'neg-working')) {
    assert.equal(claudeLimitMatch(SCREENS[name]), null, name);
    assert.equal(preview(world([{role: 'a', screen: SCREENS[name]}]))[0].verdict, 'none', name);
  }
});

test('음성: 일하는 중이면 한도 문구가 있어도 건너뜀(응답 생성 중)', () => {
  const rows = preview(world([{role: 'a', screen: SCREENS['neg-working']}]));
  assert.deepEqual([rows[0].verdict, rows[0].reason], ['skip', '응답 생성 중']);
});

test('제외: codex·비서·자기 자신·실행기 모름·기반(원장 start 없음)', () => {
  const w = world([
    {role: 'x', cmd: CODEX, screen: SCREENS['pos-plain']},
    {role: '비서', profile: 'secretary', screen: SCREENS['pos-plain']},
    {role: 'me', screen: SCREENS['pos-plain']},
    {role: 'u', cmd: 'zsh -l', screen: SCREENS['pos-plain']},
    {role: 'dashboard', noStart: true, screen: SCREENS['pos-plain']},
  ]);
  const rows = preview(w);
  assert.deepEqual(rows.map(r => [r.role, r.verdict, r.reason]), [
    ['x', 'excluded', '다른 실행기(codex)'], ['비서', 'excluded', '비서'], ['me', 'excluded', '자기 자신'],
    ['u', 'excluded', '실행기 모름'], ['dashboard', 'excluded', '기반']]);
});

test('화면 읽기 실패는 그 줄만 건너뜀이고 나머지는 계속된다', () => {
  const rows = preview(world([{role: 'a', failRead: true, screen: ''}, {role: 'b', screen: SCREENS['pos-plain']}]));
  assert.equal(rowOf(rows, 'a').verdict, 'skip'); assert.match(rowOf(rows, 'a').reason, /^화면 읽기 실패\(/);
  assert.equal(rowOf(rows, 'b').verdict, 'target');
});

test('생존 확인(pane PID 대조) 실패 → 건너뜀', () => {
  const w = world([{role: 'a', screen: SCREENS['pos-plain']}]);
  w.entries[0].panePid = '999';
  assert.deepEqual([preview(w)[0].verdict, preview(w)[0].reason], ['skip', '생존 확인 실패']);
});

test('--select all: 입력 대기 → 대상, limit이면 해당 없음, 알 수 없는 화면 → 건너뜀', () => {
  const w = world([{role: 'a', screen: SCREENS['idle-plain']}, {role: 'b', screen: SCREENS.unknown}]);
  assert.deepEqual([preview(w, {select: 'all'})[0].verdict, preview(w, {select: 'all'})[0].reason], ['target', '입력 대기']);
  assert.equal(preview(w)[0].verdict, 'none');
  assert.deepEqual([preview(w)[1].verdict, preview(w)[1].reason], ['skip', '판정 불가']);
});

test('원장·바닥 무변화: 미리보기는 사건을 쓰지 않고 키를 한 번도 보내지 않는다', () => {
  const w = world([{role: 'a', screen: SCREENS['pos-plain']}, {role: 'b', screen: SCREENS['idle-plain']}]);
  preview(w); preview(w, {select: 'all'});
  assert.equal(JSON.stringify(w.entries), w.snapshot);
  assert.equal(w.keys.length, 0);
});

test('--json 모양: 영어 camelCase 키 배열과 개수', () => {
  const rows = preview(world([{role: 'a', screen: SCREENS['pos-plain']}, {role: 'b', cmd: CODEX, screen: ''}]));
  const json = previewJson(rows, null);
  assert.deepEqual(Object.keys(json.rows[0]).sort(), ['cards', 'harness', 'model', 'reason', 'resetLine', 'role', 'screenTail', 'session', 'verdict']);
  assert.deepEqual(json.counts, {target: 1, skip: 0, excluded: 1, none: 0});
  assert.equal(json.preview, true);
});

// ---- 계정 칸: 가짜 claude-swap ----
function fakeSwap(stdout, {status = 0, error} = {}) {
  return () => ({stdout, status, error});
}
const account = (n, extra = {}) => ({number: n, email: EMAIL, organizationName: 'Org', organizationUuid: 'uuid-x', isOrganization: false, active: n === 2, usageStatus: 'ok',
  usage: {fiveHour: {pct: 30, resetsAt: 'x', countdown: '4h 32m', clock: '5pm'}, sevenDay: {pct: 81, resetsAt: 'y', countdown: '2d 1h', clock: 'z', expectedPct: 50, aheadOfPace: true, projectedExhaustionAt: 'q', willLastToReset: false}}, ...extra});
const good = JSON.stringify({schemaVersion: 1, activeAccountNumber: 2, accounts: [account(1), account(2), account(3, {usageStatus: 'http-429', usage: null})], unclaimedCredentials: [{email: EMAIL}]});

test('계정 한도: 남은 %는 100-사용%, 조회 실패 칸만 실패, 이메일은 어디에도 없다', () => {
  const accounts = readAccounts({run: fakeSwap(good)});
  assert.equal(accounts.ok, true);
  assert.deepEqual([accounts.accounts[0].fiveHourLeftPct, accounts.accounts[0].sevenDayLeftPct, accounts.accounts[0].fiveHourResetsIn], [70, 19, '4h 32m']);
  assert.equal(accounts.accounts[1].active, true);
  assert.equal(accounts.accounts[2].status, '조회 실패(http-429)');
  const rows = preview(world([{role: 'a', screen: SCREENS['pos-plain']}]));
  const everything = formatPreview(rows, accounts) + JSON.stringify(previewJson(rows, accounts));
  assert.ok(!everything.includes(EMAIL) && !everything.includes('uuid-x') && !everything.includes('Org'));
  assert.match(formatPreview(rows, accounts), /활성 계정 = 새로 켜는 세션이 쓸 계정, 이미 켜진 세션은 옛 로그인일 수 있음/);
  assert.match(formatPreview(rows, accounts), /5시간 남은/);
});

test('계정 한도: 명령 없음·실패·시간 초과·모양 다름·키 누락은 한 줄로 끝나고 표는 살아 있다', () => {
  const cases = [
    [fakeSwap('', {error: Object.assign(new Error('x'), {code: 'ENOENT'})}), /claude-swap 없음/],
    [fakeSwap('', {error: Object.assign(new Error('x'), {code: 'ETIMEDOUT'})}), /시간 초과/],
    [fakeSwap('', {status: 1}), /종료 코드 1/],
    [fakeSwap('not json'), /JSON 아님/],
    [fakeSwap('{"foo":1}'), /모양 다름/],
    [fakeSwap(JSON.stringify({accounts: [{email: EMAIL}]})), /모양 다름/],
  ];
  const rows = preview(world([{role: 'a', screen: SCREENS['pos-plain']}]));
  for (const [run, pattern] of cases) {
    const accounts = readAccounts({run});
    assert.equal(accounts.ok, false);
    const text = formatPreview(rows, accounts);
    assert.match(text, /계정 한도: 읽지 못함\(/); assert.match(text, pattern); assert.match(text, /a\s+kadan-a/);
    assert.ok(!text.includes(EMAIL));
  }
});

test('usage가 비어 있는 계정(키 누락)도 표를 깨지 않는다', () => {
  const accounts = readAccounts({run: fakeSwap(JSON.stringify({accounts: [{number: 1, usageStatus: 'ok'}]}))});
  assert.equal(accounts.ok, true); assert.match(accounts.accounts[0].status, /^조회 실패/);
});

// ---- 명령 연결: 격리 소켓의 실제 CLI ----
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
function runCli(args, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-claude-refresh-'));
  const result = spawnSync(process.execPath, [cli, 'claude', ...args], {encoding: 'utf8', timeout: 30000,
    env: {...process.env, KADAN_HOME: home, KADAN_SOCKET: `t-refresh-${process.pid}`, KADAN_WINDOW: 'none', KADAN_NOTIFY: 'off', PATH: `${home}/bin:${process.env.PATH}`, ...env}});
  return {...result, home};
}

test('--yes·--switch·--select login·잘못된 인자는 exit 2이고 원장을 만들지 않는다', () => {
  for (const args of [['refresh', '--yes'], ['refresh', '--switch', '2'], ['refresh', '--select', 'login'], ['refresh', '--select', 'x'], []]) {
    const r = runCli(args);
    assert.equal(r.status, 2, args.join(' ') + r.stderr);
  }
  assert.match(runCli(['refresh', '--select', 'login']).stderr, /로그인 만료 문구 미확보/);
  assert.match(runCli(['refresh', '--yes']).stderr, /PR-2\/PR-3/);
});

test('실제 CLI(격리 홈·빈 바닥): 미리보기 머리말, --json, --no-accounts, 이메일 없음', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-fake-swap-'));
  fs.writeFileSync(path.join(bin, 'claude-swap'), `#!/bin/sh\ncat <<'EOF'\n${good}\nEOF\n`, {mode: 0o755});
  const env = {PATH: `${bin}:${process.env.PATH}`};
  const text = runCli(['refresh'], env);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^미리보기 — 아무것도 바꾸지 않음/);
  assert.match(text.stdout, /대상 0 · 건너뜀 0 · 제외 0 · 해당 없음 0/);
  assert.match(text.stdout, /5시간 남은/); assert.ok(!text.stdout.includes(EMAIL));
  const json = JSON.parse(runCli(['refresh', '--json'], env).stdout);
  assert.equal(json.preview, true); assert.equal(json.accounts.ok, true); assert.ok(!JSON.stringify(json).includes(EMAIL));
  assert.equal(runCli(['refresh', '--json', '--no-accounts'], env).stdout.includes('"accounts": null'), true);
  assert.ok(!fs.existsSync(path.join(text.home, 'ledger.jsonl')) || fs.readFileSync(path.join(text.home, 'ledger.jsonl'), 'utf8') === '');
});

// ---- 검수 수정: F2 이메일 방어 · claude-swap 찾기 · F4 옵션 검사 ----
const LEAK = 'leak@example.test';
const everywhere = (accounts) => {
  const rows = preview(world([{role: 'a', screen: SCREENS['pos-plain']}]));
  return formatPreview(rows, accounts) + JSON.stringify(previewJson(rows, accounts));
};

test('F2: countdown·usageStatus에 이메일이 섞여도 표와 --json 어디에도 안 나온다', () => {
  const bad = {...account(1), usage: {fiveHour: {pct: 10, countdown: LEAK}, sevenDay: {pct: 20, countdown: `4h ${LEAK}`, willLastToReset: true}}};
  const badStatus = account(2, {usageStatus: LEAK, usage: null});
  const accounts = readAccounts({run: fakeSwap(JSON.stringify({accounts: [bad, badStatus, account(3, {usageStatus: 'rate_limited'})]})), home: '/nonexistent'});
  assert.equal(accounts.ok, true);
  assert.equal(accounts.accounts[0].fiveHourResetsIn, '?'); assert.equal(accounts.accounts[0].sevenDayResetsIn, '?');
  assert.equal(accounts.accounts[1].status, '조회 실패(기타)');
  assert.equal(accounts.accounts[2].status, '조회 실패(rate_limited)');
  assert.ok(!everywhere(accounts).includes('@'), 'at-sign 없음');
});

test('F2: 예외·오류의 message 원문은 싣지 않고 정해진 짧은 코드만 낸다', () => {
  for (const [error, reason] of [[Object.assign(new Error(LEAK), {code: 'EACCES'}), '실행 실패'], [Object.assign(new Error(LEAK), {code: 'ENOENT'}), 'claude-swap 없음'], [Object.assign(new Error(LEAK), {code: 'ETIMEDOUT'}), '시간 초과']]) {
    const accounts = readAccounts({run: fakeSwap('', {error}), home: '/nonexistent'});
    assert.equal(accounts.reason, reason);
    assert.ok(!everywhere(accounts).includes(LEAK));
  }
  const thrown = readAccounts({run: () => { throw Object.assign(new Error(LEAK), {code: 'EPERM'}); }, home: '/nonexistent'});
  assert.equal(thrown.reason, '실행 실패'); assert.ok(!everywhere(thrown).includes(LEAK));
  assert.equal(readAccounts({run: fakeSwap('', {status: 3}), home: '/nonexistent'}).reason, '종료 코드 3');
});

test('claude-swap 찾기: KADAN_CLAUDE_SWAP_BIN → PATH → ~/.local/bin, ENOENT이면 다음 후보', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-swap-home-'));
  fs.mkdirSync(path.join(home, '.local/bin'), {recursive: true});
  const local = path.join(home, '.local/bin/claude-swap');
  fs.writeFileSync(local, '#!/bin/sh\n', {mode: 0o755});
  const tried = [];
  const run = bin => { tried.push(bin); return bin === local ? {stdout: good, status: 0} : {error: {code: 'ENOENT'}, status: null}; };
  const accounts = readAccounts({run, home, env: {KADAN_CLAUDE_SWAP_BIN: '/nope/claude-swap'}});
  assert.equal(accounts.ok, true);
  assert.deepEqual(tried, ['/nope/claude-swap', 'claude-swap', local]);
  // 실행 파일이 아니면 후보에 넣지 않고, 다 없으면 한 줄로 끝난다.
  fs.chmodSync(local, 0o644);
  const none = readAccounts({run: () => ({error: {code: 'ENOENT'}}), home, env: {}});
  assert.deepEqual([none.ok, none.reason], [false, 'claude-swap 없음']);
  assert.equal(readAccounts({run: bin => bin === 'claude-swap' ? {stdout: good, status: 0} : {error: {code: 'ENOENT'}}, home, env: {}}).ok, true);
});

test('F2/F4 실제 CLI: 이메일이 든 가짜 claude-swap 출력은 stdout·stderr 어디에도 안 나오고, 알 수 없는 옵션은 exit 2', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-fake-swap-'));
  const payload = JSON.stringify({accounts: [{...account(1), usage: {fiveHour: {pct: 1, countdown: LEAK}, sevenDay: {pct: 2, countdown: '1d 2h'}}}, account(2, {usageStatus: LEAK, usage: null})]});
  fs.writeFileSync(path.join(bin, 'claude-swap'), `#!/bin/sh\ncat <<'EOF'\n${payload}\nEOF\n`, {mode: 0o755});
  for (const args of [['refresh'], ['refresh', '--json']]) {
    const r = runCli(args, {PATH: `${bin}:${process.env.PATH}`});
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!(r.stdout + r.stderr).includes('@'), args.join(' '));
  }
  for (const args of [['refresh', '--bogus', '--no-accounts'], ['refresh', '--jsno']]) {
    const r = runCli(args);
    assert.equal(r.status, 2, args.join(' ')); assert.match(r.stderr, /알 수 없는 옵션: --(bogus|jsno)/);
  }
  assert.equal(runCli(['refresh', '--no-accounts', '--select', 'all']).status, 0);
});

// ---- 수정 3: F6 고침 · F5·F7 알려진 한계(현재 동작 고정, 고쳐졌다고 단언하지 않음) · 원문 · 추정 ----
test('F6: 한도 줄 위쪽 탐색은 사용자 입력 줄·턴 끝 줄에서 멈춘다 → 이전 응답이 있어도 대상', () => {
  for (const name of ['pos-after-old-response', 'pos-after-turn-done']) {
    assert.equal(preview(world([{role: 'a', screen: SCREENS[name]}]))[0].verdict, 'target', name);
  }
});

test('F6 고치다 넓히지 않기: 한도 줄과 입력창 사이 입력·응답, 붙은 도구 출력, 목록·표는 그대로 대상 아님', () => {
  for (const name of Object.keys(SCREENS).filter(k => k.startsWith('neg-') && k !== 'neg-working')) {
    assert.equal(preview(world([{role: 'a', screen: SCREENS[name]}]))[0].verdict, 'none', name);
  }
});

test('알려진 한계 F5·F7 (현재 동작 고정): 여러 줄 응답 뒤 문구·응답 첫 줄 문구는 한도로 보일 수 있다', () => {
  for (const name of ['known-f5-multiline-response', 'known-f7-response-first-line']) {
    assert.equal(preview(world([{role: 'a', screen: SCREENS[name]}]))[0].verdict, 'target', name);
  }
});

test('원문: 대상과 입력 대기(all)에만 입력창 위 비지 않은 줄 최대 4줄(120자·이메일 꼴 삭제), 생성 중·제외·해당 없음은 비움', () => {
  const long = 'x'.repeat(200);
  const screen = `a1\n${long}\nmail me@example.test now\nb4\n${SCREENS['pos-plain']}`;
  const tail = claudeScreenTail(screen);
  assert.equal(tail.length, 4); assert.ok(tail.every(line => line.length <= 120));
  assert.ok(!tail.join('\n').includes('@'));
  assert.ok(!tail.some(line => /^─+$/.test(line)));
  const w = world([{role: 'a', screen: SCREENS['pos-plain']}, {role: 'b', screen: SCREENS['neg-working']}, {role: 'c', cmd: CODEX, screen: SCREENS['pos-plain']},
    {role: 'd', screen: SCREENS['idle-plain']}]);
  const rows = preview(w);
  assert.ok(rowOf(rows, 'a').screenTail.length > 0 && rowOf(rows, 'a').screenTail.length <= 4);
  assert.match(rowOf(rows, 'a').screenTail.join('\n'), /You've hit your session limit/);
  for (const role of ['b', 'c', 'd']) assert.deepEqual(rowOf(rows, role).screenTail, [], role);
  assert.ok(preview(w, {select: 'all'}).find(r => r.role === 'd').screenTail.length > 0);
  const text = formatPreview(rows, null);
  assert.match(text, /추정은 화면 글 규칙에 따른 추천이다\. 근거는 아래 원문을 직접 읽어 확인한다/);
  assert.match(text, /\[a\] 입력창 위 화면 원문/); assert.ok(!text.includes('[b] 입력창'));
  assert.match(text, /\s추정\s/); assert.ok(!text.includes('남은 시간'));
  assert.ok(!JSON.stringify(previewJson(rows, null)).includes('timeLeft'));
});
