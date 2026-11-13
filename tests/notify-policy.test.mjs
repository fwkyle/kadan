import './helpers/isolated-home.mjs';
import test, {afterEach} from 'node:test';
import {stopChild} from './helpers/child-cleanup.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {notifyUser, resetDiscordBlock, NOTIFY_LOG_FILE} from '../src/user-notify.mjs';
import {postPolicy, KNOWN_KINDS} from '../src/notify-policy.mjs';
import {setDecision, readDecisions} from '../src/notify-threads.mjs';
import {seedAlertState} from '../src/watch-alert-body.mjs';
import {dedupAlerts} from '../src/watch.mjs';

// 가짜 값만 쓴다. 이 시험 파일의 어떤 값도 실제 주소·ID가 아니다.
const helper = new URL('./helpers/fake-webhook.mjs', import.meta.url).pathname;
const live = [];
// world() 준비 중 실패해도 시험 종료 훅이 서버 종료를 기다리고 SIGKILL로 대체한다.
afterEach(async () => {
  await Promise.all(live.map(child => stopChild(child)));
  live.length = 0;
});
process.on('exit', () => { for (const c of live) c.kill('SIGKILL'); });

async function world() {
  resetDiscordBlock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-policy-test-'));
  const home = path.join(dir, 'home'), logFile = path.join(dir, 'requests.jsonl');
  fs.mkdirSync(home);
  const child = spawn(process.execPath, [helper, logFile, JSON.stringify([{status: 200, body: {id: 'M1', channel_id: 'C1'}}])], {stdio: ['ignore', 'pipe', 'inherit']});
  live.push(child);
  const port = await new Promise(resolve => child.stdout.once('data', d => resolve(Number(String(d).match(/PORT (\d+)/)[1]))));
  const envFile = path.join(dir, 'secret.env');
  fs.writeFileSync(envFile, `DISCORD_WEBHOOK_URL=http://127.0.0.1:${port}/api/webhooks/111/FAKETOKEN-policy\nDISCORD_USER_ID="424242424242"\n`);
  const env = {KADAN_NOTIFY: '', KADAN_NOTIFY_ENV_FILE: envFile};
  const requests = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const osCalls = [];
  const spawnFake = (cmd, args) => { osCalls.push({cmd, args}); return {status: 0}; };
  const log = () => fs.readFileSync(path.join(home, NOTIFY_LOG_FILE), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  return {home, env, requests, osCalls, spawnFake, log, stop: () => child.kill('SIGTERM')};
}

test('정책 표: 새 글은 결정·최상위 경보·되살리기 멈춤뿐이고 나머지와 모르는 종류는 안 보낸다', () => {
  for (const kind of ['decision-request', 'decision-answer', 'decision-cancel']) assert.equal(postPolicy({kind}).post, true, kind);
  assert.equal(postPolicy({kind: 'alert'}).post, true);
  assert.equal(postPolicy({kind: 'alert', overlap: true}).post, false);
  // 알림밀림: 입력 보호처럼 스스로 풀리는 사유만 안 보낸다. 신뢰 승인·모르는 사유·사유 없음은 새 글(PR #192 검수 F1).
  for (const holdCode of ['KADAN_HUMAN_ACTIVE', 'KADAN_HUMAN_ACTIVITY_UNKNOWN', 'KADAN_PANE_INPUT_PENDING', 'KADAN_PANE_INPUT_UNKNOWN'])
    assert.equal(postPolicy({kind: 'alert', alertKind: '알림밀림', holdCode}).post, false, holdCode);
  for (const holdCode of ['KADAN_HERDR_TRUST_PROMPT', 'KADAN_HERDR_NOT_READY', 'KADAN_HERDR_SCROLLED', 'KADAN_PANE_MODE_UNKNOWN', 'KADAN_PANE_IN_MODE', 'KADAN_NEW_CODE', undefined])
    assert.equal(postPolicy({kind: 'alert', alertKind: '알림밀림', holdCode}).post, true, String(holdCode));
  assert.equal(postPolicy({kind: 'alert', alertKind: '감시AI오류'}).post, true);
  for (const key of ['revive-corrupt', 'revive-stuck:watch', 'revive-capped:비서']) assert.equal(postPolicy({kind: 'revive', key}).post, true, key);
  assert.equal(postPolicy({kind: 'revive'}).post, false);
  assert.equal(postPolicy({kind: 'revive', key: 'revive-other'}).post, false);
  for (const kind of ['mail', 'handover', '새종류', undefined]) assert.equal(postPolicy({kind}).post, false, String(kind));
  assert.equal(postPolicy({kind: 'alert-resolved'}).post, false);
  assert.equal(postPolicy({kind: 'alert-resolved', hasPost: true}).post, true);
  // 프로세스·메모리 경보: 개수 기준만 넘은 AMBER는 안 보내고 RED는 보낸다. 다른 경보의 AMBER는 그대로 보낸다.
  assert.equal(postPolicy({kind: 'alert', alertKind: '프로세스', level: 'AMBER'}).post, false);
  assert.match(postPolicy({kind: 'alert', alertKind: '프로세스', level: 'AMBER'}).reason, /AMBER/);
  assert.equal(postPolicy({kind: 'alert', alertKind: '프로세스', level: 'RED'}).post, true);
  assert.equal(postPolicy({kind: 'alert', alertKind: '멈춤', level: 'AMBER'}).post, true);
  // 열린 경보 글 고치기는 고칠 글이 있을 때만이다.
  assert.equal(postPolicy({kind: 'alert-update'}).post, false);
  assert.equal(postPolicy({kind: 'alert-update', hasPost: true}).post, true);
});

test('안 보내는 종류는 디코 호출 0건·맥 알림 0건이고 notify-log에는 policy-skip 한 줄이 남는다', async () => {
  const w = await world();
  try {
    for (const [kind, extra] of [['mail', {key: 'mail:1'}], ['handover', {}], ['revive', {key: 'revive-x'}], ['alert', {overlap: true, key: 'alert:a:RED:겹알림'}]]) {
      const r = notifyUser('소식', w.spawnFake, {kind, ...extra, home: w.home, env: w.env});
      assert.equal(r.error, null, kind);
      assert.equal(r.discord.outcome, 'policy-skip', kind);
    }
    assert.equal(w.requests().length, 0);
    assert.equal(w.osCalls.length, 0);
    const rows = w.log();
    assert.equal(rows.length, 4);
    assert.ok(rows.every(row => row.outcome === 'policy-skip' && row.via === 'discord' && row.reason));
    assert.ok(!JSON.stringify(rows).includes('FAKETOKEN') && !JSON.stringify(rows).includes('424242424242'));
  } finally { w.stop(); }
});

test('새 글 대상은 그대로 한 번 나가고, 같은 입력에서 알림 기록 줄 수는 같고 디코 호출 수만 다르다', async () => {
  const w = await world();
  try {
    notifyUser('경보', w.spawnFake, {kind: 'alert', ring: true, key: 'alert:a:RED', home: w.home, env: w.env});
    notifyUser('겹알림', w.spawnFake, {kind: 'alert', ring: true, overlap: true, key: 'alert:a:RED:겹알림', home: w.home, env: w.env});
    notifyUser('멈춤', w.spawnFake, {kind: 'revive', ring: true, key: 'revive-capped:비서', home: w.home, env: w.env});
    assert.equal(w.requests().length, 2);                                   // 경보, 되살리기 멈춤
    assert.deepEqual(w.log().map(row => row.outcome), ['sent', 'policy-skip', 'sent']); // 줄은 셋 다 남는다
  } finally { w.stop(); }
});

test('디코 설정이 없으면 정책과 상관없이 기존처럼 맥 알림으로 내려간다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-policy-none-'));
  const calls = [];
  const r = notifyUser('소식', (cmd, args) => { calls.push(cmd); return {status: 0}; }, {kind: 'mail', home: dir, env: {KADAN_NOTIFY: '', KADAN_NOTIFY_ENV_FILE: path.join(dir, '없음.env')}});
  assert.equal(r.via, 'system');
  assert.deepEqual(calls, ['osascript']);
});

test('경보 글은 풀릴 때 같은 메시지를 ✅ 해결됨으로 고치고, 고칠 글이 없으면 아무것도 보내지 않는다', async () => {
  const w = await world();
  try {
    const post = 'alert:resource:1';
    notifyUser('경보', w.spawnFake, {kind: 'alert', ring: true, key: 'alert:resource:RED', decision: {id: post}, home: w.home, env: w.env});
    assert.equal(w.requests().length, 1);
    const edit = `✅ 해결됨 — 자원 경보 - 해소됨`;
    const r = notifyUser('해결됨', w.spawnFake, {kind: 'alert-resolved', systemFallback: false, decision: {id: post, edit}, home: w.home, env: w.env});
    assert.equal(r.discord.outcome, 'sent');
    const sent = w.requests();
    assert.equal(sent.length, 2);
    assert.match(sent[1].url, /\/messages\/M1/);
    assert.equal(JSON.parse(sent[1].body).content, edit);
    assert.equal(JSON.parse(sent[1].body).flags, undefined);                // 고치기는 새 알림이 아니다
    const none = notifyUser('해결됨', w.spawnFake, {kind: 'alert-resolved', systemFallback: false, decision: {id: 'alert:없음:1', edit}, home: w.home, env: w.env});
    assert.equal(none.discord.outcome, 'policy-skip');
    assert.equal(w.requests().length, 2);
    assert.equal(w.osCalls.length, 0);
  } finally { w.stop(); }
});

test('열린 경보 글 고치기(alert-update)는 같은 메시지만 고친다: 멘션·맥 알림 없음, 글이 없으면 0건, 반복해도 고쳐진다', async () => {
  const w = await world();
  try {
    const post = 'alert:process:memory:1000';
    // AMBER로 열린 사고는 같은 키로 건너뛰어도 키를 쓰지 않는다 → 나중 RED가 새 글로 나간다.
    const amber = notifyUser('개수', w.spawnFake, {kind: 'alert', ring: true, key: post, alertKind: '프로세스', level: 'AMBER', decision: {id: post}, home: w.home, env: w.env});
    assert.equal(amber.discord.outcome, 'policy-skip');
    assert.equal(w.requests().length, 0);
    const red = notifyUser('합계', w.spawnFake, {kind: 'alert', ring: true, key: post, alertKind: '프로세스', level: 'RED', decision: {id: post}, home: w.home, env: w.env});
    assert.equal(red.posted, true);
    assert.deepEqual(JSON.parse(w.requests()[0].body).allowed_mentions, {users: ['424242424242']});
    // 같은 사고 키는 시간 창 없이 막힌다(11분 뒤에도 중복).
    const later = notifyUser('합계', w.spawnFake, {kind: 'alert', ring: true, key: post, alertKind: '프로세스', level: 'RED', decision: {id: post}, home: w.home, env: w.env, now: () => Date.now() + 11 * 60_000});
    assert.equal(later.duplicate, true);
    for (const edit of ['[감시sh 10:01] 개수만', '[감시sh 10:02] 다시 합계']) {
      const r = notifyUser(edit, w.spawnFake, {kind: 'alert-update', systemFallback: false, decision: {id: post, edit}, home: w.home, env: w.env});
      assert.equal(r.discord.outcome, 'sent');
      const last = w.requests().at(-1), body = JSON.parse(last.body);
      assert.match(last.url, /\/messages\/M1/);
      assert.equal(body.content, edit);
      assert.deepEqual(body.allowed_mentions, {parse: []});
    }
    assert.equal(w.requests().length, 3, '새 글 1 + 고치기 2');
    const none = notifyUser('x', w.spawnFake, {kind: 'alert-update', systemFallback: false, decision: {id: 'alert:process:memory:2000', edit: 'x'}, home: w.home, env: w.env});
    assert.equal(none.discord.outcome, 'policy-skip');
    assert.equal(w.requests().length, 3);
    assert.equal(w.osCalls.length, 0);
    // 풀리면 같은 글이 해결됨으로 고쳐진다(고친 적이 있어도).
    const done = notifyUser('해결됨', w.spawnFake, {kind: 'alert-resolved', systemFallback: false, decision: {id: post, edit: '✅ 해결됨'}, home: w.home, env: w.env});
    assert.equal(done.discord.outcome, 'sent');
    assert.match(w.requests().at(-1).url, /\/messages\/M1/);
  } finally { w.stop(); }
});

test('경보 글이 아무리 많아도 결정 요청 메시지 기록은 밀려나지 않는다(보존 한도 분리)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-policy-cap-'));
  setDecision(home, 'decision-open', {threadId: null, messageId: 'M-d', forum: false});
  for (let i = 0; i < 700; i++) setDecision(home, `alert:a${i}:${i}`, {threadId: null, messageId: `M${i}`, forum: false});
  const kept = readDecisions(home);
  assert.ok(kept['decision-open']);
  assert.equal(Object.keys(kept).filter(k => k.startsWith('alert:')).length, 200);
  assert.ok(kept['alert:a699:699'] && !kept['alert:a0:0']);                // 경보끼리는 오래된 것부터
});


// notifyUser( 호출의 인자 범위를 괄호 짝으로 찾아(여러 줄 가능) 그 안의 kind 값을 모은다. 문자열 속 괄호는 따옴표 안이면 건너뛴다.
function callKinds(text) {
  const kinds = [];
  // notifyUser( 뿐 아니라 this.userNotify( 같은 메서드 호출도 찾는다(DecisionStore는 userNotify로 감싸 부른다).
  for (const m of text.matchAll(/(?:notifyUser|userNotify)\(/g)) {
    const at = m.index;
    let depth = 0, quote = null, i = at + m[0].length - 1;
    for (; i < text.length; i++) {
      const c = text[i];
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) break;
    }
    const k = /kind: ?["']([^"']+)["']/.exec(text.slice(at, i + 1));
    if (k) kinds.push(k[1]);
  }
  return kinds;
}

test('종류 대조는 여러 줄 notifyUser 호출도 읽는다', () => {
  const fake = "notifyUser(\n  `경보 ${f(x)}`,\n  spawn,\n  {\n    key: 'k',\n    kind: 'review-unregistered',\n  },\n);\nnotifyUser('a', s, {kind: 'alert'});";
  assert.deepEqual(callKinds(fake), ['review-unregistered', 'alert']);
  assert.ok(!KNOWN_KINDS.includes('review-unregistered'));              // 이런 종류가 소스에 생기면 아래 대조 시험이 실패한다
});

test('종류 대조는 this.userNotify( 메서드 호출의 종류도 읽는다', () => {
  assert.deepEqual(callKinds("const r = this.userNotify(`${tag} 글`, {kind:'decision-proceed', key: 'k'});"), ['decision-proceed']);
});

test('추천대로 진행 알림(decision-proceed)은 새 글 대상이다', () => {
  assert.deepEqual(postPolicy({kind: 'decision-proceed', key: 'decision:x:proceed'}), {post: true});
  assert.ok(KNOWN_KINDS.includes('decision-proceed'));
});

test('Autopilot 아침 요약(autopilot-summary)은 새 글 대상이다', () => {
  assert.deepEqual(postPolicy({kind: 'autopilot-summary', key: 'autopilot-summary:x'}), {post: true});
  assert.ok(KNOWN_KINDS.includes('autopilot-summary'));
});

// 새 알림 종류를 코드에 쓰면 정책(KNOWN_KINDS)과 문서 표에 올리게 한다. 필수 조치 알림이 조용히 빠지는 것을 막는다.
test('소스의 notifyUser 종류는 모두 정책 목록과 docs/user-notify.md 표에 있다', () => {
  const root = new URL('../', import.meta.url).pathname;
  const files = [];
  const walk = dir => { for (const e of fs.readdirSync(dir, {withFileTypes: true})) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.mjs')) files.push(p); } };
  walk(path.join(root, 'src'));
  const found = new Set();
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const k of callKinds(text)) found.add(k);
    for (const m of text.matchAll(/kind:`(decision-)\$\{kind\}`/g)) for (const k of ['request', 'answer', 'cancel']) found.add(`${m[1]}${k}`);
  }
  assert.ok(found.size >= 5, `소스에서 찾은 종류가 너무 적다: ${[...found]}`);
  const doc = fs.readFileSync(path.join(root, 'docs/user-notify.md'), 'utf8');
  for (const kind of found) assert.ok(KNOWN_KINDS.includes(kind), `정책 목록(KNOWN_KINDS)에 없는 종류: ${kind}`);
  for (const kind of KNOWN_KINDS) assert.ok(doc.includes(`\`${kind}\``), `docs/user-notify.md 표에 없는 종류: ${kind}`);
});

test('재시작 복원: 원장의 알림밀림 경보는 holdCode까지 복원돼 사유 변화 판정이 재시작 전과 같다', () => {
  const ledger = holdCode => [{kind: 'alert', id: 'notify-held:w', alertKind: '알림밀림', level: 'AMBER', role: 'w', holdCount: 3, holdCode, delivered: true, recipient: '@user'}];
  const restore = holdCode => seedAlertState(ledger(holdCode)).active;
  assert.equal(restore('KADAN_HERDR_TRUST_PROMPT')[0].holdCode, 'KADAN_HERDR_TRUST_PROMPT');
  assert.equal(seedAlertState([{kind: 'alert', id: 'x', alertKind: '정체', level: 'AMBER'}]).active[0].holdCode, undefined);   // 없던 필드는 만들지 않는다
  const now = holdCode => [{id: 'notify-held:w', kind: '알림밀림', level: 'AMBER', role: 'w', holdCode}];
  // 복원된 '사람 조치' 경보가 같은 사유로 이어지면 재시작 직후 다시 알리지 않는다
  assert.equal(dedupAlerts(restore('KADAN_HERDR_TRUST_PROMPT'), now('KADAN_HERDR_TRUST_PROMPT')).notify.length, 0);
  // 복원된 '조용한 사유' 경보가 사람 조치 사유로 바뀌면 재시작을 거쳐도 1번 알린다
  assert.equal(dedupAlerts(restore('KADAN_HUMAN_ACTIVE'), now('KADAN_HERDR_TRUST_PROMPT')).notify.length, 1);
  assert.equal(dedupAlerts(restore('KADAN_HUMAN_ACTIVE'), now('KADAN_HUMAN_ACTIVE')).notify.length, 0);
});
