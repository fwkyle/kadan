import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {notifyUser, resetDiscordBlock, NOTIFY_LOG_FILE} from '../src/user-notify.mjs';
import {DecisionStore} from '../src/decisions.mjs';
import {repoOfAlert} from '../src/watch-runner.mjs';

// 결정 알림 다듬기(레포 표시·레포 '결정' 글·원래 메시지 수정) 시험. 가짜 값만 쓴다.
const TOKEN = 'FAKETOKEN-abc123', USER_ID = '424242424242';
const helper = new URL('./helpers/fake-webhook.mjs', import.meta.url).pathname;
const childScript = new URL('./helpers/decision-child.mjs', import.meta.url).pathname;
const live = [];
process.on('exit', () => { for (const c of live) c.kill('SIGKILL'); });
const bodyOf = r => JSON.parse(r.body);
const UUID = '91f490fd-1234-4abc-8def-0123456789ab';

async function server(script, forum) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-decnotify-test-'));
  const logFile = path.join(dir, 'requests.jsonl');
  const child = spawn(process.execPath, [helper, logFile, JSON.stringify(script), JSON.stringify(forum ? {forum: true, ...forum} : {})], {stdio: ['ignore', 'pipe', 'inherit']});
  live.push(child);
  const port = await new Promise(resolve => child.stdout.once('data', d => resolve(Number(String(d).match(/PORT (\d+)/)[1]))));
  const requests = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  return {port, requests, stop: () => child.kill('SIGTERM')};
}

// 기본 채널(스크립트 응답)과 kadan 레포 포럼(옵션) 서버를 띄운다. repoKeys에 없는 레포는 기본 채널로 간다.
async function world({forum = true, repoKeys = ['kadan'], defaultScript = [{status: 200, body: {id: 'D1', channel_id: 'C1'}}]} = {}) {
  resetDiscordBlock();
  const base = await server(defaultScript);
  const fr = forum ? await server([{status: 204}], {known: []}) : null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-decnotify-home-'));
  const home = path.join(dir, 'home'); fs.mkdirSync(home);
  const envFile = path.join(dir, 'secret.env');
  let text = `DISCORD_WEBHOOK_URL=http://127.0.0.1:${base.port}/api/webhooks/111/${TOKEN}\nDISCORD_USER_ID="${USER_ID}"\n`;
  if (fr) for (const r of repoKeys) text += `DISCORD_WEBHOOK_URL_${r.toUpperCase()}=http://127.0.0.1:${fr.port}/api/webhooks/333/${TOKEN}\n`;
  fs.writeFileSync(envFile, text);
  const env = {KADAN_NOTIFY: '', KADAN_NOTIFY_ENV_FILE: envFile};
  const osCalls = [];
  const store = new DecisionStore(home, {userNotify: (m, o) => notifyUser(m, (...a) => { osCalls.push(a); return {status: 0}; }, {...o, home, env})});
  const state = () => { try { return JSON.parse(fs.readFileSync(path.join(home, 'notify-threads.json'), 'utf8')); } catch { return null; } };
  const announce = (kind, d) => { const prev = process.env.KADAN_NOTIFY; delete process.env.KADAN_NOTIFY; try { return store.announce(kind, d); } finally { if (prev !== undefined) process.env.KADAN_NOTIFY = prev; } };
  const child = (kind, d) => new Promise(resolve => {
    const c = spawn(process.execPath, [childScript, JSON.stringify({home, envFile, kind, d})], {stdio: ['ignore', 'pipe', 'inherit']});
    let out = ''; c.stdout.on('data', x => { out += x; }); c.on('close', () => resolve(JSON.parse(out.trim().split('\n').at(-1))));
  });
  return {home, envFile, base, fr, store, osCalls, state, announce, child, log: () => fs.existsSync(path.join(home, NOTIFY_LOG_FILE)) ? fs.readFileSync(path.join(home, NOTIFY_LOG_FILE), 'utf8') : '',
    stop: () => { base.stop(); fr?.stop(); }};
}
const dec = (over = {}) => ({id: UUID, card: `kadan/exec-${UUID}`, question: '이 방식으로 합칠까요?\n- PR: https://example.test/pull/1', options: ['합침', '보류'], recommendation: '합침', reason: '이유 한 줄', ...over});

test('D1 요청: [레포] 첫머리·질문 요약 첫 줄·링크 맨 끝·보이는 UUID는 8자, 업무가 있으면 업무 글로', async () => {
  const w = await world();
  try {
    w.announce('request', dec({work: 'kadan/work-x'}));
    const [req] = w.fr.requests(), b = bodyOf(req);
    assert.ok(b.thread_name.startsWith('kadan/work-x'));
    const lines = b.content.split('\n');
    assert.equal(lines[0], `[kadan] <@${USER_ID}> 결정 요청: 이 방식으로 합칠까요?`);
    assert.ok(lines.at(-1).endsWith(`/#decision-${UUID}`), '링크는 주소 안 ID 전체, 맨 끝');
    const visible = lines.slice(0, -1).join('\n');
    assert.ok(visible.includes('결정 91f490fd · 카드 kadan/exec-91f490fd · 업무 kadan/work-x'));
    assert.ok(!visible.includes(UUID));
    assert.deepEqual(b.allowed_mentions, {users: [USER_ID]});
    assert.equal(w.base.requests().length, 0);
  } finally { w.stop(); }
});

test('D1 업무가 없으면 레포 "결정" 글 하나 — 처음 만들고 다음 결정은 이어 붙인다', async () => {
  const w = await world();
  try {
    w.announce('request', dec());
    w.announce('request', dec({id: '22222222-1234-4abc-8def-0123456789ab', card: 'kadan/exec-2'}));
    const [first, second] = w.fr.requests();
    assert.equal(bodyOf(first).thread_name, '[kadan] 결정');
    assert.match(second.url, /thread_id=T1/);
    assert.equal(bodyOf(second).thread_name, undefined);
    assert.equal(w.state().threads['kadan/__decisions__'].threadId, 'T1');
    assert.deepEqual(Object.keys(w.state().decisions).sort(), [UUID, '22222222-1234-4abc-8def-0123456789ab'].sort());
    assert.equal(w.base.requests().length, 0);
  } finally { w.stop(); }
});

test('D1 레포 웹훅이 없으면 #브리핑으로 가고 [레포] 표시는 그대로', async () => {
  const w = await world({repoKeys: []});
  try {
    w.announce('request', dec());
    assert.equal(w.fr.requests().length, 0);
    const [req] = w.base.requests();
    assert.match(bodyOf(req).content, /^\[kadan\] <@\d+> 결정 요청:/);
  } finally { w.stop(); }
});

for (const [name, kind, mut, status] of [
  ['취소', 'cancel', {status: 'cancelled', cancelReason: '[시험] 채팅 승인'}, '취소: [시험] 채팅 승인'],
  ['답변', 'answer', {status: 'answered', answer: {text: '좋아요, 합칩시다', choice: '합침'}}, '답변: 합침 — 좋아요, 합칩시다'],
]) {
  test(`D2 ${name}: 원래 요청 메시지를 한 번 고친다(새 메시지 0, 멘션 없음, 상태가 맨 위, 원래 질문 보존)`, async () => {
    const w = await world();
    try {
      const d = dec({work: 'kadan/work-x'});
      w.announce('request', d);
      w.announce(kind, {...d, ...mut});
      const reqs = w.fr.requests();
      const posts = reqs.filter(r => r.method === 'POST'), patches = reqs.filter(r => r.method === 'PATCH');
      assert.equal(posts.length, 1);                 // 요청 하나뿐, 해결 알림은 새 메시지가 아니다
      assert.equal(patches.length, 1);
      assert.match(patches[0].url, /\/messages\/M1\?thread_id=T1/);
      const b = bodyOf(patches[0]);
      assert.equal(b.content.split('\n')[0], `✅ 해결됨 — ${status}`);
      assert.ok(b.content.includes('결정 요청: 이 방식으로 합칠까요?') && b.content.includes('선택지: 1) 합침 2) 보류'));
      assert.ok(!b.content.includes('<@'));
      assert.deepEqual(b.allowed_mentions, {parse: []});
      assert.ok(b.content.endsWith(`/#decision-${UUID}`));
    } finally { w.stop(); }
  });
}

test('D2 기본 #브리핑으로 간 요청도 같은 메시지를 고친다', async () => {
  const w = await world({repoKeys: [], defaultScript: [{status: 200, body: {id: 'D1', channel_id: 'C1'}}, {status: 200, body: {id: 'D1'}}]});
  try {
    w.announce('request', dec());
    w.announce('cancel', {...dec(), status: 'cancelled', cancelReason: '채팅에서 승인'});
    const [post, patch] = w.base.requests();
    assert.ok(!post.url.includes('/messages/') && /wait=true/.test(post.url));
    assert.match(patch.url, /\/messages\/D1$/);
    assert.match(bodyOf(patch).content, /^✅ 해결됨 — 취소: 채팅에서 승인/);
    assert.equal(w.base.requests().length, 2);
  } finally { w.stop(); }
});

test('D3 원래 메시지를 못 찾으면(기록 없음·404) 질문 앞부분·사유가 든 새 메시지 한 개', async () => {
  const w = await world();
  try {
    const cancelled = {...dec(), status: 'cancelled', cancelReason: '[시험] 채팅 승인'};
    w.announce('cancel', cancelled);                    // 기록 없음
    let reqs = w.fr.requests();
    assert.equal(reqs.length, 1); assert.equal(reqs[0].method, 'POST');
    assert.equal(bodyOf(reqs[0]).content.split('\n')[0], '[kadan] 결정 해결됨: 이 방식으로 합칠까요? — 취소: [시험] 채팅 승인');
    assert.deepEqual(bodyOf(reqs[0]).allowed_mentions, {parse: []});
    // 기록은 있으나 디코에 없는 메시지(404) → 새 메시지
    const file = path.join(w.home, 'notify-threads.json'), st = w.state();
    st.decisions = {[UUID]: {threadId: 'T1', messageId: 'GONE', forum: true}};
    fs.writeFileSync(file, JSON.stringify(st));
    w.announce('answer', {...dec(), answer: {text: '합침', choice: '합침'}});   // 같은 키 중복 막기를 피하려고 다른 종류로
    reqs = w.fr.requests();
    assert.deepEqual(reqs.slice(1).map(r => r.method), ['PATCH', 'POST']);
    assert.match(bodyOf(reqs[2]).content, /^\[kadan\] 결정 해결됨: .* — 답변: 합침/);
  } finally { w.stop(); }
});

test('D4 두 결정이 동시에 요청돼도 레포 "결정" 글은 하나, 두 메시지 기록 모두 보존, 이어서 동시 해결도 모두 고침', async () => {
  const w = await world();
  try {
    const a = dec(), b = dec({id: '33333333-1234-4abc-8def-0123456789ab', card: 'kadan/exec-3'});
    const out = await Promise.all([w.child('request', a), w.child('request', b)]);
    assert.deepEqual(out.map(o => o.via), ['discord', 'discord']);
    const creates = w.fr.requests().filter(r => bodyOf(r).thread_name);
    assert.equal(creates.length, 1);
    assert.equal(Object.keys(w.state().decisions).length, 2);
    assert.equal(Object.keys(w.state().threads).length, 1);
    await Promise.all([w.child('cancel', {...a, status: 'cancelled', cancelReason: '사유'}), w.child('answer', {...b, answer: {text: 'x', choice: '합침'}})]);
    const reqs = w.fr.requests();
    assert.equal(reqs.filter(r => r.method === 'PATCH').length, 2);
    assert.equal(reqs.filter(r => r.method === 'POST').length, 2);
  } finally { w.stop(); }
});

test('D5 KADAN_NOTIFY=off·설정 없음이면 요청 0건, 상태 파일·기록에 주소·토큰·사용자 ID 없음', async () => {
  const w = await world();
  try {
    assert.equal(process.env.KADAN_NOTIFY, 'off');
    w.announce('request', dec());                    // 설정이 있는 보통 경우: 1건 나간다
    const before = w.fr.requests().length;
    new DecisionStore(w.home, {userNotify: () => assert.fail('off인데 알림 호출')}).announce('request', dec());   // 시험 기본값 KADAN_NOTIFY=off
    assert.equal(w.fr.requests().length, before);
    for (const text of [w.log(), JSON.stringify(w.state())]) for (const x of [TOKEN, USER_ID, '/api/webhooks', 'http://']) assert.ok(!text.includes(x), x);
    const nothing = new DecisionStore(w.home, {userNotify: (m, o) => notifyUser(m, () => ({status: 0}), {...o, home: w.home, env: {KADAN_NOTIFY: '', KADAN_NOTIFY_ENV_FILE: path.join(w.home, 'none.env')}})});
    const prev = process.env.KADAN_NOTIFY; delete process.env.KADAN_NOTIFY;
    const n0 = w.fr.requests().length + w.base.requests().length;
    try { nothing.announce('request', dec()); } finally { process.env.KADAN_NOTIFY = prev; }
    assert.equal(w.fr.requests().length + w.base.requests().length, n0);
  } finally { w.stop(); }
});

test('D6 다른 알림의 [레포] 표시: 근거가 있을 때만, 모르면 붙이지 않는다', async () => {
  const w = await world({repoKeys: []});
  try {
    const o = {home: w.home, env: {KADAN_NOTIFY: '', KADAN_NOTIFY_ENV_FILE: w.envFile}};
    notifyUser('경보 본문', () => ({status: 0}), {...o, kind: 'alert', tagRepo: 'kadan'});
    notifyUser('업무 편지', () => ({status: 0}), {...o, kind: 'mail', work: 'kadan/work-1'});
    notifyUser('근거 없음', () => ({status: 0}), {...o, kind: 'handover'});
    assert.deepEqual(w.base.requests().map(r => bodyOf(r).content), ['[kadan] 경보 본문', '[kadan] 업무 편지', '근거 없음']);
    const sys = [];
    notifyUser('x', (...a) => { sys.push(a[1][1]); return {status: 0}; }, {home: w.home, env: {KADAN_NOTIFY: '', KADAN_NOTIFY_ENV_FILE: path.join(w.home, 'none.env')}, tagRepo: 'kadan'});
    assert.match(sys[0], /"\[kadan\] x"/);
    const identity = {resolve: id => ({key: id === 'card-a' ? 'kadan/exec-a' : null})};
    assert.equal(repoOfAlert({taskId: 'card-a'}, identity), 'kadan');
    assert.equal(repoOfAlert({taskId: 'zzz'}, identity), undefined);
    assert.equal(repoOfAlert({role: '감독'}, identity), undefined);
  } finally { w.stop(); }
});

// --- 2라운드: 요청·취소 경합(R1), 업무 상태 갱신(R2), 본문 UUID(R3) ---
const {CardStore} = await import('../src/card-store.mjs');
const {WorkStore} = await import('../src/work-store.mjs');
const realDecision = (w, over = {}) => {
  new CardStore(w.home).create({repo: 'kadan', id: 'card-a', repoPath: w.home, body: '# 테스트'});
  return w.store.request('kadan/card-a', {question: '합칠까요?\n- 확인 경로 없음: 시험', options: ['합침', '보류'], recommendation: '합침', reason: '이유', work: '없음', ...over}, '슈퍼감독');
};
const visible = reqs => reqs.filter(r => r.method === 'POST' && !bodyOf(r).content.startsWith('**업무 상태**'));

test('R1 취소가 요청 알림보다 먼저 잠금을 잡으면: 해결 메시지 하나만 남고 열린 요청 메시지는 안 올라온다', async () => {
  const w = await world();
  try {
    const d = realDecision(w);
    const cancelled = w.store.cancel(d.id, {revision: d.revision, reason: '[시험] 채팅 승인'}, '슈퍼감독');
    w.announce('cancel', cancelled);                  // 취소 알림이 먼저(기록 없음 → 해결 모양 새 메시지, '해결 메시지 보냄' 기록)
    w.announce('request', d);                         // 늦은 요청 알림(저장소는 이미 취소) → 건너뜀
    const reqs = w.fr.requests();
    assert.equal(reqs.length, 1);
    assert.match(bodyOf(reqs[0]).content, /결정 해결됨: 합칠까요\? — 취소: \[시험\] 채팅 승인/);
    assert.ok(!reqs.some(r => /결정 요청/.test(bodyOf(r).content)) && !reqs.some(r => bodyOf(r).content.includes('<@')));
    assert.equal(w.state().decisions[d.id].resolved, true);
  } finally { w.stop(); }
});

test('R1 요청 알림이 먼저 잠금을 잡았는데 저장소는 이미 취소: 해결 모양으로 보내고, 뒤따르는 취소 알림은 그 메시지를 고친다', async () => {
  const w = await world();
  try {
    const d = realDecision(w);
    const cancelled = w.store.cancel(d.id, {revision: d.revision, reason: '[시험] 채팅 승인'}, '슈퍼감독');
    w.announce('request', d);                         // 요청 알림 시점에 이미 취소됨
    w.announce('cancel', cancelled);
    const reqs = w.fr.requests();
    assert.deepEqual(reqs.map(r => r.method), ['POST', 'PATCH']);
    assert.ok(!bodyOf(reqs[0]).content.includes('<@') && /결정 해결됨/.test(bodyOf(reqs[0]).content));
    assert.deepEqual(bodyOf(reqs[0]).allowed_mentions, {parse: []});
    assert.match(bodyOf(reqs[1]).content, /^✅ 해결됨 — 취소: \[시험\] 채팅 승인/);
  } finally { w.stop(); }
});

test('R1 별도 프로세스로 동시에 요청·취소 알림이 와도 남는 메시지는 해결됨 하나(열린 요청 0)', async () => {
  const w = await world();
  try {
    const d = realDecision(w);
    const cancelled = w.store.cancel(d.id, {revision: d.revision, reason: '채팅 승인'}, '슈퍼감독');
    await Promise.all([w.child('cancel', cancelled), w.child('request', d)]);
    const reqs = w.fr.requests();
    const open = reqs.filter(r => r.method === 'POST' && /결정 요청:/.test(bodyOf(r).content));
    assert.equal(open.length, 0);
    assert.ok(reqs.some(r => /결정 해결됨|✅ 해결됨/.test(bodyOf(r).content)));
    assert.equal(visible(reqs).length, 1);
  } finally { w.stop(); }
});

test('R2 업무 있는 결정 취소: 원래 메시지 수정 1회 + 업무 상태 메시지 갱신 1회', async () => {
  const w = await world();
  try {
    new WorkStore(w.home).create({key: 'kadan/work-x', title: '상태 시험', goal: '목표', scope: '범위', acceptance: '조건', owner: 'kadan-감독', repoPath: os.tmpdir()});
    const d = dec({work: 'kadan/work-x'});
    w.announce('request', d);                          // 글 + 결정 메시지(M1) + 상태 메시지(M2)
    assert.equal(w.fr.requests().filter(r => r.method === 'PATCH').length, 0);
    w.announce('cancel', {...d, status: 'cancelled', cancelReason: '채팅 승인'});
    const patches = w.fr.requests().filter(r => r.method === 'PATCH');
    assert.equal(patches.length, 2);
    assert.ok(patches.some(r => /\/messages\/M1\?/.test(r.url) && bodyOf(r).content.startsWith('✅ 해결됨')));
    assert.ok(patches.some(r => /\/messages\/M2\?/.test(r.url) && bodyOf(r).content.startsWith('**업무 상태**')));
    assert.equal(w.fr.requests().filter(r => r.method === 'POST').length, 2);   // 새 메시지는 요청 때 둘뿐
  } finally { w.stop(); }
});

test('R3 본문의 표시용 UUID는 8자, 경로·주소 안 UUID와 링크 주소는 전체', async () => {
  const w = await world();
  try {
    const other = 'aaaaaaaa-1111-4222-8333-444444444444';
    const path1 = `/home/tester/.kadan/cards/kadan/exec-${other}/result.md`;
    w.announce('request', dec({
      question: `카드 ${other} 와 kadan/exec-${other} 를 합칠까요?\n- 결과 파일: ${path1}\n- PR: https://example.test/${other}`,
      options: [`합침 ${other}`, '보류'], recommendation: `합침 ${other}`, reason: `이유 ${other}`}));
    const content = bodyOf(w.fr.requests()[0]).content, body = content.split('\n').slice(0, -1).join('\n');
    assert.ok(body.includes('카드 aaaaaaaa 와 kadan/exec-aaaaaaaa 를 합칠까요?'));
    assert.ok(body.includes(`결과 파일: ${path1}`) && body.includes(`https://example.test/${other}`));
    assert.ok(body.includes('1) 합침 aaaaaaaa') && body.includes('추천: 합침 aaaaaaaa') && body.includes('이유: 이유 aaaaaaaa'));
    assert.ok(content.endsWith(`/#decision-${UUID}`));
  } finally { w.stop(); }
});

// --- 3라운드: 해결 기록은 한 방향(F1), 읽기 실패 + 기록 없음은 요청 그대로(F1), 상대경로 보존(F2) ---
const {setDecision} = await import('../src/notify-threads.mjs');
const stateFile = w => path.join(w.home, 'notify-threads.json');
const seedResolved = (w, id, entry) => fs.writeFileSync(stateFile(w), JSON.stringify({version: 1, threads: {}, decisions: {[id]: entry}}));
const NOT_IN_STORE = dec();   // 저장소에 없는 결정 → announce의 최신 상태 읽기가 실패한다

for (const [name, opts, extra] of [
  ['업무 글', {}, {work: 'kadan/work-x'}], ['레포 결정 글', {}, {}], ['#브리핑', {repoKeys: []}, {}],
]) {
  test(`F1 해결 기록 있음 + 최신 읽기 실패(${name}): HTTP 0, 기록 그대로`, async () => {
    const w = await world(opts);
    try {
      const rec = {threadId: 'T1', messageId: 'M9', forum: !opts.repoKeys, resolved: true};
      seedResolved(w, UUID, rec);
      const before = fs.readFileSync(stateFile(w), 'utf8');
      w.announce('request', {...NOT_IN_STORE, ...extra});
      assert.equal(w.fr.requests().length + w.base.requests().length, 0);
      assert.equal(fs.readFileSync(stateFile(w), 'utf8'), before);
      assert.equal(w.osCalls.length, 0);                                   // 시스템 알림으로도 새지 않는다
      assert.match(w.log(), /"outcome":"resolved-skip"/);
    } finally { w.stop(); }
  });
}

test('F1 해결 기록 없음 + 최신 읽기 실패: 요청은 그대로 1회 나가고 결과 사유에 확인 실패가 남는다', async () => {
  const w = await world();
  try {
    w.announce('request', NOT_IN_STORE);
    const reqs = w.fr.requests();
    assert.equal(reqs.length, 1);
    assert.match(bodyOf(reqs[0]).content, /^\[kadan\] <@\d+> 결정 요청:/);
    assert.deepEqual(bodyOf(reqs[0]).allowed_mentions, {users: [USER_ID]});
    assert.match(w.log(), /"outcome":"sent".*최신 상태 확인 실패/);
    assert.equal(w.state().decisions[UUID].resolved, undefined);
  } finally { w.stop(); }
});

test('F1 시스템 알림도 같은 판단: 해결 기록 있으면 띄우지 않고, 기록 없음 + 읽기 실패면 요청 문구 그대로', async () => {
  const w = await world();
  try {
    const offEnv = {KADAN_NOTIFY: '', KADAN_NOTIFY_ENV_FILE: path.join(w.home, 'none.env')};   // 디코 설정 없음 → 시스템 알림
    const sys = [];
    const store = new DecisionStore(w.home, {userNotify: (m, o) => notifyUser(m, (...a) => { sys.push(a[1][1]); return {status: 0}; }, {...o, home: w.home, env: offEnv})});
    const prev = process.env.KADAN_NOTIFY; delete process.env.KADAN_NOTIFY;
    try {
      store.announce('request', NOT_IN_STORE);
      assert.equal(sys.length, 1); assert.match(sys[0], /결정 요청/);
      seedResolved(w, UUID, {threadId: null, messageId: 'M1', forum: false, resolved: true});
      store.announce('request', NOT_IN_STORE);
      assert.equal(sys.length, 1);
    } finally { if (prev !== undefined) process.env.KADAN_NOTIFY = prev; }
  } finally { w.stop(); }
});

test('F1 resolved:true 기록은 어떤 쓰기로도 false가 되지 않는다', async () => {
  const w = await world();
  try {
    seedResolved(w, UUID, {threadId: 'T1', messageId: 'M1', forum: true, resolved: true});
    setDecision(w.home, UUID, {threadId: 'T1', messageId: 'M2', forum: true, resolved: false});
    setDecision(w.home, UUID, {threadId: 'T1', messageId: 'M3', forum: true});
    assert.equal(w.state().decisions[UUID].resolved, true);
    // 실제 흐름: 취소 알림(해결 기록) 뒤 요청 알림이 어떤 읽기 결과로 와도 기록이 그대로
    const d = realDecision(w);
    const cancelled = w.store.cancel(d.id, {revision: d.revision, reason: '채팅 승인'}, '슈퍼감독');
    w.announce('cancel', cancelled); w.announce('request', d); w.announce('request', {...d, id: d.id});
    assert.equal(w.state().decisions[d.id].resolved, true);
    assert.equal(w.fr.requests().filter(r => /결정 요청:/.test(bodyOf(r).content)).length, 0);
  } finally { w.stop(); }
});

test('F2 ./·../ 경로의 UUID는 보존하고, 카드 키·일반 문장의 UUID는 8자로 줄인다', async () => {
  const w = await world();
  try {
    const o = 'bbbbbbbb-1111-4222-8333-444444444444';
    w.announce('request', dec({question: `확인: ./${o}/result.md 그리고 ../${o}\nkadan/exec-${o} 와 A/B 선택 ${o}`}));
    const body = bodyOf(w.fr.requests()[0]).content;
    assert.ok(body.includes(`./${o}/result.md`) && body.includes(`../${o}`));
    assert.ok(body.includes('kadan/exec-bbbbbbbb ') && body.includes('A/B 선택 bbbbbbbb'));
  } finally { w.stop(); }
});
