// 놀고 있음 PR-3: 위임받은 쪽이 결과 우편을 owner에게 보내면 업무 차례를 owner로 돌린다 (실제 CLI·tmux 바닥, 격리 홈·알림 off).
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {DecisionStore} from '../src/decisions.mjs';
import {planTurnReturn, applyTurnReturn, undoCommand} from '../src/mail-turn-return.mjs';

process.env.KADAN_NOTIFY = 'off';
const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
const OWNER = 'p-감독', WORKER = 'p-작업자', SUPER = 'p-슈퍼감독', UPPER = 'p-상위', HEIR = 'p-후임';

function fixture(roles = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-turn-return-'));
  const socket = path.basename(home);
  const env = {...process.env, KADAN_HOME: home, KADAN_SOCKET: socket, KADAN_WINDOW: 'none', KADAN_FLOOR: 'tmux', KADAN_NOTIFY: 'off'};
  const call = (role, ...args) => spawnSync(process.execPath, [cli, ...args], {env: {...env, KADAN_ROLE: role}, cwd: home, encoding: 'utf8', input: '', timeout: 15000});
  const works = new WorkStore(home);
  const receiver = path.join(home, 'receiver.mjs');
  fs.writeFileSync(receiver, "import fs from 'node:fs';import path from 'node:path';process.stdin.on('data',b=>fs.appendFileSync(path.join(process.env.KADAN_HOME,process.env.KADAN_ROLE+'.received'),b));\n");
  for (const role of roles) {
    const started = spawnSync(process.execPath, [cli, 'start', role, '--hidden', '--cmd', `${quote(process.execPath)} ${quote(receiver)}`], {env: {...env, KADAN_ROLE: ''}, cwd: home, encoding: 'utf8', timeout: 15000});
    assert.equal(started.status, 0, started.stderr);
  }
  const received = (role, text = '우편ID') => {
    const file = path.join(home, role + '.received'), end = Date.now() + 4000;
    while (Date.now() < end && (!fs.existsSync(file) || !fs.readFileSync(file, 'utf8').includes(text))) pause();
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  };
  const stop = () => { for (const role of roles) spawnSync('tmux', ['-L', socket, 'kill-session', '-t', `kadan-${role}`], {env}); };
  const mkWork = (id, owner = OWNER) => works.create({key: `repo/${id}`, title: id, goal: 'g', scope: 's', acceptance: 'a', owner, repoPath: home});
  const setTurn = (id, turnOwner) => works.change(`repo/${id}`, 'update', {turnOwner}, {revision: works.get(`repo/${id}`).revision, by: '시험', note: '차례 준비'});
  const turn = id => works.get(`repo/${id}`).turnOwner;
  return {home, env, call, works, received, stop, mkWork, setTurn, turn};
}
const shared = hasTmux ? fixture([OWNER, WORKER, SUPER, UPPER, HEIR]) : null;
after(() => shared?.stop());
const opts = {skip: !hasTmux};

test('양성: 작업자(차례 보유)가 owner에게 --work 결과 우편 → 차례가 owner로, 꼬리·원장 note·영수증 되돌리기, 되돌리기 실행하면 원래 차례', opts, () => {
  const f = shared; f.mkWork('w1'); f.setTurn('w1', WORKER);
  const decision = new DecisionStore(f.home, {notify: () => {}, userNotify: () => null}).request(null, {question: '합칠까요?', work: 'repo/w1', chat: true}, SUPER);
  const before = f.works.get('repo/w1').revision;
  const sent = f.call(WORKER, 'mail', OWNER, '--work', 'repo/w1', '결과 보고');
  assert.equal(sent.status, 0, sent.stderr);
  assert.equal(f.turn('w1'), OWNER);
  const work = f.works.get('repo/w1');
  assert.equal(work.revision, before + 1);
  const mailId = readLedger(f.home).filter(e => e.kind === 'send').at(-1).mailId;
  assert.equal(work.by, WORKER);
  assert.match(work.note, new RegExp(`^우편 ${mailId}로 owner에게 차례 반환`));
  // 받는 owner 화면의 꼬리: 일반 안내(새 revision 없음)
  const screen = f.received(OWNER);
  assert.match(screen, new RegExp(`차례를 ${OWNER}에게 돌렸습니다`));
  assert.match(screen, /--revision N --turn-owner 'p-작업자' --note '차례 되돌림'/);
  // 보낸 쪽 영수증과 원장 note: 실제 revision이 채워진 같은 명령
  const json = sent.stdout.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).find(x => x?.turnReturn).turnReturn;
  assert.equal(json.revision, work.revision); assert.equal(json.mailId, mailId);
  const undo = `kadan work update 'repo/w1' --revision ${work.revision} --turn-owner '${WORKER}' --note '차례 되돌림'`;
  assert.equal(json.undoCommand, undo);
  assert.ok(work.note.endsWith(`되돌리기: ${undo}`));
  // PR-2 접점: work-command를 거치지 않으므로 열린 채팅 결정은 닫히지 않는다
  assert.equal(new DecisionStore(f.home, {notify: () => {}, userNotify: () => null}).list().find(d => d.id === decision.id).status, 'open');
  // 영수증의 명령을 그대로 실행하면 원래 차례로 돌아간다
  const undone = spawnSync('sh', ['-c', undo.replace(/^kadan/, `${quote(process.execPath)} ${quote(cli)}`)], {env: {...f.env, KADAN_ROLE: 'p-아무개'}, cwd: f.home, encoding: 'utf8', timeout: 15000});
  assert.equal(undone.status, 0, undone.stderr);
  assert.equal(f.turn('w1'), WORKER);
});

test('양성: 슈퍼감독(owner 아님, 차례 보유)이 owner에게 보내면 옮긴다. 영수증 JSON의 명령 문자열이 실제 CLI 인자와 같다', opts, () => {
  const f = shared; f.mkWork('w2'); f.setTurn('w2', SUPER);
  const sent = f.call(SUPER, 'mail', OWNER, '--work', 'repo/w2', '검수 결과');
  assert.equal(sent.status, 0, sent.stderr);
  assert.equal(f.turn('w2'), OWNER);
});

test('--reply-final: owner에게 보내면 옮기고, owner가 아닌 쪽에 보내면 옮기지 않는다', opts, () => {
  const f = shared; f.mkWork('w3'); f.setTurn('w3', SUPER);
  const ask = (from, to) => {
    const r = f.call(from, 'mail', to, '--work', 'repo/w3', '--expect-reply', '질문');
    assert.equal(r.status, 0, r.stderr);
    return readLedger(f.home).filter(e => e.kind === 'send').at(-1).mailId;
  };
  // 작업자가 슈퍼감독에게 질문(owner 아님) → 슈퍼감독이 작업자에게 최종 답: 받는 쪽이 owner가 아니라 옮기지 않는다
  const q1 = ask(WORKER, SUPER);
  assert.equal(f.turn('w3'), SUPER);
  const r1 = f.call(SUPER, 'mail', WORKER, '--reply-to', q1, '--reply-final', '답');
  assert.equal(r1.status, 0, r1.stderr); assert.equal(f.turn('w3'), SUPER);
  // owner가 슈퍼감독에게 질문 → 슈퍼감독이 owner에게 최종 답: 옮긴다
  const q2 = ask(OWNER, SUPER);
  assert.equal(f.turn('w3'), SUPER, '질문한 owner는 보낸 쪽이 owner라 옮기지 않는다');
  const r2 = f.call(SUPER, 'mail', OWNER, '--reply-to', q2, '--reply-final', '답');
  assert.equal(r2.status, 0, r2.stderr); assert.equal(f.turn('w3'), OWNER);
});

test('음성: owner→작업자·owner→상위·보낸 쪽이 차례 보유자 아님·받는 쪽이 owner 아님·--keep-turn·사람 명의', opts, () => {
  const f = shared; f.mkWork('n1');
  const tail = /차례를 .* 돌렸습니다/;
  const expectStay = (id, from, to, extra = [], who) => {
    const r = f.call(from, 'mail', to, '--work', `repo/${id}`, ...extra, `음성 ${from}->${to}`);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /turnReturn/);
    assert.equal(f.turn(id), who);
  };
  f.setTurn('n1', OWNER);
  expectStay('n1', OWNER, WORKER, [], OWNER);                // owner → 작업자
  expectStay('n1', OWNER, UPPER, [], OWNER);                 // owner → 상위
  f.setTurn('n1', SUPER);
  expectStay('n1', WORKER, OWNER, [], SUPER);                // 보낸 쪽이 차례 보유자 아님
  f.setTurn('n1', WORKER);
  expectStay('n1', WORKER, UPPER, [], WORKER);               // 받는 쪽이 owner 아님
  const before = fs.existsSync(path.join(f.home, `${OWNER}.received`)) ? fs.readFileSync(path.join(f.home, `${OWNER}.received`), 'utf8').length : 0;
  expectStay('n1', WORKER, OWNER, ['--keep-turn'], WORKER);  // --keep-turn
  const screen = f.received(OWNER, '음성 p-작업자->p-감독');
  assert.match(screen.slice(before), /음성 p-작업자->p-감독/, '메일은 도착했다');
  assert.doesNotMatch(screen.slice(before), tail, '--keep-turn이면 꼬리도 없다');
  f.setTurn('n1', '사람');
  expectStay('n1', '', OWNER, [], '사람');                   // 사람 명의(KADAN_ROLE 없음)
});

test('음성: 저장만 된 우편(세션 없음)·저장 전용 수신자·전송 실패(모르는 역할)는 차례가 그대로다', opts, () => {
  const f = shared;
  appendLedger({kind: 'start', role: 'p-오프', session: 'kadan-p-오프', panePid: 4242, t: '2026-10-21T00:00:00Z'}, f.home);
  for (const [id, owner, ok] of [['s1', 'p-오프', true], ['s2', '비서', true], ['s3', 'p-유령', false]]) {
    f.mkWork(id, owner); f.setTurn(id, WORKER);
    const r = f.call(WORKER, 'mail', owner, '--work', `repo/${id}`, '결과');
    assert.equal(r.status === 0, ok, `${owner}: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /turnReturn/);
    assert.equal(f.turn(id), WORKER, owner);
  }
});

test('인계 뒤에는 effective owner로 판정한다', opts, () => {
  const f = shared; f.mkWork('h1'); f.setTurn('h1', WORKER);
  appendLedger({kind: 'handover', phase: 'transferred', from: OWNER, to: HEIR, taskIds: [], handoverId: 'h-1', t: new Date().toISOString()}, f.home);
  const old = f.call(WORKER, 'mail', OWNER, '--work', 'repo/h1', '옛 이름으로');
  assert.equal(old.status, 0, old.stderr); assert.equal(f.turn('h1'), WORKER);
  const heir = f.call(WORKER, 'mail', HEIR, '--work', 'repo/h1', '후임에게');
  assert.equal(heir.status, 0, heir.stderr); assert.equal(f.turn('h1'), HEIR);
});

test('업무 쓰기 실패(잠금): 우편은 성공하고 stderr 한 줄만 나오며 차례는 그대로다', opts, () => {
  const f = fixture([OWNER, WORKER]);
  try {
    f.mkWork('x1'); f.setTurn('x1', WORKER);
    fs.mkdirSync(path.join(f.home, 'works', '.lock'));
    const r = f.call(WORKER, 'mail', OWNER, '--work', 'repo/x1', '결과');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /우편ID/); assert.doesNotMatch(r.stdout, /turnReturn/);
    assert.equal(r.stderr.trim().split('\n').filter(l => /차례 반환 실패/.test(l)).length, 1);
    assert.match(r.stderr, /kadan work update 'repo\/x1' --revision <현재 revision> --turn-owner 'p-감독'/);
    assert.equal(f.turn('x1'), WORKER);
    assert.equal(readLedger(f.home).filter(e => e.kind === 'send').length, 1, '우편은 기록됐다');
  } finally { f.stop(); }
});

test('단위: 발령(--task)·--raw·알림 전용·시스템 생성·watch는 대상이 아니고, 쓰기 충돌은 던지지 않고 한 줄만 낸다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-turn-unit-'));
  const works = new WorkStore(home);
  works.create({key: 'repo/u1', title: 't', goal: 'g', scope: 's', acceptance: 'a', owner: OWNER, repoPath: home});
  works.change('repo/u1', 'update', {turnOwner: WORKER}, {revision: 1, by: '시험', note: '준비'});
  const base = {sender: WORKER, by: WORKER, recipient: OWNER, workKey: 'repo/u1'};
  assert.ok(planTurnReturn(home, base));
  for (const extra of [{taskId: 'card-1'}, {raw: true}, {notificationOnly: true}, {systemGenerated: true}, {keepTurn: true}, {storeOnly: true},
    {sender: 'watch', by: 'watch'}, {workKey: undefined}, {recipient: UPPER}])
    assert.equal(planTurnReturn(home, {...base, ...extra}), null, JSON.stringify(extra));
  // 쓰기 충돌(revision 변경): 던지지 않고 경고 한 줄, 재시도 없음
  const plan = planTurnReturn(home, base);
  works.change('repo/u1', 'update', {progress: '다른 변경'}, {revision: 2, by: '시험', note: '끼어들기'});
  const warnings = [];
  assert.equal(applyTurnReturn(home, plan, 'mail-1', {warn: l => warnings.push(l)}), null);
  assert.equal(warnings.length, 1); assert.match(warnings[0], /차례 반환 실패\(우편은 전달됨\)/);
  assert.equal(works.get('repo/u1').turnOwner, WORKER);
  assert.equal(undoCommand('repo/u1', 4, WORKER), `kadan work update 'repo/u1' --revision 4 --turn-owner 'p-작업자' --note '차례 되돌림'`);
});
