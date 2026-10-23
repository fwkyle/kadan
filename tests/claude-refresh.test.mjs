import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {STATE_CHANGED_CODE} from '../src/restart.mjs';
import {confirmIdleBeforeStop} from '../src/commands/restart.mjs';
import {buildPreview, previewRow, runRefresh, formatRefreshResult, screenEnd, parseRoleList, HUMAN_ONLY_MESSAGE, formatPreview, previewJson, readAccounts, claudeLimitMatch, claudeScreenTail, scrubText} from '../src/claude-refresh.mjs';

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
  assert.match(formatPreview(rows, null), /다시 켜기 대상\(카드 2건 — 다시 켜도 카드는 그대로 남는다\)/);
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
  for (const args of [['refresh', '--yes'], ['refresh', '--yes', '--switch'], ['refresh', '--switch', '2'], ['refresh', '--yes', '--role', 'a', '--interval', '-1'], ['refresh', '--yes', '--role'], ['refresh', '--reason', 'x'], ['refresh', '--select', 'login'], ['refresh', '--select', 'x'], []]) {
    const r = runCli(args);
    assert.equal(r.status, 2, args.join(' ') + r.stderr);
  }
  assert.match(runCli(['refresh', '--select', 'login']).stderr, /로그인 만료 문구 미확보/);
  assert.match(runCli(['refresh', '--yes']).stderr, /사람이 --role/);
  assert.match(runCli(['refresh', '--yes', '--switch']).stderr, /PR-3/);
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

test('실측 2.1.308(이미지에서 옮겨 적음): 한도 머리줄 + ⎿ 둘째 줄이 사용자 입력 뒤에 반복돼도 ●·⏺ 모두 한도로 보임, 초기화 줄은 둘째 줄', () => {
  for (const name of ['real-2.1.308-bullet', 'real-2.1.308-tmux']) {
    const row = preview(world([{role: 'a', screen: SCREENS[name]}]))[0];
    assert.equal(row.verdict, 'target', name); assert.equal(row.reason, '한도로 보임(규칙)', name);
    assert.equal(row.resetLine, "⎿ You've hit your session limit · resets 12:40pm (Asia/Seoul)", name);
    assert.equal(row.screenTail.length, 4, name);
  }
});

test('한도 머리말로 시작하는 ⏺ 줄 예외는 일반 응답 문맥 제외를 넓히지 않는다', () => {
  // 머리줄이 한도 머리말이 아닌 ⏺ 응답 + ⎿ 한도 줄은 여전히 대상이 아니다(neg-attached-tool-output과 같은 구조).
  const screen = SCREENS['real-2.1.308-tmux'].replaceAll('⏺ Usage limit reached again · continuing automatically at 12:40pm · esc to cancel', '⏺ 로그를 읽었습니다');
  assert.equal(preview(world([{role: 'a', screen}]))[0].verdict, 'none');
});

// ---- 수정 4: 화면에서 온 모든 글은 가림 함수 한 곳을 지난다 (재검수 F8·F9) ----
// 합성 값만 쓴다. 비밀 스캐너에 걸리지 않게 조각을 이어 붙여 만든다.
const SYN = {
  bearer: 'Bearer ' + 'sk-ant-api03-' + 'A1b2C3d4'.repeat(4),
  sk: 'sk-' + 'Zz9Yy8Xx7W'.repeat(3),
  gh: 'ghp_' + 'Qq1Ww2Ee3R'.repeat(3),
  discord: 'M'.repeat(24) + '.' + 'abcdef' + '.' + 'x'.repeat(30),
  webhook: 'https://discord.com/api/webhooks/123456/' + 'tok'.repeat(10),
  mail: 'someone.private@example.test',
};
const dirty = (extra = '') => [
  `❯ old input ${SYN.bearer}`, `  Authorization: ${SYN.bearer}`, `  TOKEN=${SYN.sk} ${SYN.gh}`, `  ${SYN.discord} ${SYN.webhook}`,
  `You've hit your session limit · resets 3pm ${SYN.mail} ${SYN.bearer}${extra}`,
].join('\n') + '\n' + SCREENS['pos-plain'].split('\n').slice(-9).join('\n');
const leaks = (text) => Object.entries(SYN).filter(([, v]) => text.includes(v.replace(/^Bearer /, '')) || text.includes(v)).map(([k]) => k);

test('F8·F9: 원문 줄·초기화 줄의 토큰·이메일이 표·--json 어디에도 원문으로 나오지 않는다', () => {
  const rows = preview(world([{role: 'a', screen: dirty()}]));
  assert.equal(rows[0].verdict, 'target');
  assert.ok(rows[0].screenTail.length > 0 && rows[0].resetLine);
  const everything = formatPreview(rows, null) + JSON.stringify(previewJson(rows, null));
  assert.deepEqual(leaks(everything), []);
  assert.ok(!everything.includes('@'), 'at-sign 없음');
  assert.match(rows[0].resetLine, /resets 3pm/); // 가린 뒤에도 초기화 시각은 남는다
});

test('F8: --select all 평범한 입력 대기 화면의 토큰 줄도 가려진다', () => {
  const screen = `⏺ TOKEN=${SYN.sk}\n  ${SYN.bearer}\n` + SCREENS['idle-plain'];
  const rows = preview(world([{role: 'a', screen}]), {select: 'all'});
  assert.equal(rows[0].verdict, 'target');
  assert.deepEqual(leaks(formatPreview(rows, null) + JSON.stringify(previewJson(rows, null))), []);
});

test('가림 뒤에 자른다: 120자 경계에 걸친 토큰 조각이 남지 않는다', () => {
  const token = 'sk-' + 'Zz9Yy8Xx7W'.repeat(3); // 33자
  const line = 'p'.repeat(100) + ' ' + token; // 토큰이 100~134번째 글자에 걸친다
  const screen = `${line}\n` + SCREENS['pos-plain'];
  const tail = claudeScreenTail(screen).join('\n');
  assert.ok(!tail.includes('sk-'), tail);
});

test('오류 이유(화면 읽기 실패)에 든 토큰·이메일도 가려진다', () => {
  const w = world([{role: 'a', screen: '', failRead: true}]);
  w.floor.read = () => { throw new Error(`boom ${SYN.bearer} ${SYN.mail}`); };
  const rows = preview(w);
  assert.equal(rows[0].verdict, 'skip');
  assert.deepEqual(leaks(rows[0].reason + formatPreview(rows, null) + JSON.stringify(previewJson(rows, null))), []);
  assert.match(rows[0].reason, /^화면 읽기 실패\(/);
});

test('실제 CLI: 정상 경로에서 stderr는 비어 있다', () => {
  const r = runCli(['refresh', '--no-accounts']);
  assert.equal(r.status, 0); assert.equal(r.stderr, '');
});

test('운영 화면의 가짜 양성 2개(문구를 인용한 화면)는 대상이 아니다 — 감독 답변 안 인용 / 검수자의 Search 인용', () => {
  for (const name of ['sample-neg-quote-in-reply', 'sample-neg-codex-search-quote']) {
    assert.equal(claudeLimitMatch(SCREENS[name]), null, name);
    const row = preview(world([{role: 'a', screen: SCREENS[name]}]))[0];
    assert.notEqual(row.verdict, 'target', name); assert.deepEqual(row.screenTail, [], name);
  }
});

test('고정물 전체가 가림 함수를 지나도 바뀌지 않고 이메일 꼴이 없다', () => {
  for (const [name, screen] of Object.entries(SCREENS)) {
    if (name.startsWith('_')) continue;
    assert.equal(scrubText(screen), screen, name); assert.ok(!screen.includes('@'), name);
  }
});

// ---- 2단계: 사람이 --role로 고른 세션만 다시 켜기 (가짜 바닥·가짜 restart·가짜 시계) ----
function refreshRig(roles, {restartFail = {}} = {}) {
  const w = world(roles);
  const calls = [], sleeps = [];
  let clock = 0;
  const sleep = (ms) => { sleeps.push(ms); clock += ms; };
  const restart = ({role, session, flags}) => {
    calls.push({role, session, flags});
    if (restartFail[role]) throw new Error(restartFail[role]);
    return {panePid: '200', conversation: 'conv-' + role};
  };
  const run = (chosen, extra = {}) => runRefresh({roles: chosen, entriesOf: () => w.entries, floor: w.floor, pendingCards: (_, role) => extra.cards?.[role] ?? [],
    restart, sleep, now: () => clock, self: 'me', ...extra.opts});
  return {w, calls, sleeps, run};
}
const IDLE = SCREENS['idle-plain'];

test('--yes --role: idle이면 restart를 accountRefresh로 부르고 카드 목록·이유·계정 번호를 넘긴다(forced 아님)', () => {
  const r = refreshRig([{role: 'a', screen: IDLE}]);
  const results = r.run(['a'], {cards: {a: ['c1', 'c2']}, opts: {reason: '한도', accountSlot: 2}});
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0].flags, {accountRefresh: true, reason: '한도', accountSlot: 2});
  assert.equal(r.calls[0].flags.force, undefined);
  assert.deepEqual([results[0].outcome, results[0].cards, results[0].panePid], ['restarted', ['c1', 'c2'], '200']);
});

test('--role 없이 고르지 않은 세션은 건드리지 않는다 — 한도로 보이는 세션이 있어도 고른 것만', () => {
  const r = refreshRig([{role: 'a', screen: IDLE}, {role: 'b', screen: SCREENS['pos-plain']}]);
  r.run(['a']);
  assert.deepEqual(r.calls.map(c => c.role), ['a']);
});

test('건너뜀: working·unknown·생존 불일치·codex·비서·자기 자신·살아 있지 않은 역할 → restart 0회', () => {
  const r = refreshRig([
    {role: 'work', screen: SCREENS['neg-working']}, {role: 'unk', screen: SCREENS.unknown}, {role: 'pid', screen: IDLE},
    {role: 'cx', cmd: CODEX, screen: IDLE}, {role: '비서', profile: 'secretary', screen: IDLE}, {role: 'me', screen: IDLE},
  ]);
  r.w.entries.find(e => e.role === 'pid').panePid = '999';
  const results = r.run(['work', 'unk', 'pid', 'cx', '비서', 'me', 'ghost']);
  assert.equal(r.calls.length, 0);
  assert.deepEqual(results.map(x => [x.role, x.outcome]), [['work', 'skipped'], ['unk', 'skipped'], ['pid', 'skipped'], ['cx', 'skipped'], ['비서', 'skipped'], ['me', 'skipped'], ['ghost', 'skipped']]);
  assert.match(results[0].reason, /응답 생성 중/); assert.match(results[1].reason, /판정 불가/); assert.match(results[2].reason, /생존 확인 실패/);
  assert.match(results[3].reason, /다른 실행기\(codex\)/); assert.match(results[4].reason, /비서/); assert.match(results[5].reason, /자기 자신/); assert.match(results[6].reason, /살아 있는 역할이 아님/);
});

test('직전 확인은 restart 직전에 화면을 다시 읽는다 — 앞 역할을 켜는 사이 working으로 바뀐 역할은 건너뛴다', () => {
  const r = refreshRig([{role: 'a', screen: IDLE}, {role: 'b', screen: IDLE}]);
  const original = r.w.floor.read;
  r.w.floor.read = (session) => (r.calls.length >= 1 && session === 'kadan-b' ? SCREENS['neg-working'] : original(session));
  const results = r.run(['a', 'b']);
  assert.deepEqual(r.calls.map(c => c.role), ['a']);
  assert.deepEqual(results.map(x => x.outcome), ['restarted', 'skipped']);
});

test('두 번째 역할이 실패하면 세 번째는 하지 않고 표에 안 함으로 남는다 — 원인 모르는 실패는 재시도 없음', () => {
  const r = refreshRig([{role: 'a', screen: IDLE}, {role: 'b', screen: IDLE}, {role: 'c', screen: IDLE}], {restartFail: {b: '직접 복구: cd /x && claude --resume y'}});
  const results = r.run(['a', 'b', 'c']);
  assert.deepEqual(r.calls.map(c => c.role), ['a', 'b']);
  assert.deepEqual(results.map(x => x.outcome), ['restarted', 'failed', 'not-run']);
  assert.match(results[1].reason, /직접 복구/);
  const text = formatRefreshResult(results);
  assert.match(text, /실패/); assert.match(text, /안 함/); assert.match(text, /재시도하지 않는다/);
});

test('간격: 켠 역할 뒤 다음 확인 앞에서 interval초를 쉰다(첫 역할 앞·마지막 뒤는 없음, 연속 두 번 쉬지 않음)', () => {
  const r = refreshRig([{role: 'a', screen: IDLE}, {role: 'skip', screen: SCREENS['neg-working']}, {role: 'b', screen: IDLE}, {role: 'c', screen: IDLE}]);
  r.run(['a', 'skip', 'b', 'c'], {opts: {intervalSec: 5}});
  assert.deepEqual(r.calls.map(c => c.role), ['a', 'b', 'c']);
  assert.equal(r.sleeps.filter(ms => ms === 5000).length, 2, '켠 세 역할 사이 두 번');
});

test('F1 재현 1: 간격 대기 중 working으로 바뀐 역할은 쉰 뒤 확인에서 걸려 restart 0회이고 다음 역할은 계속된다', () => {
  const r = refreshRig([{role: 'a', screen: IDLE}, {role: 'b', screen: IDLE}, {role: 'c', screen: IDLE}]);
  const original = r.w.floor.read;
  let rested = false;
  r.w.floor.read = (session) => (session === 'kadan-b' && rested ? SCREENS['neg-working'] : original(session));
  const results = r.run(['a', 'b', 'c'], {opts: {sleep: (ms) => { rested = true; r.sleeps.push(ms); }}});
  assert.deepEqual(r.calls.map(c => c.role), ['a', 'c']);
  assert.deepEqual(results.map(x => x.outcome), ['restarted', 'skipped', 'restarted']);
  assert.match(results[1].reason, /응답 생성 중/);
});

test('끄기 직전 재확인이 막은 역할(상태 바뀜 코드)은 실패가 아니라 건너뜀이고 멈추지 않는다', () => {
  const r = refreshRig([{role: 'a', screen: IDLE}, {role: 'b', screen: IDLE}]);
  const calls = [];
  const results = runRefresh({roles: ['a', 'b'], entriesOf: () => r.w.entries, floor: r.w.floor, pendingCards: () => [], self: 'me',
    sleep: () => {}, now: () => 0, restart: ({role}) => {
      calls.push(role);
      if (role === 'a') { const e = new Error('건너뜀: 확인 뒤 상태 바뀜(입력 중: 사람이 최근 입력함)'); e.code = STATE_CHANGED_CODE; throw e; }
      return {panePid: '300'};
    }});
  assert.deepEqual(calls, ['a', 'b']);
  assert.deepEqual(results.map(x => x.outcome), ['skipped', 'restarted']);
  assert.match(results[0].reason, /상태 바뀜/);
});

test('끄기 직전 확인(confirmIdleBeforeStop): idle+사람 없음만 통과, working·미확인·입력 중은 던진다', () => {
  const mk = (screen, humanError) => ({read: () => screen, assertHumanIdle: () => { if (humanError) throw humanError; }});
  assert.doesNotThrow(() => confirmIdleBeforeStop('s', mk(IDLE)));
  assert.throws(() => confirmIdleBeforeStop('s', mk(SCREENS['neg-working'])), /working/);
  assert.throws(() => confirmIdleBeforeStop('s', mk(SCREENS.unknown)), /판정 불가/);
  assert.throws(() => confirmIdleBeforeStop('s', mk(null)), /판정 불가/);
  const active = Object.assign(new Error('전송 보류'), {code: 'KADAN_HUMAN_ACTIVE'});
  assert.throws(() => confirmIdleBeforeStop('s', mk(IDLE, active)), /입력 중/);
  assert.throws(() => confirmIdleBeforeStop('s', mk(IDLE, new Error('x'))), /판정 불가/);
  assert.throws(() => confirmIdleBeforeStop('s', {read: () => IDLE}), /판정 불가/);
});

test('다시 켠 뒤 화면: 안정되면 그때 읽고(ready), 30초 안에 안 되면 시간 초과 화면을 싣는다 — 이메일은 가린다', () => {
  const loading = 'Resuming conversation…\nloading someone@example.test';
  const rig = (screenAfter) => {
    const r = refreshRig([{role: 'a', screen: IDLE}]);
    let restarted = false;
    r.w.floor.read = () => (restarted ? screenAfter() : IDLE);
    let clock = 0;
    const results = runRefresh({roles: ['a'], entriesOf: () => r.w.entries, floor: r.w.floor, pendingCards: () => [], self: 'me',
      sleep: (ms) => { clock += ms; }, now: () => clock, restart: () => { restarted = true; return {panePid: '300'}; }});
    return {result: results[0], clock};
  };
  const stuck = rig(() => loading);
  assert.equal(stuck.result.screenState, 'timeout');
  assert.ok(stuck.clock >= 30_000 && stuck.clock <= 32_000, '약 30초 읽는다');
  assert.ok(stuck.result.screenEnd.length > 0 && stuck.result.screenEnd.every(line => !line.includes('@')));
  let polls = 0;
  const slow = rig(() => (++polls >= 3 ? IDLE : loading));
  assert.equal(slow.result.screenState, 'ready');
  assert.ok(slow.clock < 10_000, '안정되면 바로 멈춘다');
  assert.ok(screenEnd(SCREENS['pos-plain']).length <= 4);
});

test('--role 값 검사: 세션 이름은 역할 이름 안내와 함께 거절, 중복·빈 이름도 거절', () => {
  const roles = new Set(['Dongkyoung-결함수정-감독']), sessions = new Set(['kadan-Dongkyoung-결함수정-감독']);
  assert.throws(() => parseRoleList('kadan-Dongkyoung-결함수정-감독', roles, sessions), /세션 이름이다.*Dongkyoung-결함수정-감독/);
  assert.deepEqual(parseRoleList('Dongkyoung-결함수정-감독, a', roles, sessions), ['Dongkyoung-결함수정-감독', 'a']);
  assert.throws(() => parseRoleList('a,a', roles, sessions), /두 번/);
  assert.throws(() => parseRoleList('a,,b', roles, sessions), /빈 이름/);
  assert.throws(() => parseRoleList(true, roles, sessions), /역할 이름이 필요/);
});

test('역할 세션 안(KADAN_ROLE)에서는 --yes를 거절하고 아무것도 하지 않는다', () => {
  const r = runCli(['refresh', '--yes', '--role', 'a'], {KADAN_ROLE: 'some-role'});
  assert.equal(r.status, 2); assert.ok(r.stderr.includes(HUMAN_ONLY_MESSAGE));
  assert.ok(!fs.existsSync(path.join(r.home, 'ledger.jsonl')) || fs.readFileSync(path.join(r.home, 'ledger.jsonl'), 'utf8') === '');
});

test('--role만(--yes 없음): 고른 역할만 미리보기로 보이고 없는 역할은 건너뜀으로 보인다', () => {
  const r = runCli(['refresh', '--role', 'ghost', '--no-accounts']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^미리보기 — 아무것도 바꾸지 않음/); assert.match(r.stdout, /ghost/); assert.match(r.stdout, /살아 있는 역할이 아님/);
});

test('--yes --role ghost(빈 바닥): 켠 것 없이 건너뜀 표로 끝난다(exit 0)', () => {
  const r = runCli(['refresh', '--yes', '--role', 'ghost', '--no-accounts']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /계정 전환 재시작 결과/); assert.match(r.stdout, /다시 켬 0 · 건너뜀 1 · 실패 0 · 안 함 0/);
});
