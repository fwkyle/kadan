// 이미 떠 있는 세션을 후임으로 받는 인계(kadan handover … --existing).
// 시험 이름의 "표 N"은 실행 카드의 고정한 동작 표 번호다. 운영 이름(슈퍼감독·kadan-슈퍼감독)은 쓰지 않는다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Handover } from '../src/handover.mjs';
import { HandoverRunner } from '../src/handover-runner.mjs';
import { openTaskIds, effectiveWorkOwnership } from '../src/handover-state.mjs';
import { ownerGenerations, isPreviousOwner } from '../src/owner-generation.mjs';
import { Mailbox } from '../src/mailbox.mjs';
import { appendLedger, readLedger } from '../src/ledger.mjs';
import { createDatabase, writeStorageMarker } from '../src/storage.mjs';
import { collectRoles } from '../src/watch-roles.mjs';

const sha = x => createHash('sha256').update(x).digest('hex');
const session = role => `kadan-${role}`;
const TO_CMD = 'agy --conversation abc --model m';
const CHILD = 'p-하위';

// 선임(기본: 사용자 직속 슈퍼감독)과, 인계보다 먼저 떠 있던 후임(기본: 입양한 슈퍼감독, 사용자 직속 줄 있음).
// options.toRow: 후임의 관계표 상위(null이면 줄 없음). options.toStarts(이름들): 후임의 start·stop 기록을 바꾼다.
// options.toLive: 후임 pane PID(null이면 세션 없음). start는 불리면 실패한다: --existing은 후임을 띄우지 않는다.
function fixture(options = {}) {
  const from = options.from ?? 'p-슈퍼감독', to = options.to ?? 'p-슈퍼감독-2';
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-handover-existing-'));
  const hierarchy = path.join(home, 'parents.json'), context = path.join(home, 'context.md');
  const toCwd = path.join(home, 'successor-cwd');
  fs.mkdirSync(toCwd);
  const toRow = options.toRow === undefined ? '@user' : options.toRow;
  fs.writeFileSync(hierarchy, JSON.stringify(Object.fromEntries([['비서', '@user'],
    [from, options.fromParent ?? '@user'], [CHILD, from], ['else-감독', '@user'],
    ...(toRow === null ? [] : [[to, toRow]]), ...(options.rows ?? [])])));
  fs.writeFileSync(context, '승인된 범위와 현재 카드');
  const profile = value => (value ? { roleProfile: value } : {});
  const toStart = { kind: 'start', role: to, session: session(to), panePid: 30, floor: 'tmux', cmd: TO_CMD, cwd: toCwd,
    ...profile(options.toProfile === undefined ? 'super' : options.toProfile) };
  const rows = [
    { kind: 'start', role: from, session: session(from), panePid: 10, floor: 'tmux', cmd: 'codex', cwd: home,
      ...profile(options.fromProfile === undefined ? 'super' : options.fromProfile) },
    ...(options.toStarts ? options.toStarts(toStart) : [toStart]),
    { kind: 'send', role: from, session: session(from), taskId: 'card-a', by: '사람' },
    { kind: 'send', role: CHILD, session: session(CHILD), taskId: 'card-b', by: from },
    { kind: 'hierarchy-loaded', path: hierarchy, hash: sha(fs.readFileSync(hierarchy)), pid: 100 }];
  const live = new Map([[session(from), 10], [session(CHILD), 20]]);
  const toLive = options.toLive === undefined ? 30 : options.toLive;
  if (toLive !== null) live.set(session(to), toLive);
  const sends = [], stops = [], starts = [], closed = [], notifications = [];
  const env = { KADAN_ROLE: '비서' };
  let clock = Date.parse('2026-11-24T00:00:00Z');
  const f = { home, hierarchy, context, toCwd, rows, live, liveBefore: [...live], sends, stops, starts, closed, notifications, from, to };
  const h = new Handover({ home, env, readEntries: () => rows, record: e => rows.push(e), now: () => clock,
    sleep: ms => { clock += ms; f.onSleep?.(); }, watchAlive: () => true,
    floor: { name: options.floor ?? 'tmux', alive: s => live.has(s), pid: s => live.get(s), stop: s => { stops.push(s); live.delete(s); } },
    start: (...args) => { starts.push(args); throw new Error('시험: --existing 인계가 후임을 띄우려 했다'); },
    send: (role, message) => { if (f.failSend?.(message)) throw new Error('send uncertain'); sends.push({ role, message }); },
    closeWindow: start => { closed.push(start?.role); return {}; },
  });
  const runner = new HandoverRunner(h, {
    spawnProcess: () => { const child = new EventEmitter(); child.pid = process.pid; child.unref = () => {}; return child; },
    notify: (target, message) => { notifications.push({ target, message }); return { status: 'stored', mailId: 'fixture-mail' }; },
  });
  const begin = (extra = {}) => h.begin(from, { to, hierarchy, context, atBoundary: true, existing: true, ...extra });
  const accept = s => {
    // 자동 대기 프로그램은 h.env를 새 객체로 바꾸므로 그때그때 h.env를 읽는다.
    const previous = h.env.KADAN_ROLE; h.env.KADAN_ROLE = s.to;
    const receipt = path.join(home, 'receipt.json');
    fs.writeFileSync(receipt, JSON.stringify({ taskIds: s.taskIds, evidencePaths: [context], nextAction: 'card-a 확인' }));
    try { return h.accept(s.id, receipt); } finally { h.env.KADAN_ROLE = previous; }
  };
  const accepted = () => { const s = begin(); accept(s); return s; };
  const loaded = () => rows.push({ kind: 'hierarchy-loaded', path: hierarchy, hash: sha(fs.readFileSync(hierarchy)), pid: 100 });
  const table = () => JSON.parse(fs.readFileSync(hierarchy, 'utf8'));
  const edit = change => { const next = table(); change(next); fs.writeFileSync(hierarchy, JSON.stringify(next, null, 2) + '\n'); };
  // 자동 대기 프로그램으로 시작해 끝까지 돌린다(시계는 sleep이 민다).
  const run = (options = {}) => {
    const config = runner.prepare(from, options);
    f.s = begin();
    runner.start(f.s.id, config);
    return runner.run(f.s.id);
  };
  // 인계 상태 파일(인수 근거 파일 제외).
  const states = () => {
    const dir = path.join(home, 'handovers');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(n => n.endsWith('.json')).map(n => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
  };
  return Object.assign(f, { h, runner, begin, accept, accepted, loaded, table, edit, run, states });
}

// 표 7의 판정: 후임 세션을 끄지 않았고, 후임 창을 닫지 않았고, 후임을 새로 띄우지도 않았다.
function successorUntouched(f) {
  assert.ok(!f.stops.includes(session(f.to)), '후임 세션을 껐다');
  assert.ok(f.live.has(session(f.to)), '후임 세션이 사라졌다');
  assert.ok(!f.closed.includes(f.to), '후임 창을 닫았다');
  assert.equal(f.starts.length, 0, '후임을 새로 띄웠다');
}
// 표 2·4·5·6의 거절: 선임·후임·관계표가 그대로이고 인계 상태 파일도 인계 기록도 없다.
function rejectedCleanly(f, before) {
  assert.equal(f.stops.length, 0); assert.equal(f.closed.length, 0); assert.equal(f.starts.length, 0);
  assert.deepEqual([...f.live], f.liveBefore);
  assert.equal(fs.readFileSync(f.hierarchy, 'utf8'), before);
  assert.deepEqual(f.states(), []);
  assert.equal(f.rows.filter(e => e.kind === 'handover').length, 0);
  assert.equal(f.sends.length, 0);
}

test('표 1·5: 이미 떠 있는 후임은 생성 단계만 건너뛰고 인수 준비 → accept → finish → 정확한 선임 종료 순서는 그대로다', () => {
  // 후임을 띄운 start 뒤에 같은 pane을 다시 연 기록(명령 없음)이 있어도 그 세대를 띄운 start를 찾는다.
  const f = fixture({ from: 'p-감독', to: 'p-감독-2', fromProfile: 'conductor', toProfile: 'conductor', toRow: '비서',
    toStarts: start => [start, { kind: 'start', role: start.role, session: start.session, panePid: 30, floor: 'tmux', reused: true }] });
  const s = f.begin();
  assert.equal(s.phase, 'prepared'); assert.equal(s.existing, true); assert.equal(s.newPid, '30');
  // 표 5: 상태에 남는 명령·폴더는 선임 값(codex·home)이 아니라 후임 자신의 start 값이다.
  assert.equal(s.command, TO_CMD); assert.equal(s.cwd, f.toCwd);
  assert.equal(f.starts.length, 0); assert.equal(f.stops.length, 0);
  assert.deepEqual(f.sends.map(x => x.role), ['p-감독-2']); assert.match(f.sends[0].message, /^인수 준비: /);
  assert.match(fs.readFileSync(s.packet, 'utf8'), new RegExp(`KADAN_ROLE=p-감독-2 kadan handover accept ${s.id} --receipt`));
  assert.equal(f.rows.filter(e => e.kind === 'handover' && e.phase === 'prepared').length, 1);
  assert.throws(() => f.h.finish(s.id, { timeout: 0 }), /인수 확인/);
  f.accept(s);
  assert.equal(f.h.finish(s.id, { timeout: 0 }).phase, 'routes-pending'); assert.equal(f.stops.length, 0);
  f.loaded();
  assert.equal(f.h.finish(s.id, { timeout: 0 }).phase, 'complete');
  assert.deepEqual(f.stops, ['kadan-p-감독']); assert.deepEqual(f.closed, ['p-감독']);
  successorUntouched(f); assert.equal(f.live.get('kadan-p-감독-2'), 30);
  assert.deepEqual(f.table(), { '비서': '@user', 'p-감독-2': '@user', [CHILD]: 'p-감독-2', 'else-감독': '@user' });
  assert.deepEqual(openTaskIds(f.rows, 'p-감독'), []); assert.deepEqual(openTaskIds(f.rows, 'p-감독-2'), ['card-a']);
  assert.equal(f.sends.filter(x => x.role === 'p-감독-2' && x.message.startsWith('인계 전환 완료')).length, 1);
  assert.equal(f.sends.filter(x => x.role === CHILD && x.message.startsWith('직속 감독 인계')).length, 1);
  // 후임의 start 기록은 늘지 않았다(새 세대를 만들지 않았다).
  assert.equal(f.rows.filter(e => e.kind === 'start' && e.role === 'p-감독-2').length, 2);
});

const NOT_READY = {
  '후임 없음(세션도 기록도 없음)': { toStarts: () => [], toLive: null },
  '후임 죽음(기록은 있고 세션 없음)': { toLive: null },
  'PID 다름': { toLive: 31 },
  'start 기록 없음': { toStarts: () => [] },
  '다시 연 기록뿐(이 세대를 띄운 start 없음)': { toStarts: ({ cmd, cwd, ...reopened }) => [reopened] },
  '마지막 기록이 stop': { toStarts: start => [start, { kind: 'stop', role: start.role, session: start.session }] },
  '다른 바닥': { toStarts: start => [{ ...start, floor: 'herdr' }] },
};
for (const [name, options] of Object.entries(NOT_READY)) test(`표 2: ${name}이면 거절하고 선임·후임·관계표를 그대로 둔다`, () => {
  const f = fixture(options), before = fs.readFileSync(f.hierarchy, 'utf8');
  assert.throws(() => f.begin(), /--existing 후임 확인 실패/);
  rejectedCleanly(f, before);
});

test('표 1: 실행 명령 없이 시작한 후임은 거절하고 고칠 방법을 한 줄로 알린다', () => {
  // kadan start <역할>을 --cmd 없이 친 세션: start 기록은 있지만 실행 명령이 없다.
  const f = fixture({ toStarts: ({ cmd, ...noCommand }) => [noCommand] }), before = fs.readFileSync(f.hierarchy, 'utf8');
  assert.throws(() => f.begin(), error => {
    assert.match(error.message, /--existing 후임 확인 실패/);
    assert.match(error.message, /실행 명령이 기록된 세션만 후임이 될 수 있다/);
    assert.match(error.message, /kadan adopt 또는 kadan start --cmd로 띄운 세션/);
    assert.equal(error.message.split('\n').length, 1);
    return true;
  });
  rejectedCleanly(f, before);
  assert.match(fs.readFileSync(new URL('../docs/handover.md', import.meta.url), 'utf8'),
    /실행 명령이 기록된 세션\(`kadan adopt` 또는 `kadan start --cmd`로 띄운 세션\)만/);
});

// 후임 줄이 이미 있어도(상위가 사용자·다른 역할·선임 자신) 받고, 줄이 없어도 받는다.
for (const toRow of ['@user', '비서', 'p-슈퍼감독', null]) {
  const label = toRow === null ? '줄 없음' : `상위 ${toRow}`;
  test(`표 3: 후임 관계표 ${label}(하위 없음)은 허용하고 전환한다`, () => {
    const f = fixture({ toRow }), s = f.accepted();
    // 준비 시점의 후임 줄을 "준비 뒤 변경"으로 읽지 않는다.
    assert.equal(f.h.finish(s.id, { timeout: 0 }).phase, 'routes-pending');
    assert.equal(f.h.status(s.id).routes.toBefore, toRow);
    f.loaded(); assert.equal(f.h.finish(s.id, { timeout: 0 }).phase, 'complete');
    assert.deepEqual(f.table(), { '비서': '@user', 'p-슈퍼감독-2': '@user', [CHILD]: 'p-슈퍼감독-2', 'else-감독': '@user' });
    // 후임이 선임 아래 줄이었어도 자기에게 "직속 감독 인계"를 보내지 않는다.
    assert.equal(f.sends.filter(x => x.role === f.to && x.message.startsWith('직속 감독 인계')).length, 0);
    successorUntouched(f);
  });
  test(`표 3: 후임 관계표 ${label}은 전환 뒤 abort하면 원래 줄(toBefore)로 돌아온다`, () => {
    const f = fixture({ toRow }), original = f.table(), s = f.accepted();
    f.h.finish(s.id, { timeout: 0 });
    assert.equal(f.table()[f.from], undefined);
    assert.equal(f.h.abort(s.id).phase, 'aborted');
    assert.deepEqual(f.table(), original);
    assert.equal(f.stops.length, 0); successorUntouched(f);
  });
}

const BAD_SHAPE = {
  '후임 아래 하위 역할': [{ rows: [['p-후임하위', 'p-슈퍼감독-2']] }, /후임 아래에 하위 역할이 있음\(p-후임하위\)/],
  '후임이 선임의 직속 상위': [{ fromParent: 'p-슈퍼감독-2' }, /후임이 선임의 상위\(순환\)/],
  '후임이 선임의 두 단계 위': [{ fromParent: 'p-중간', rows: [['p-중간', 'p-슈퍼감독-2']] }, /후임이 선임의 상위\(순환\)/],
};
for (const [name, [options, reason]] of Object.entries(BAD_SHAPE)) test(`표 4: ${name}이면 거절한다(선임 보존)`, () => {
  const f = fixture(options), before = fs.readFileSync(f.hierarchy, 'utf8');
  assert.throws(() => f.begin(), reason);
  rejectedCleanly(f, before);
});

for (const extra of [{ cmd: 'claude' }, { cwd: os.tmpdir() }, { cmd: 'claude', cwd: os.tmpdir() }])
  test(`표 5: --existing에 ${Object.keys(extra).map(k => `--${k}`).join('·')}를 같이 주면 거절한다(조용히 무시하지 않는다)`, () => {
    const f = fixture(), before = fs.readFileSync(f.hierarchy, 'utf8');
    assert.throws(() => f.begin(extra), /--existing은 --cmd·--cwd와 함께 쓸 수 없다/);
    rejectedCleanly(f, before);
  });

const NOT_SUPER = {
  '후임 프로필이 conductor': { toProfile: 'conductor' },
  '후임 프로필 기록 없음': { toProfile: null },
  '후임 이름이 슈퍼감독 꼴이 아님(…-슈퍼감독-agy)': { to: 'p-슈퍼감독-agy' },
};
for (const [name, options] of Object.entries(NOT_SUPER)) test(`표 6: 선임이 슈퍼감독인데 ${name}이면 거절하고 고칠 방법을 한 줄로 알린다`, () => {
  const f = fixture(options), before = fs.readFileSync(f.hierarchy, 'utf8');
  assert.throws(() => f.begin(), error => {
    assert.match(error.message, /슈퍼감독 자리를 받을 수 없음/);
    assert.match(error.message, /kadan adopt <이름> --profile super/);
    assert.match(error.message, /…슈퍼감독 또는 …슈퍼감독-숫자/);
    assert.equal(error.message.split('\n').length, 1);
    return true;
  });
  rejectedCleanly(f, before);
});

// 어떤 실패·중단·시간 초과에서도 후임 세션·창을 건드리지 않는다. 값은 "선임도 그대로인가"(책임 이전 앞의 실패면 true).
const FAILURES = {
  '인수 준비 전송 실패': f => { f.failSend = m => m.startsWith('인수 준비'); assert.throws(() => f.begin(), /선임 보존/); return true; },
  'prepared에서 abort': f => { assert.match(f.h.abort(f.begin().id).warning, /끄지 않고 그대로 둔다/); return true; },
  'accepted에서 abort': f => { assert.equal(f.h.abort(f.accepted().id).phase, 'aborted'); return true; },
  'routes-pending에서 abort': f => { const s = f.accepted(); f.h.finish(s.id, { timeout: 0 }); f.h.abort(s.id); return true; },
  '승인 문서가 바뀌어 finish 거절': f => {
    const s = f.accepted(); fs.appendFileSync(f.context, 'changed');
    assert.throws(() => f.h.finish(s.id, { timeout: 0 }), /변경/); return true;
  },
  '관계표가 준비 뒤 바뀌어 finish 거절': f => {
    const s = f.accepted(); f.edit(t => { t['p-새하위'] = f.from; });
    assert.throws(() => f.h.finish(s.id, { timeout: 0 }), /관계표가 준비 후 변경됨/); return true;
  },
  '자동 대기: 인수 확인 시간 초과': f => { assert.equal(f.run({ waitTimeout: 3 }).status, 'timed-out'); return true; },
  '자동 대기: watch 반영 시간 초과': f => {
    f.onSleep = () => { if (f.h.status(f.s.id).phase === 'prepared') f.accept(f.s); };
    const result = f.run({ waitTimeout: 3 });
    assert.equal(result.status, 'timed-out'); assert.equal(result.phase, 'routes-pending'); return true;
  },
  '자동 대기: 대기 중 승인 문서 변경': f => {
    f.onSleep = () => { if (f.h.status(f.s.id).phase === 'prepared') { f.accept(f.s); fs.appendFileSync(f.context, 'changed'); } };
    assert.equal(f.run({ waitTimeout: 3 }).status, 'failed'); return true;
  },
  '선임 종료 뒤 활성화 전송 실패': f => {
    const s = f.accepted(); f.h.finish(s.id, { timeout: 0 }); f.loaded();
    f.failSend = m => m.startsWith('인계 전환 완료');
    assert.throws(() => f.h.finish(s.id, { timeout: 0 }), /send uncertain/);
    assert.equal(f.h.status(s.id).phase, 'activation-pending'); return false;
  },
};
for (const [name, scenario] of Object.entries(FAILURES)) test(`표 7: ${name}에서도 후임 세션·창을 끄지 않는다`, () => {
  const f = fixture(), preserved = scenario(f);
  successorUntouched(f);
  if (preserved) { assert.equal(f.stops.length, 0); assert.equal(f.live.get(session(f.from)), 10); }
  else assert.deepEqual(f.stops, [session(f.from)]);
});

test('표 8: 슈퍼감독(상위 @user) 인계는 finish 뒤 후임 줄의 상위가 @user이고 선임의 하위가 후임 아래로 옮겨진다', () => {
  const g = fixture({ rows: [['p-감독-b', 'p-슈퍼감독']] });
  g.live.set(session('p-감독-b'), 21);
  g.onSleep = () => { if (g.h.status(g.s.id).phase === 'prepared') g.accept(g.s); else g.loaded(); };
  const done = g.run({ waitTimeout: 60 });
  assert.equal(done.status, 'complete'); assert.equal(done.phase, 'complete');
  const table = g.table();
  assert.equal(table['p-슈퍼감독-2'], '@user'); assert.equal(table[CHILD], 'p-슈퍼감독-2'); assert.equal(table['p-감독-b'], 'p-슈퍼감독-2');
  assert.ok(!Object.hasOwn(table, 'p-슈퍼감독'));
  assert.deepEqual(table, { '비서': '@user', 'p-슈퍼감독-2': '@user', [CHILD]: 'p-슈퍼감독-2', 'else-감독': '@user', 'p-감독-b': 'p-슈퍼감독-2' });
  assert.deepEqual(g.stops, ['kadan-p-슈퍼감독']); successorUntouched(g);
  // 살아 있는 하위 둘에게 새 수신자를 알렸다.
  assert.deepEqual(g.sends.filter(x => x.message.startsWith('직속 감독 인계')).map(x => x.role).sort(), [CHILD, 'p-감독-b'].sort());
  assert.equal(g.notifications.length, 1);
});

test('표 9: --existing 없는 인계는 지금처럼 떠 있는 이름·과거에 쓴 이름·이미 있는 후임 줄을 거절한다', () => {
  const f = fixture();
  assert.throws(() => f.begin({ existing: false }), /후임 이름이 사용 중이거나 과거 사용됨/);
  const dead = fixture({ toLive: null });
  assert.throws(() => dead.begin({ existing: false }), /후임 이름이 사용 중이거나 과거 사용됨/);
  const fresh = fixture({ toStarts: () => [], toLive: null });
  assert.throws(() => fresh.begin({ existing: false }), /선임 관계가 없거나 후임 관계가 이미 있음/);
  for (const g of [f, dead, fresh]) { assert.deepEqual(g.states(), []); assert.equal(g.stops.length, 0); assert.equal(g.starts.length, 0); }
});

// 먼저 할 것 1의 근거: 인계 기록을 읽는 쪽(우편 수신·세대, 업무 owner·세대, 미완료 발령, 감시 발령)이
// "후임은 인계가 새로 띄운 세션"을 전제하지 않는다. 후임은 인계보다 먼저 시작했고 자기 우편·발령·업무가 이미 있다.
test('소비처: 인계보다 먼저 시작한 후임의 자기 우편·발령·업무는 그대로이고 선임 몫만 후임으로 넘어온다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-handover-existing-ledger-'));
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  const from = 'p-슈퍼감독', to = 'p-슈퍼감독-2';
  const at = n => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
  const record = entry => appendLedger(entry, home), box = role => new Mailbox(home, role);
  // 후임 이름은 예전에도 쓰였다(세대 경계가 있다). 지금 세대는 인계보다 먼저 시작했다.
  record({ kind: 'start', role: to, session: session(to), panePid: 29, cmd: 'claude --model m', t: at(0) });
  record({ kind: 'stop', role: to, session: session(to), t: at(1) });
  record({ kind: 'start', role: from, session: session(from), panePid: 10, cmd: 'codex', t: at(2) });
  record({ kind: 'start', role: to, session: session(to), panePid: 30, cmd: 'claude --model m', t: at(3) });
  const own = box(to).send({ by: 'p-감독', message: '후임이 원래 받던 우편' });
  const forFrom = box(from).send({ by: 'p-감독', message: '선임 앞 질문', expectReply: true });
  const fromAsked = box(to).send({ by: from, message: '선임이 후임에게 한 질문', expectReply: true });
  const toAsked = box(from).send({ by: to, message: '후임이 선임에게 한 질문', expectReply: true });
  record({ kind: 'send', role: from, session: session(from), taskId: 'card-a', by: '사람', t: at(4) });
  record({ kind: 'send', role: to, session: session(to), taskId: 'card-own', by: '사람', t: at(5) });
  record({ kind: 'handover', phase: 'transferred', from, to, handoverId: 'h-existing', taskIds: ['card-a'], t: at(10) });

  // 우편: 선임 앞 우편이 후임 수신함으로 오고, 후임이 원래 받던 우편도 지금 세대 몫으로 남는다.
  const received = box(to).list({ all: true });
  for (const letter of [own, forFrom, fromAsked, toAsked]) {
    const found = received.find(e => e.mailId === letter.mailId);
    assert.ok(found, `후임 수신함에 없음: ${letter.mailId}`);
    assert.notEqual(found.previousGeneration, true);
  }
  assert.equal(box(from).list({ all: true }).length, 0);
  assert.equal(box(to).read(forFrom.mailId).currentRecipient, to);
  assert.equal(box(to).read(forFrom.mailId).currentSender, 'p-감독');
  // 선임과 후임이 서로 주고받던 질문은 양쪽이 모두 후임이 된다(같은 책임자). 후임이 직접 취소해 닫을 수 있다.
  for (const letter of [fromAsked, toAsked]) {
    const merged = box(to).read(letter.mailId);
    assert.equal(merged.currentRecipient, to); assert.equal(merged.currentSender, to);
    assert.equal(merged.replyStatus, 'waiting');
    box(to).cancel(letter.mailId, to);
    assert.equal(box(to).read(letter.mailId).replyStatus, 'cancelled');
  }

  // 미완료 발령: 선임의 card-a가 넘어오고 후임 자신의 card-own은 그대로다.
  const entries = readLedger(home);
  assert.deepEqual(openTaskIds(entries, from), []);
  assert.deepEqual(openTaskIds(entries, to), ['card-a', 'card-own']);
  // 업무 owner: 선임 업무는 인계 시각부터 후임 몫이고, 후임이 원래 맡던 업무는 그 시각 그대로다.
  assert.deepEqual(effectiveWorkOwnership({ key: 'p/work-a', owner: from, at: at(2) }, entries), { owner: to, at: at(10) });
  assert.deepEqual(effectiveWorkOwnership({ key: 'p/work-b', owner: to, at: at(6) }, entries), { owner: to, at: at(6) });
  // 세대: 후임의 지금 세대(at 3)는 인계(at 10)보다 앞이라, 넘겨받은 책임을 이전 세대 몫으로 읽지 않는다.
  const generations = ownerGenerations(entries);
  assert.equal(isPreviousOwner(generations, to, at(10)), false);
  assert.equal(isPreviousOwner(generations, to, at(6)), false);
  assert.equal(isPreviousOwner(generations, to, at(1)), true); // 옛 세대 때 붙은 책임만 이전 세대다
  // 감시 발령: 후임 세션의 발령에 자기 카드와 넘겨받은 카드가 함께 있다.
  const floor = { list: () => [{ session: session(from), pid: 10 }, { session: session(to), pid: 30 }], read: () => '' };
  const observed = collectRoles(floor, entries, null, null, { hookHome: home }).observations;
  assert.deepEqual([...observed.get(session(to)).completionDispatches.keys()].sort(), ['card-a', 'card-own']);
  assert.deepEqual([...observed.get(session(from)).completionDispatches.keys()], []);
  assert.equal(observed.get(session(to)).completionDispatches.get('card-a').handoverId, 'h-existing');
});

// 실제 CLI·격리 tmux: 살아 있는 후임 세션을 그대로 두고 인계가 끝난다. 인수 확인은 꾸러미의 안내 명령만으로 한다.
test('실제 CLI(표 1·5·7·8): 떠 있는 슈퍼감독 후임으로 인계하면 후임 pane은 그대로이고 선임만 꺼진다',
  { skip: spawnSync('tmux', ['-V']).status !== 0, timeout: 60000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-handover-existing-cli-'));
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  const env = { ...process.env, KADAN_HOME: home, KADAN_SOCKET: path.basename(home), KADAN_WINDOW: 'none', KADAN_FLOOR: 'tmux' };
  const call = (args, role = '비서') => spawnSync(process.execPath, [cli, ...args],
    { env: { ...env, KADAN_ROLE: role }, cwd: os.tmpdir(), encoding: 'utf8' });
  const run = (args, role) => { const r = call(args, role); assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout; };
  const tmux = args => spawnSync('tmux', ['-L', env.KADAN_SOCKET, ...args], { encoding: 'utf8' });
  const alive = role => tmux(['has-session', '-t', `=kadan-${role}`]).status === 0;
  const panePid = role => tmux(['display-message', '-p', '-t', `=kadan-${role}:`, '#{pane_pid}']).stdout.trim();
  const from = 'p-슈퍼감독', to = 'p-슈퍼감독-2';
  const graph = path.join(home, 'parents.json'), context = path.join(home, 'context.md'), receipt = path.join(home, 'receipt.json');
  fs.writeFileSync(graph, JSON.stringify({ [from]: '@user', [to]: '@user', 'p-감독': from }));
  fs.writeFileSync(context, '격리 시험 범위');
  const begin = ['--to', to, '--at-boundary', '--hierarchy', graph, '--context', context];
  try {
    run(['start', from, '--cmd', 'cat', '--profile', 'super']);
    // 후임은 인계와 무관하게 먼저 떠 있던 세션이다(에코를 꺼 화면 문구가 깨지지 않게 한다).
    run(['start', to, '--cmd', 'stty -echo; exec cat', '--profile', 'super']);
    const before = panePid(to), startsBefore = readLedger(home).filter(e => e.kind === 'start' && e.role === to).length;
    assert.ok(before);
    const tableBefore = fs.readFileSync(graph, 'utf8');
    // 표 5: --cmd를 같이 주면 거절하고 아무것도 만들지 않는다.
    const refused = call(['handover', from, '--manual', '--existing', ...begin, '--cmd', 'cat']);
    assert.notEqual(refused.status, 0); assert.match(refused.stderr + refused.stdout, /--existing은 --cmd·--cwd와 함께 쓸 수 없다/);
    assert.equal(fs.readdirSync(path.join(home, 'handovers')).filter(n => n.endsWith('.json')).length, 0);
    assert.equal(fs.readFileSync(graph, 'utf8'), tableBefore); assert.ok(alive(from)); assert.equal(panePid(to), before);
    const s = JSON.parse(run(['handover', from, '--manual', '--existing', ...begin]));
    assert.equal(s.phase, 'prepared'); assert.equal(s.existing, true); assert.equal(s.newPid, before); assert.equal(s.runner, null);
    assert.equal(readLedger(home).filter(e => e.kind === 'start' && e.role === to).length, startsBefore);
    const state = JSON.parse(fs.readFileSync(path.join(home, 'handovers', `${s.id}.json`), 'utf8'));
    assert.equal(state.command, 'stty -echo; exec cat'); assert.equal(fs.realpathSync(state.cwd), fs.realpathSync(os.tmpdir()));
    // 인수 확인: 꾸러미에 적힌 명령 줄 그대로(kadan만 이 CLI로 바꿔) 실행한다. 부르는 쪽 환경의 KADAN_ROLE은 다른 역할이다.
    const line = fs.readFileSync(state.packet, 'utf8').split('\n').find(text => text.includes('kadan handover accept'));
    const [, role, id] = line.match(/^KADAN_ROLE=(\S+) kadan handover accept (\S+) --receipt <절대경로>/);
    assert.equal(role, to); assert.equal(id, s.id);
    fs.writeFileSync(receipt, JSON.stringify({ taskIds: [], evidencePaths: [context], nextAction: '시험 종료' }));
    const accepted = spawnSync('sh', ['-c', 'KADAN_ROLE="$1" "$2" "$3" handover accept "$4" --receipt "$5"', 'accept',
      role, process.execPath, cli, id, receipt], { env: { ...env, KADAN_ROLE: '다른-역할' }, cwd: os.tmpdir(), encoding: 'utf8' });
    assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout);
    assert.equal(JSON.parse(run(['handover', 'status', s.id])).phase, 'accepted');
    assert.equal(JSON.parse(run(['handover', 'finish', s.id, '--timeout', '0'])).phase, 'routes-pending');
    assert.ok(alive(from)); assert.equal(panePid(to), before);
    appendLedger({ kind: 'hierarchy-loaded', path: graph, hash: sha(fs.readFileSync(graph)), pid: process.pid }, home);
    assert.equal(JSON.parse(run(['handover', 'finish', s.id, '--timeout', '0'])).phase, 'complete');
    // 표 8: 후임 줄의 상위는 @user, 선임의 하위는 후임 아래. 선임만 꺼지고 후임 pane은 처음 그 프로세스다.
    assert.deepEqual(JSON.parse(fs.readFileSync(graph, 'utf8')), { [to]: '@user', 'p-감독': to });
    assert.equal(alive(from), false); assert.ok(alive(to)); assert.equal(panePid(to), before);
    assert.equal(readLedger(home).filter(e => e.kind === 'start' && e.role === to).length, startsBefore);
    assert.deepEqual(readLedger(home).filter(e => e.kind === 'stop').map(e => e.role), [from]);
    const captured = tmux(['capture-pane', '-p', '-J', '-S', '-2000', '-t', `=kadan-${to}:`]);
    assert.match(captured.stdout, /인수 준비/); assert.match(captured.stdout, /인계 전환 완료/);
  } finally {
    for (const role of [from, to]) call(['stop', role]);
  }
});

// 검수 exec-5a2e4b67 재현: 공용 옵션 해석기는 반복된 옵션을 배열로, 뒤에 온 낱말을 값으로 만든다.
// --existing이 true 하나가 아니면 새 세션 인계로 흘러 없는 후임을 새로 띄웠다. 사용법 오류(종료 2)로 거절해야 한다.
const MALFORMED = {
  '두 번 반복': (from, to) => [from, '--to', to, '--existing', '--existing'],
  '세 번 반복': (from, to) => [from, '--existing', '--to', to, '--existing', '--existing'],
  '값이 붙음': (from, to) => [from, '--to', to, '--existing', 'yes'],
  '값이 붙고 반복': (from, to) => [from, '--to', to, '--existing', 'yes', '--existing'],
  '선임 이름 앞에 둠(이름이 값으로 읽힘)': (from, to) => ['--existing', from, '--to', to],
};
test('실제 CLI(표 2): --existing이 반복되거나 값이 붙으면 사용법 오류로 거절하고 없는 후임을 띄우지 않는다',
  { skip: spawnSync('tmux', ['-V']).status !== 0, timeout: 60000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-handover-existing-flag-'));
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  const env = { ...process.env, KADAN_HOME: home, KADAN_SOCKET: path.basename(home), KADAN_WINDOW: 'none', KADAN_FLOOR: 'tmux', KADAN_ROLE: '비서' };
  const call = args => spawnSync(process.execPath, [cli, ...args], { env, cwd: os.tmpdir(), encoding: 'utf8' });
  const tmux = args => spawnSync('tmux', ['-L', env.KADAN_SOCKET, ...args], { encoding: 'utf8' });
  const alive = role => tmux(['has-session', '-t', `=kadan-${role}`]).status === 0;
  const from = 'p-감독', to = 'p-없는-후임';
  const graph = path.join(home, 'parents.json'), context = path.join(home, 'context.md');
  fs.writeFileSync(graph, JSON.stringify({ [from]: '@user' })); fs.writeFileSync(context, '격리 시험 범위');
  const rest = ['--manual', '--at-boundary', '--hierarchy', graph, '--context', context];
  const states = () => (fs.existsSync(path.join(home, 'handovers'))
    ? fs.readdirSync(path.join(home, 'handovers')).filter(n => n.endsWith('.json')) : []);
  try {
    const started = call(['start', from, '--cmd', 'cat']);
    assert.equal(started.status, 0, started.stderr + started.stdout);
    const table = fs.readFileSync(graph, 'utf8'), ledger = readLedger(home).length;
    // 대조: 옵션을 한 번만 주면 없는 후임이라 거절하고(종료 1) 아무것도 만들지 않는다.
    const control = call(['handover', from, '--to', to, '--existing', ...rest]);
    assert.equal(control.status, 1, control.stderr + control.stdout);
    assert.match(control.stderr, /--existing 후임 확인 실패\(세션이 살아 있지 않음\)/);
    for (const [name, shape] of Object.entries(MALFORMED)) {
      const result = call(['handover', ...shape(from, to), ...rest]);
      assert.equal(result.status, 2, `${name}: ${result.stderr}${result.stdout}`);
      assert.match(result.stderr, /--existing은 값 없는 옵션이다/, name);
      // 후임 생성·상태 파일·전송·원장 기록이 모두 0이다.
      assert.equal(alive(to), false, `${name}: 없는 후임을 새로 띄웠다`);
      assert.deepEqual(states(), [], name);
      assert.equal(readLedger(home).length, ledger, `${name}: 원장에 기록이 늘었다`);
      assert.equal(fs.readFileSync(graph, 'utf8'), table, name);
      assert.ok(alive(from), name);
    }
  } finally {
    for (const role of [from, to]) call(['stop', role]);
  }
});
