import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {notifyUser, fitDiscord, scrubSecrets, resetDiscordBlock, NOTIFY_LOG_FILE} from '../src/user-notify.mjs';
import {DecisionStore} from '../src/decisions.mjs';
import {parseEnvText, setNotifySetting, readNotifySetting, effectiveNotifyEnvFile} from '../src/notify-setting.mjs';

// 가짜 값만 쓴다. 이 시험 파일의 어떤 값도 실제 주소·ID가 아니다.
const TOKEN = 'FAKETOKEN-abc123', USER_ID = '424242424242';
const helper = new URL('./helpers/fake-webhook.mjs', import.meta.url).pathname;
const live = [];
process.on('exit', () => { for (const c of live) c.kill('SIGKILL'); });

async function world(script = [{status: 204}], {envExtra = '', startServer = true, forum = null} = {}) {
  resetDiscordBlock(); // 장애 직후 건너뛰기(60초)가 시험 사이로 번지지 않게
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-notify-test-'));
  const home = path.join(dir, 'home'), logFile = path.join(dir, 'requests.jsonl');
  fs.mkdirSync(home);
  let port = 1, child = null;
  if (startServer) {
    child = spawn(process.execPath, [helper, logFile, JSON.stringify(script), JSON.stringify(forum ? {forum: true, ...forum} : {})], {stdio: ['ignore', 'pipe', 'inherit']});
    live.push(child);
    port = await new Promise(resolve => child.stdout.once('data', d => resolve(Number(String(d).match(/PORT (\d+)/)[1]))));
  }
  const envFile = path.join(dir, 'secret.env');
  fs.writeFileSync(envFile, `DISCORD_WEBHOOK_URL=http://127.0.0.1:${port}/api/webhooks/111/${TOKEN}\nDISCORD_USER_ID="${USER_ID}"\n${envExtra}`);
  const env = {KADAN_NOTIFY: '', KADAN_NOTIFY_ENV_FILE: envFile};
  const requests = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const osCalls = [];
  const fakeSpawn = osFails => (cmd, args, options) => { osCalls.push({cmd, args, options}); return {status: osFails ? 1 : 0, stderr: 'os-fail'}; };
  const log = () => fs.existsSync(path.join(home, NOTIFY_LOG_FILE)) ? fs.readFileSync(path.join(home, NOTIFY_LOG_FILE), 'utf8') : '';
  return {dir, home, envFile, env, port, requests, osCalls, fakeSpawn, log, stop: () => child?.kill('SIGTERM')};
}

test('환경 파일은 KEY=VALUE만 해석한다(따옴표·주석·export, 명령 실행 없음)', () => {
  assert.deepEqual(parseEnvText('# c\nexport A="1"\nB=\'2\'\nC=$(echo hi)\n bad line\n'), {A: '1', B: '2', C: '$(echo hi)'});
});

test('본문 2,000자 제한: 줄여도 끝의 링크는 남는다', () => {
  const out = fitDiscord('가'.repeat(5000), '링크: http://127.0.0.1:8790/#decision-x');
  assert.ok(out.length <= 2000);
  assert.ok(out.endsWith('http://127.0.0.1:8790/#decision-x'));
});

test('결정 요청만 멘션하고, 답변·취소·경보는 allowed_mentions를 비운다', async () => {
  const w = await world();
  try {
    const store = new DecisionStore(w.home, {userNotify: (m, o) => notifyUser(m, w.fakeSpawn(), {...o, home: w.home, env: w.env})});
    const prev = process.env.KADAN_NOTIFY; delete process.env.KADAN_NOTIFY;
    try {
      const d = {id: 'dec-1', card: 'repo/card-1', work: 'repo/work-1', question: '질문입니다 '.repeat(300), options: ['가', '나'], recommendation: '가', reason: '이유 '.repeat(500)};
      store.announce('request', d);
      store.announce('answer', {...d, answer: {text: '가로 가자', choice: '가'}});
      store.announce('cancel', d);
    } finally { if (prev !== undefined) process.env.KADAN_NOTIFY = prev; }
    notifyUser('경보 @everyone <@999>', w.fakeSpawn(), {kind: 'alert', home: w.home, env: w.env});
    const [req, ans, can, alert] = w.requests().map(r => JSON.parse(r.body));
    assert.deepEqual(req.allowed_mentions, {users: [USER_ID]});
    assert.ok(req.content.startsWith(`<@${USER_ID}> [결정 요청]`));
    for (const part of ['선택지: 1) 가 2) 나', '추천: 가', '결정 dec-1', '카드 repo/card-1', '업무 repo/work-1', 'http://127.0.0.1:8790/#decision-dec-1']) assert.ok(req.content.includes(part), part);
    assert.ok(req.content.length <= 2000);
    assert.deepEqual(ans.allowed_mentions, {parse: []});
    assert.match(ans.content, /^결정 dec-1 답변됨\(가\)/);
    assert.deepEqual(can.allowed_mentions, {parse: []});
    assert.deepEqual(alert.allowed_mentions, {parse: []});
    assert.equal(w.osCalls.length, 0);
  } finally { w.stop(); }
});

test('연결 거부: 연결 단계 실패만 2회 재시도하고 시스템 알림으로 내려간다, 주소는 기록에 없다', async () => {
  const w = await world([{status: 204}], {startServer: false});
  try {
    const r = notifyUser('경보', w.fakeSpawn(), {kind: 'alert', key: 'alert:a:RED', home: w.home, env: w.env});
    assert.equal(r.via, 'system');
    assert.equal(r.discord.outcome, 'failed');
    assert.equal(r.discord.attempts, 3);
    assert.equal(w.osCalls.length, 1);
    const everything = JSON.stringify(r) + w.log();
    for (const secret of [TOKEN, USER_ID, '/api/webhooks', '127.0.0.1:1']) assert.ok(!everything.includes(secret), secret);
  } finally { w.stop(); }
});

test('400은 재시도하지 않는다', async () => {
  const w = await world([{status: 400, body: {message: 'bad'}}]);
  try {
    const r = notifyUser('경보', w.fakeSpawn(), {home: w.home, env: w.env});
    assert.equal(r.discord.outcome, 'failed');
    assert.equal(r.discord.reason, 'HTTP 400');
    assert.equal(w.requests().length, 1);
    assert.equal(r.via, 'system');
  } finally { w.stop(); }
});

test('429는 retry_after를 지켜 한 번만 다시 보낸다', async () => {
  const w = await world([{status: 429, body: {retry_after: 0.4}}, {status: 204}]);
  try {
    const r = notifyUser('경보', w.fakeSpawn(), {home: w.home, env: w.env});
    assert.equal(r.via, 'discord');
    const reqs = w.requests();
    assert.equal(reqs.length, 2);
    assert.ok(reqs[1].at - reqs[0].at >= 380, `간격 ${reqs[1].at - reqs[0].at}ms`);
  } finally { w.stop(); }
});

test('429가 두 번이면 더 보내지 않는다', async () => {
  const w = await world([{status: 429, body: {retry_after: 0.1}}]);
  try {
    const r = notifyUser('경보', w.fakeSpawn(), {home: w.home, env: w.env});
    assert.equal(r.via, 'system');
    assert.equal(w.requests().length, 2);
  } finally { w.stop(); }
});

test('5xx는 한 번만 다시 보낸다', async () => {
  const w = await world([{status: 500}, {status: 204}]);
  try {
    assert.equal(notifyUser('경보', w.fakeSpawn(), {home: w.home, env: w.env}).via, 'discord');
    assert.equal(w.requests().length, 2);
  } finally { w.stop(); }
});

test('응답 대기 중 시간 초과는 재시도하지 않고 불확실로 남긴다', async () => {
  const w = await world([{hang: true}]);
  try {
    const t0 = Date.now();
    const r = notifyUser('경보', w.fakeSpawn(), {kind: 'alert', key: 'alert:slow', home: w.home, env: w.env});
    assert.equal(r.discord.outcome, 'uncertain');
    assert.equal(w.requests().length, 1);
    assert.equal(r.via, 'system');
    assert.ok(Date.now() - t0 < 14000);
    // 불확실한 키는 중복으로 본다 — 이미 올라갔을 수 있으므로 다시 보내지 않는다.
    const again = notifyUser('경보', w.fakeSpawn(), {kind: 'alert', key: 'alert:slow', home: w.home, env: w.env});
    assert.equal(again.duplicate, true);
    assert.equal(w.requests().length, 1);
  } finally { w.stop(); }
});

test('같은 키는 다른 프로세스에서 불러도 한 번만 보낸다', async () => {
  const w = await world();
  try {
    const first = notifyUser('결정', w.fakeSpawn(), {kind: 'decision-request', key: 'decision:d1:request', home: w.home, env: w.env});
    assert.equal(first.via, 'discord');
    const code = `import {notifyUser} from ${JSON.stringify(new URL('../src/user-notify.mjs', import.meta.url).href)};
      const r = notifyUser('결정', () => ({status: 0}), {key: 'decision:d1:request', home: ${JSON.stringify(w.home)}, env: {KADAN_NOTIFY: '', KADAN_NOTIFY_ENV_FILE: ${JSON.stringify(w.envFile)}}});
      console.log(JSON.stringify(r));`;
    const other = spawnSync(process.execPath, ['--input-type=module', '-e', code], {encoding: 'utf8', env: {...process.env, KADAN_HOME: w.home}});
    assert.equal(JSON.parse(other.stdout).duplicate, true);
    assert.equal(w.requests().length, 1);
    // 종류가 다르면 다른 키다.
    notifyUser('답변', w.fakeSpawn(), {key: 'decision:d1:answer', home: w.home, env: w.env});
    assert.equal(w.requests().length, 2);
  } finally { w.stop(); }
});

test('경보 키는 짧은 창 안에서만 중복이다', async () => {
  const w = await world();
  try {
    let now = 1_000_000;
    const o = {key: 'alert:x:RED', dedupWindowMs: 60_000, home: w.home, env: w.env, now: () => now};
    notifyUser('a', w.fakeSpawn(), o);
    now += 30_000; assert.equal(notifyUser('a', w.fakeSpawn(), o).duplicate, true);
    now += 61_000; assert.equal(notifyUser('a', w.fakeSpawn(), o).via, 'discord');
    assert.equal(w.requests().length, 2);
  } finally { w.stop(); }
});

test('설정 없음·비밀 파일 없음·값 빠짐은 시스템 알림으로 내려가고 사유를 남긴다', async () => {
  const w = await world();
  try {
    const none = notifyUser('경보', w.fakeSpawn(), {home: w.home, env: {KADAN_NOTIFY: ''}});
    assert.equal(none.via, 'system'); assert.equal(none.discord, null); assert.equal(w.osCalls.length, 1);
    const missing = notifyUser('경보', w.fakeSpawn(), {home: w.home, env: {KADAN_NOTIFY: '', KADAN_NOTIFY_ENV_FILE: path.join(w.dir, 'nope.env')}});
    assert.equal(missing.discord.outcome, 'config-error'); assert.match(missing.discord.reason, /읽을 수 없다/); assert.equal(w.osCalls.length, 2);
    const noUser = path.join(w.dir, 'nouser.env');
    fs.writeFileSync(noUser, `DISCORD_WEBHOOK_URL=http://127.0.0.1:${w.port}/api/webhooks/1/${TOKEN}\n`);
    const r = notifyUser('경보', w.fakeSpawn(), {home: w.home, env: {KADAN_NOTIFY: '', KADAN_NOTIFY_ENV_FILE: noUser}});
    assert.match(r.discord.reason, /DISCORD_USER_ID/); assert.equal(w.osCalls.length, 3);
    assert.equal(w.requests().length, 0);
    assert.ok(!w.log().includes(TOKEN));
  } finally { w.stop(); }
});

test('KADAN_NOTIFY=off는 디스코드를 보내지 않고, 결정 알림은 시스템 알림도 띄우지 않는다', async () => {
  const w = await world();
  try {
    notifyUser('경보', w.fakeSpawn(), {home: w.home, env: {...w.env, KADAN_NOTIFY: 'off'}});
    assert.equal(w.requests().length, 0);
    assert.equal(process.env.KADAN_NOTIFY, 'off'); // 시험 기본값
    let called = 0;
    new DecisionStore(w.home, {userNotify: () => { called++; }}).announce('request', {id: 'd', card: 'r/c', question: 'q', options: ['a', 'b'], recommendation: 'a', reason: 'r'});
    assert.equal(called, 0);
  } finally { w.stop(); }
});

test('결정 저장은 알림 실패와 무관하다', () => {
  const store = new DecisionStore(os.tmpdir(), {userNotify: () => { throw new Error('boom'); }});
  const prev = process.env.KADAN_NOTIFY; delete process.env.KADAN_NOTIFY;
  try { assert.equal(store.announce('request', {id: 'd', card: 'r/c', question: 'q', options: ['a', 'b'], recommendation: 'a', reason: 'r'}), null); }
  finally { if (prev !== undefined) process.env.KADAN_NOTIFY = prev; }
});

test('설정은 비밀 파일 경로만 저장하고 환경변수가 설정보다 먼저다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-notify-setting-'));
  assert.throws(() => setNotifySetting(home, {envFile: 'relative.env'}), /절대경로/);
  setNotifySetting(home, {envFile: '/abs/secret.env'});
  assert.equal(readNotifySetting(home).discord.envFile, '/abs/secret.env');
  assert.ok(!JSON.stringify(readNotifySetting(home)).match(/https?:|webhooks|token|DISCORD_/i));
  assert.deepEqual(effectiveNotifyEnvFile({}, home), {envFile: '/abs/secret.env', source: 'setting', error: null});
  assert.equal(effectiveNotifyEnvFile({KADAN_NOTIFY_ENV_FILE: '/e.env'}, home).source, 'env');
  fs.writeFileSync(path.join(home, 'notify-setting.json'), '{bad');
  assert.match(effectiveNotifyEnvFile({}, home).error, /손상/);
});

test('scrubSecrets는 웹훅 주소와 값을 가린다', () => {
  const out = scrubSecrets(`fail https://example.test/api/${'webhooks'}/1/${TOKEN} and ${USER_ID}`, [USER_ID]);
  assert.ok(!out.includes(TOKEN) && !out.includes(USER_ID) && !out.includes('example.test'));
});

test('결정 요청·답변은 알림이 실패해도 저장되고, 요청 알림은 새 요청에만 한 번 나간다', async () => {
  const {CardStore} = await import('../src/card-store.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-decision-notify-'));
  new CardStore(home).create({repo: 'repo', id: 'card-a', repoPath: home, body: '# 테스트'});
  const calls = [];
  const prev = process.env.KADAN_NOTIFY; delete process.env.KADAN_NOTIFY;
  try {
    const store = new DecisionStore(home, {notify: () => {}, userNotify: (m, o) => { calls.push(o.key); throw new Error('boom'); }});
    const input = {question: '분리할까요?\n- 결과 파일: /repo/card-a/result.md', options: ['분리', '유지'], recommendation: '분리', reason: '이유\n- 결과 파일: /repo/card-a/result.md', work: '없음'};
    const a = store.request('repo/card-a', input, '슈퍼감독');
    store.request('repo/card-a', input, '슈퍼감독'); // 같은 요청 → 알림 없음
    assert.deepEqual(calls, [`decision:${a.id}:request`]);
    assert.equal(store.get(a.id).status, 'open');
    store.answer(a.id, {revision: a.revision, choice: '분리'}, '사람');
    assert.deepEqual(calls, [`decision:${a.id}:request`, `decision:${a.id}:answer`]);
    assert.equal(store.get(a.id).status, 'answered');
  } finally { if (prev !== undefined) process.env.KADAN_NOTIFY = prev; }
});

test('watch @user 전달: 디스코드 실패 + 시스템 성공이면 전달, 둘 다 실패면 not-sent로 기록한다', async () => {
  const {parseHierarchy} = await import('../src/hierarchy.mjs');
  const {runWatch} = await import('./helpers/watch-runner.mjs');
  const w = await world([{status: 400}]);
  const prev = {n: process.env.KADAN_NOTIFY, f: process.env.KADAN_NOTIFY_ENV_FILE};
  process.env.KADAN_NOTIFY = ''; process.env.KADAN_NOTIFY_ENV_FILE = w.envFile;
  const t = '2026-10-14T00:00:00.000Z', parents = parseHierarchy({'prod-슈퍼감독': '@user'});
  const exercise = async osFails => {
    let cycle = 0; const records = [], lines = [], notes = [], stop = new Error('done');
    const oldLoad = os.loadavg; os.loadavg = () => [0, 0, 0];
    const starts = [{kind: 'start', role: 'prod-슈퍼감독', session: 'kadan-prod-슈퍼감독', panePid: 1, t}];
    try {
      await assert.rejects(() => runWatch({completionGraceMs: 0, parents, routes: {}, superRole: '옛-슈퍼', intervalMs: 1000, stallN: 100,
        floor: {list: () => starts.map(x => ({session: x.session, pid: x.panePid})), read: () => 'KADAN:DONE card-test ok'},
        readEntries: () => starts, record: e => records.push(e), now: () => Date.parse(t) + cycle * 1000, print: l => lines.push(l),
        spawn: cmd => {
          if (cmd === 'sleep' && ++cycle === 3) throw stop;
          if (cmd === 'osascript') { notes.push(1); return osFails === 'timeout' ? {status: null, signal: 'SIGTERM', error: {code: 'ETIMEDOUT'}, stderr: ''} : {status: osFails ? 1 : 0, stderr: 'disabled'}; }
          if (cmd === 'memory_pressure') return {status: 0, stdout: 'System-wide memory free percentage: 80%'};
          if (cmd === 'sysctl') return {status: 0, stdout: 'used = 0M'};
          return {status: 0, stdout: ''};
        }}), e => e === stop);
    } finally { os.loadavg = oldLoad; }
    return {records, lines, notes};
  };
  try {
    const ok = await exercise(false);
    assert.equal(ok.records[0].recipient, '@user'); assert.equal(ok.records[0].delivered, true); assert.equal(ok.notes.length, 1);
    const bad = await exercise(true);
    assert.equal(bad.records[0].delivered, false); assert.match(bad.lines.join('\n'), /사용자 알림 실패/);
    // 3초 시간 초과(status:null, 빈 stderr)도 실패다 — 빈 문자열이 성공으로 읽히면 안 된다(3라운드 R4)
    const slow = await exercise('timeout');
    assert.equal(slow.records[0].delivered, false); assert.match(slow.lines.join('\n'), /사용자 알림 실패: 시스템 알림 시간 초과/);
    assert.ok(w.requests().length >= 2); // 디스코드는 두 번 다 먼저 시도했다
  } finally {
    for (const [k, v] of [['KADAN_NOTIFY', prev.n], ['KADAN_NOTIFY_ENV_FILE', prev.f]]) v === undefined ? delete process.env[k] : process.env[k] = v;
    w.stop();
  }
});

// 포럼 모양 가짜 서버를 띄우고, 기본 서버의 비밀 파일에 레포 키를 붙인다.
async function forumWorld(known = [], repoKeys = ['kadan'], forumOptions = {}) {
  const base = await world();
  const forum = await world([{status: 204}], {forum: {known, ...forumOptions}});
  let extra = '';
  for (const r of repoKeys) extra += `DISCORD_WEBHOOK_URL_${r.toUpperCase().replace(/[^A-Z0-9]/g, '_')}=http://127.0.0.1:${forum.port}/api/webhooks/333/${TOKEN}\n`;
  fs.appendFileSync(base.envFile, extra);
  const threads = () => { try { return JSON.parse(fs.readFileSync(path.join(base.home, 'notify-threads.json'), 'utf8')).threads; } catch { return null; } };
  return {base, forum, threads, stop: () => { base.stop(); forum.stop(); }};
}
const bodyOf = r => JSON.parse(r.body);

test('포럼: 업무 있는 알림은 첫 번에 thread_name 새 글, 다음부터 thread_id로 이어 붙인다', async () => {
  const w = await forumWorld();
  try {
    const o = {home: w.base.home, env: w.base.env, work: 'kadan/work-x', workTitle: '알림 만들기'};
    assert.equal(notifyUser('a', w.base.fakeSpawn(), {...o, kind: 'mail', key: 'mail:1'}).via, 'discord');
    assert.equal(notifyUser('b', w.base.fakeSpawn(), {...o, kind: 'mail', key: 'mail:2'}).via, 'discord');
    const [first, second] = w.forum.requests();
    assert.equal(bodyOf(first).thread_name, 'kadan/work-x 알림 만들기');
    assert.match(first.url, /wait=true/);
    assert.match(second.url, /thread_id=T1/);
    assert.equal(bodyOf(second).thread_name, undefined);
    assert.deepEqual(w.threads(), {'kadan/work-x': 'T1'});
    assert.equal(w.base.requests().length, 0);
    // 상태 파일에는 주소·토큰·사용자 ID가 없다
    const state = fs.readFileSync(path.join(w.base.home, 'notify-threads.json'), 'utf8');
    for (const x of [TOKEN, USER_ID, '/api/webhooks', 'http']) assert.ok(!state.includes(x), x);
  } finally { w.stop(); }
});

test('포럼: 글 제목은 100자 안, 결정 요청은 업무 글로 가며 멘션이 유지된다', async () => {
  const w = await forumWorld();
  try {
    const store = new DecisionStore(w.base.home, {userNotify: (m, o) => notifyUser(m, w.base.fakeSpawn(), {...o, home: w.base.home, env: w.base.env, workTitle: '긴 제목 '.repeat(40)})});
    const prev = process.env.KADAN_NOTIFY; delete process.env.KADAN_NOTIFY;
    try { store.announce('request', {id: 'd1', card: 'kadan/card-1', work: 'kadan/work-x', question: 'q', options: ['a', 'b'], recommendation: 'a', reason: 'r'}); }
    finally { if (prev !== undefined) process.env.KADAN_NOTIFY = prev; }
    const req = w.forum.requests()[0], body = bodyOf(req);
    assert.ok(body.thread_name.length <= 100 && body.thread_name.startsWith('kadan/work-x'));
    assert.deepEqual(body.allowed_mentions, {users: [USER_ID]});
    assert.ok(body.content.startsWith(`<@${USER_ID}>`));
  } finally { w.stop(); }
});

test('업무 키 없는 알림, 레포 키 없는 레포, 레포 모름은 기본 웹훅으로 간다', async () => {
  const w = await forumWorld();
  try {
    const o = {home: w.base.home, env: w.base.env};
    notifyUser('업무 없음', w.base.fakeSpawn(), o);
    notifyUser('레포 키 없음', w.base.fakeSpawn(), {...o, work: 'zzz/work-1'});
    assert.equal(w.base.requests().length, 2);
    assert.equal(w.forum.requests().length, 0);
    assert.equal(w.threads(), null);
  } finally { w.stop(); }
});

test('기록된 글이 404면 새 글을 한 번 만들고 상태를 바꾼다', async () => {
  const w = await forumWorld();
  try {
    fs.writeFileSync(path.join(w.base.home, 'notify-threads.json'), JSON.stringify({version: 1, threads: {'kadan/work-x': 'GONE'}}));
    const r = notifyUser('a', w.base.fakeSpawn(), {home: w.base.home, env: w.base.env, work: 'kadan/work-x', workTitle: 't'});
    assert.equal(r.via, 'discord');
    const reqs = w.forum.requests();
    assert.equal(reqs.length, 2);
    assert.match(reqs[0].url, /thread_id=GONE/);
    assert.equal(bodyOf(reqs[1]).thread_name, 'kadan/work-x t');
    assert.deepEqual(w.threads(), {'kadan/work-x': 'T1'});
  } finally { w.stop(); }
});

test('레포 이름은 키로 바뀐다(소문자·대시) — 레포 키가 틀리면 오류, 기본으로 새지 않는다', async () => {
  const {repoKeySuffix} = await import('../src/notify-setting.mjs');
  assert.equal(repoKeySuffix('my-app'), 'MY_APP');
  assert.equal(repoKeySuffix('youtube-shorts-auto'), 'YOUTUBE_SHORTS_AUTO');
  assert.equal(repoKeySuffix('kadan'), 'KADAN');
  const w = await forumWorld([], ['youtube-shorts-auto']);
  try {
    const o = {home: w.base.home, env: w.base.env, workTitle: 't'};
    assert.equal(notifyUser('a', w.base.fakeSpawn(), {...o, work: 'youtube-shorts-auto/work-1'}).via, 'discord');
    assert.equal(w.forum.requests().length, 1);
    fs.appendFileSync(w.base.envFile, 'DISCORD_WEBHOOK_URL_ROTTIE=ftp://bad\n');
    const bad = notifyUser('a', w.base.fakeSpawn(), {...o, work: 'rottie/work-1'});
    assert.equal(bad.via, 'system'); assert.equal(bad.discord.outcome, 'config-error');
    assert.equal(w.base.requests().length, 0);
  } finally { w.stop(); }
});

test('같은 알림은 업무 글이든 기본 채널이든 중복 키로 한 번이다', async () => {
  const w = await forumWorld();
  try {
    const o = {home: w.base.home, env: w.base.env, key: 'decision:x:request', workTitle: 't'};
    assert.equal(notifyUser('a', w.base.fakeSpawn(), {...o, work: 'kadan/work-x'}).via, 'discord');
    assert.equal(notifyUser('a', w.base.fakeSpawn(), o).duplicate, true);
    assert.equal(w.base.requests().length + w.forum.requests().length, 1);
  } finally { w.stop(); }
});

test('kadan notify set은 기본 경로 하나만 고정하고 show는 레포 키 이름만 보여 준다', async () => {
  const {cmdNotify} = await import('../src/commands/notify.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-notify-repo-')), out = [];
  const envFile = path.join(home, 's.env');
  fs.writeFileSync(envFile, `DISCORD_WEBHOOK_URL=http://127.0.0.1:1/api/webhooks/1/${TOKEN}\nDISCORD_USER_ID=${USER_ID}\nDISCORD_WEBHOOK_URL_KADAN=http://127.0.0.1:1/api/webhooks/2/${TOKEN}\n`);
  cmdNotify(['set', 'discord'], {'env-file': envFile}, {home, env: {}, print: l => out.push(l)});
  // 2026-10-14: notify set은 secrets set discord와 같은 설정(secrets-setting.json)을 쓴다. 같은 파일을 찾는지로 확인한다.
  assert.deepEqual(effectiveNotifyEnvFile({}, home), {envFile, source: 'setting', error: null});
  assert.match(out.join('\n'), /DISCORD_WEBHOOK_URL_KADAN/);
  assert.ok(!out.join('\n').includes(TOKEN) && !out.join('\n').includes(USER_ID));
});


// --- 2라운드: 포럼 상태 잠금·총시간 상한·장애 직후 건너뛰기·링크된 비밀 파일 ---
const childScript = new URL('./helpers/notify-child.mjs', import.meta.url).pathname;
const runChild = (args, env) => new Promise(resolve => {
  const c = spawn(process.execPath, [childScript, JSON.stringify(args)], {env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'inherit']});
  let out = ''; c.stdout.on('data', d => { out += d; });
  c.on('close', () => resolve(JSON.parse(out.trim().split('\n').at(-1))));
});
const postCount = (w, kind) => w.forum.requests().filter(r => kind === 'new' ? bodyOf(r).thread_name : /thread_id=/.test(r.url)).length;

test('R1 같은 업무의 첫 알림 두 건이 동시에 와도 글은 하나, 두 번째는 그 글에 이어 붙는다', async () => {
  const w = await forumWorld([], ['kadan'], {delayMs: 800});
  try {
    const a = {home: w.base.home, envFile: w.base.envFile, work: 'kadan/work-a', title: 't'};
    const [r1, r2] = await Promise.all([runChild({...a, key: 'k1'}), runChild({...a, key: 'k2'})]);
    assert.equal(r1.via, 'discord'); assert.equal(r2.via, 'discord');
    assert.equal(postCount(w, 'new'), 1); assert.equal(postCount(w, 'old'), 1);
    assert.deepEqual(w.threads(), {'kadan/work-a': 'T1'});
  } finally { w.stop(); }
});

test('R1 다른 업무의 첫 알림 두 건이 동시에 와도 두 업무 기록이 모두 남는다', async () => {
  const w = await forumWorld([], ['kadan'], {delayMs: 800});
  try {
    const a = {home: w.base.home, envFile: w.base.envFile, title: 't'};
    await Promise.all([runChild({...a, work: 'kadan/work-a', key: 'k1'}), runChild({...a, work: 'kadan/work-b', key: 'k2'})]);
    assert.equal(postCount(w, 'new'), 2);
    assert.deepEqual(Object.keys(w.threads()).sort(), ['kadan/work-a', 'kadan/work-b']);
  } finally { w.stop(); }
});

test('R1 지워진 글에 동시 알림 두 건이어도 새 글은 하나, 나머지는 그 새 글을 쓴다', async () => {
  const w = await forumWorld([], ['kadan'], {delayMs: 500});
  try {
    fs.writeFileSync(path.join(w.base.home, 'notify-threads.json'), JSON.stringify({version: 1, threads: {'kadan/work-a': 'GONE', 'kadan/work-keep': 'KEEP'}}));
    const a = {home: w.base.home, envFile: w.base.envFile, work: 'kadan/work-a', title: 't'};
    await Promise.all([runChild({...a, key: 'k1'}), runChild({...a, key: 'k2'})]);
    assert.equal(postCount(w, 'new'), 1);
    assert.deepEqual(w.threads(), {'kadan/work-a': 'T1', 'kadan/work-keep': 'KEEP'});
  } finally { w.stop(); }
});

test('R1 잠금을 시간 안에 못 얻으면 보내지 않고 시스템 알림으로 내려간다(기본 채널로 새지 않음)', async () => {
  const w = await forumWorld();
  try {
    fs.mkdirSync(path.join(w.base.home, 'notify-threads.json.lock'));
    const t0 = Date.now();
    const r = notifyUser('a', w.base.fakeSpawn(), {home: w.base.home, env: w.base.env, work: 'kadan/work-x', workTitle: 't', totalMs: 3000});
    assert.equal(r.discord.outcome, 'lock-timeout'); assert.equal(r.via, 'system');
    assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0}ms`);
    assert.equal(w.forum.requests().length + w.base.requests().length, 0);
    assert.equal(w.threads(), null);
  } finally { w.stop(); }
});

test('R2 429 → 404 → 새 글 → 상태 기록이 겹쳐도 한 알림은 상한(총 예산+강제 종료 여유) 안에 끝난다', async () => {
  const steps = [{status: 429, body: {retry_after: 1}}, {status: 404, body: {}, delayMs: 1500}, {delayMs: 2500}];
  const w = await forumWorld([], ['kadan'], {steps});
  try {
    fs.writeFileSync(path.join(w.base.home, 'notify-threads.json'), JSON.stringify({version: 1, threads: {'kadan/work-x': 'OLD'}}));
    const t0 = Date.now();
    // 예산 4초: 429(1초 대기)+404(1.5초) 뒤 남은 시간이 새 글을 만들기엔 모자라 보내지 않고 시스템 알림으로 내려간다.
    const r = notifyUser('a', w.base.fakeSpawn(), {home: w.base.home, env: w.base.env, work: 'kadan/work-x', workTitle: 't', totalMs: 4000});
    const took = Date.now() - t0;
    assert.ok(took <= 4000 + 2000, `${took}ms`);
    assert.equal(r.via, 'system');
    assert.ok(w.forum.requests().length <= 3);
    assert.deepEqual(w.threads(), {'kadan/work-x': 'OLD'});
  } finally { w.stop(); }
});

test('R2 응답이 계속 느려도 알림 한 번은 예산 안에 끝나고 시스템 알림 spawn에는 짧은 timeout이 붙는다', async () => {
  const w = await world([{hang: true}]);
  try {
    const t0 = Date.now();
    const r = notifyUser('a', w.fakeSpawn(), {home: w.home, env: w.env, totalMs: 3000});
    assert.ok(Date.now() - t0 <= 3000 + 2000, `${Date.now() - t0}ms`);
    assert.equal(r.discord.outcome, 'uncertain');
    assert.equal(w.osCalls[0].options.timeout, 3000);
  } finally { w.stop(); }
});

test('연결 실패 뒤 60초는 디스코드를 건너뛰고 바로 시스템 알림 — 첫 건만 디스코드를 시도한다', async () => {
  const w = await world([{status: 204}], {startServer: false});
  try {
    const first = notifyUser('a', w.fakeSpawn(), {home: w.home, env: w.env, key: 'k1'});
    assert.equal(first.discord.outcome, 'failed');
    const t0 = Date.now();
    const second = notifyUser('b', w.fakeSpawn(), {home: w.home, env: w.env, key: 'k2'});
    const third = notifyUser('c', w.fakeSpawn(), {home: w.home, env: w.env, key: 'k3'});
    assert.ok(Date.now() - t0 < 500);
    assert.equal(second.discord.outcome, 'skipped'); assert.equal(third.discord.outcome, 'skipped');
    assert.equal(w.osCalls.length, 3);
    assert.match(w.log(), /건너뜀/);
    resetDiscordBlock();
  } finally { w.stop(); }
});

test('4xx는 장애가 아니라서 다음 알림을 막지 않는다', async () => {
  const w = await world([{status: 400}]);
  try {
    notifyUser('a', w.fakeSpawn(), {home: w.home, env: w.env});
    notifyUser('b', w.fakeSpawn(), {home: w.home, env: w.env});
    assert.equal(w.requests().length, 2);
  } finally { w.stop(); }
});

test('심볼릭 링크인 비밀 파일도 그대로 읽힌다', async () => {
  const w = await world();
  try {
    const link = path.join(w.dir, 'linked.env');
    fs.symlinkSync(w.envFile, link);
    const r = notifyUser('a', w.fakeSpawn(), {home: w.home, env: {KADAN_NOTIFY: '', KADAN_NOTIFY_ENV_FILE: link}});
    assert.equal(r.via, 'discord');
    assert.equal(w.requests().length, 1);
  } finally { w.stop(); }
});

test('R1 첫 호출이 잠금을 5초 넘게 쥐고 있어도(500 지연 뒤 재시도) 같은 업무는 글 하나', async () => {
  const w = await forumWorld([], ['kadan'], {steps: [{status: 500, body: {}, delayMs: 4900}]});
  try {
    const a = {home: w.base.home, envFile: w.base.envFile, work: 'kadan/work-a', title: 't'};
    const [r1, r2] = await Promise.all([runChild({...a, key: 'k1'}), (async () => { await new Promise(r => setTimeout(r, 300)); return runChild({...a, key: 'k2'}); })()]);
    assert.equal(r1.via, 'discord'); assert.equal(r2.via, 'discord');
    // thread_name 요청은 첫 호출의 500 + 재시도 성공 = 2건이고, 두 번째 호출은 thread_id로 이어 붙는다
    assert.equal(postCount(w, 'new'), 2); assert.equal(postCount(w, 'old'), 1);
    assert.deepEqual(w.threads(), {'kadan/work-a': 'T1'});
  } finally { w.stop(); }
});

test('R1 첫 호출이 잠금을 5초 넘게 쥐고 있어도 다른 업무의 기록이 지워지지 않는다', async () => {
  const w = await forumWorld([], ['kadan'], {steps: [{status: 500, body: {}, delayMs: 4900}]});
  try {
    const a = {home: w.base.home, envFile: w.base.envFile, title: 't'};
    await Promise.all([runChild({...a, work: 'kadan/work-a', key: 'k1'}), (async () => { await new Promise(r => setTimeout(r, 300)); return runChild({...a, work: 'kadan/work-b', key: 'k2'}); })()]);
    assert.deepEqual(Object.keys(w.threads()).sort(), ['kadan/work-a', 'kadan/work-b']);
  } finally { w.stop(); }
});

test('R4 시스템 알림 판정: 성공은 status 0뿐, 시간 초과·신호·오류·비정상 종료는 안전한 사유가 있는 실패', async () => {
  const {systemNotify} = await import('../src/user-notify.mjs');
  assert.equal(systemNotify('a', () => ({status: 0, stderr: ''})), null);
  assert.equal(systemNotify('a', () => ({status: 1, stderr: '비밀 X 알림 문구'})), '시스템 알림 실패(종료 코드 1)');
  assert.equal(systemNotify('a', () => ({status: null, signal: 'SIGTERM', stderr: ''})), '시스템 알림 시간 초과');
  assert.equal(systemNotify('a', () => ({status: null, error: {code: 'ETIMEDOUT'}})), '시스템 알림 시간 초과');
  assert.equal(systemNotify('a', () => ({status: null, error: {code: 'ENOENT'}})), '시스템 알림 실패(ENOENT)');
  assert.equal(systemNotify('a', () => ({status: null})), '시스템 알림 실패(종료 코드 없음)');
  assert.equal(systemNotify('a', () => ({status: 0, error: {code: 'EPIPE'}})), '시스템 알림 실패(EPIPE)');
});

test('R4 실제 spawnSync가 3초 제한에 걸리면(10초 대기 자식, 빈 stderr) 알림 결과가 실패 사유를 담는다', () => {
  const t0 = Date.now();
  const r = notifyUser('a', (cmd, args, options) => spawnSync('sleep', ['10'], options), {home: fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-r4-')), env: {KADAN_NOTIFY: ''}});
  const took = Date.now() - t0;
  assert.equal(r.via, 'system'); assert.equal(r.error, '시스템 알림 시간 초과');
  assert.ok(took >= 2900 && took < 6000, `${took}ms`);
});
