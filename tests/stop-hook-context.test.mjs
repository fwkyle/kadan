import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {compactReminder, lastCompactBoundary, reminderText, lookupExecutions, ownsPane, processTable} from '../src/stop-hook-context.mjs';
import {scenario} from './helpers/responsibility-scenario.mjs';
import {CardStore} from '../src/card-store.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {DecisionStore} from '../src/decisions.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {createDatabase, writeStorageMarker, openDatabase} from '../src/storage.mjs';

process.env.KADAN_HOOK_TIMEOUT_MS = '60000'; // 부하가 높아도 훅 시간 상한 때문에 흔들리지 않게(운영 상한은 그대로 3초·1초)
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-compact-hook-'));
const NOW = Date.parse('2026-10-19T06:00:00.000Z');
const now = () => NOW;
const iso = ms => new Date(ms).toISOString();
const claudeBoundary = (id, at) => ({type: 'system', subtype: 'compact_boundary', uuid: id, timestamp: iso(at)});
const codexBoundary = (id, at) => ({timestamp: iso(at), type: 'compacted', payload: {window_id: id, message: ''}});
function setup(rows) {
  const home = tmp(), file = path.join(home, 't.jsonl');
  fs.writeFileSync(file, rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n');
  return {home, file, env: {KADAN_ROLE: 'r', KADAN_HOME: home}};
}
const stop = (file, extra = {}) => JSON.stringify({hook_event_name: 'Stop', session_id: 's1', transcript_path: file, last_assistant_message: '규칙을 따르겠습니다', stop_hook_active: false, ...extra});
const result = (keys, panePid = '100') => ({keys, panePid});
const found = async () => result(['kadan/exec-1']);
const yes = () => true; // 담당 세션 확인은 별도 시험이 본다

test('압축 직후 첫 Stop: claude·codex 경계 모두 카드 주소를 한 번만 안내한다', async () => {
  for (const boundary of [claudeBoundary('b1', NOW - 5000), codexBoundary('w1', NOW - 5000)]) {
    const {file, env} = setup([{type: 'user'}, boundary, {type: 'assistant'}]);
    assert.equal(await compactReminder(stop(file), env, {lookup: found, now, owns: yes}), reminderText(['kadan/exec-1']));
    assert.equal(await compactReminder(stop(file), env, {lookup: found, now, owns: yes}), null); // 같은 압축에는 두 번 안 한다
  }
});

test('새 압축 경계는 다시 안내한다', async () => {
  const {file, env} = setup([claudeBoundary('b1', NOW - 9000)]);
  assert.ok(await compactReminder(stop(file), env, {lookup: found, now, owns: yes}));
  fs.appendFileSync(file, JSON.stringify(claudeBoundary('b2', NOW - 1000)) + '\n');
  assert.ok(await compactReminder(stop(file), env, {lookup: found, now, owns: yes}));
});

test('개인 실행기·재호출·완료 마커·옛 경계·경계 없음·경로 이상은 안내하지 않는다', async () => {
  const {file, env} = setup([claudeBoundary('b1', NOW - 5000)]);
  const call = (raw, e = env, lookup = found) => compactReminder(raw, e, {lookup, now, owns: yes});
  assert.equal(await call(stop(file), {KADAN_HOME: env.KADAN_HOME}), null);
  assert.equal(await call(stop(file, {stop_hook_active: true})), null);
  assert.equal(await call(stop(file, {hook_event_name: 'SessionStart'})), null);
  assert.equal(await call(stop(file, {last_assistant_message: '끝\nKADAN:DONE exec-1 ok'})), null);
  assert.equal(await call(stop(file, {transcript_path: null})), null);
  assert.equal(await call(stop(file, {transcript_path: 'rel/t.jsonl'})), null);
  assert.equal(await call(stop(path.join(env.KADAN_HOME, 'none.jsonl'))), null);
  assert.equal(await call('not json'), null);
  const old = setup([claudeBoundary('b0', NOW - 2 * 3600 * 1000)]);
  assert.equal(await call(stop(old.file), old.env), null);
  const none = setup([{type: 'user'}, {type: 'assistant'}]);
  assert.equal(await call(stop(none.file), none.env), null);
});

test('새 경계를 처음 본 Stop이 결과와 무관하게 기회를 소모한다(찾지 못함·조회 실패·마커 응답)', async () => {
  for (const [lookup, message] of [[async () => result([]), '규칙'], [async () => { throw new Error('busy'); }, '규칙'], [found, 'KADAN:DONE exec-1 ok']]) {
    const {file, env} = setup([claudeBoundary('b1', NOW - 5000)]);
    assert.equal(await compactReminder(stop(file, {last_assistant_message: message}), env, {lookup, now, owns: yes}), null);
    assert.equal(await compactReminder(stop(file), env, {lookup: found, now, owns: yes}), null); // 같은 압축의 두 번째 Stop은 막지 않는다
  }
});

test('미완료 실행이 여럿이면 하나의 안내에 모두 적는다', async () => {
  const {file, env} = setup([claudeBoundary('b1', NOW - 5000)]);
  const text = await compactReminder(stop(file), env, {lookup: async () => result(['kadan/exec-1', 'kadan/exec-2']), now, owns: yes});
  assert.match(text, /`kadan\/exec-1`, `kadan\/exec-2`/);
  assert.doesNotMatch(text, /KADAN:DONE/);
});

test('개인 실행기와 훅 재호출은 기회를 소모하지 않는다', async () => {
  const {file, env, home} = setup([claudeBoundary('b1', NOW - 5000)]);
  assert.equal(await compactReminder(stop(file), {KADAN_HOME: home}, {lookup: found, now, owns: yes}), null);
  assert.equal(await compactReminder(stop(file, {stop_hook_active: true}), env, {lookup: found, now, owns: yes}), null);
  assert.equal(fs.existsSync(path.join(home, 'stop-hook')), false);
  assert.ok(await compactReminder(stop(file), env, {lookup: found, now, owns: yes}));
});

test('마지막 경계가 모호하면 옛 경계로 대신하지 않는다', () => {
  const {file} = setup([claudeBoundary('b1', NOW - 5000), {type: 'system', subtype: 'compact_boundary', timestamp: iso(NOW)}]);
  assert.equal(lastCompactBoundary(file), null);
});

test('실제 훅 프로세스: 원장이 없으면 출력 없이 종료 0', () => {
  const {file, env} = setup([claudeBoundary('b1', Date.now() - 1000)]);
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'stop-hook.mjs');
  const run = spawnSync(process.execPath, [script], {input: stop(file), env: {...process.env, ...env}, encoding: 'utf8'});
  assert.equal(run.status, 0);
  assert.equal(run.stdout, '');
});

test('실제 원장 조회: 발령된 역할은 현재 실행 하나를 찾고, 발령 전·다른 역할·원장 없음에는 비어 있다', () => {
  const s = scenario({run() {}});
  const store = new CardStore(s.home);
  assert.deepEqual(lookupExecutions(s.home, 'r-작업자').keys, []); // 아직 발령(assigned) 전
  store.update(s.execution, {status: 'assigned', board: 'b', role: 'r-작업자', scope: '범위', rallyId: 'r1', rallyTitle: 't', rallyRound: '1', rallyStep: 'implementation'}, {revision: store.get(s.execution).revision, note: '발령'});
  assert.deepEqual(lookupExecutions(s.home, 'r-작업자').keys, [s.execution]);
  assert.deepEqual(lookupExecutions(s.home, 'r-감독').keys, []);
  assert.deepEqual(lookupExecutions(tmp(), 'r-작업자').keys, []); // 원장이 없으면 빈 배열(fail-open)
});

// ---- PR #206 2라운드(F1~F3) + 1라운드 독립검수 probe 이관 ----
const here = path.dirname(fileURLToPath(import.meta.url));
const hookScript = path.join(here, '..', 'scripts', 'stop-hook.sh');
const helper = path.join(here, 'helpers', 'hook-chain.mjs');
const PANE = {floor: 'tmux', panePid: process.pid}; // 시험 프로세스를 pane으로 본다
const iso2 = ms => new Date(ms).toISOString();
function assigned(extra = {}) {
  const s = scenario({run() {}, ...extra});
  const store = new CardStore(s.home);
  store.update(s.execution, {status: 'assigned', board: 'b', role: 'r-작업자', scope: '범위', rallyId: 'r1', rallyTitle: 't', rallyRound: '1', rallyStep: 'implementation'},
    {revision: store.get(s.execution).revision, note: '발령'});
  return {...s, store};
}
function transcriptFile(dir, id = 'boundary-1', ageMs = 1000, extra = []) {
  const file = path.join(dir, `${id}.jsonl`);
  const rows = [{timestamp: iso2(Date.now() - ageMs), type: 'compacted', payload: {window_id: id, message: ''}}, ...extra];
  fs.writeFileSync(file, rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n');
  return file;
}
const hookInput = (file, session = 'main', extra = {}) => JSON.stringify({hook_event_name: 'Stop', session_id: session, turn_id: 't1',
  transcript_path: file, stop_hook_active: false, last_assistant_message: '규칙을 따르겠습니다.', ...extra});
// shape: direct(훅 감싸개가 pane의 자식 = claude 모양) · launcher(pane → 실행기 → 감싸개 = codex 모양) · shell(pane → 실행기 → 도구 셸 → 자식 실행기 → 감싸개)
function runHook(home, raw, {role = 'r-작업자', shape = 'direct'} = {}) {
  const env = {...process.env, KADAN_HOME: home, HOOK_INPUT: raw, HOOK_SCRIPT: hookScript};
  if (role) env.KADAN_ROLE = role; else delete env.KADAN_ROLE;
  const run = shape === 'direct' ? spawnSync('/bin/sh', [hookScript], {env, input: raw, encoding: 'utf8', timeout: 90000})
    : shape === 'launcher' ? spawnSync(process.execPath, [helper], {env, encoding: 'utf8', timeout: 90000})
      : spawnSync(process.execPath, [helper], {env: {...env, HOOK_NEST: '1'}, encoding: 'utf8', timeout: 90000});
  assert.equal(run.status, 0);
  return run.stdout;
}
const blocked = out => out !== '' && JSON.parse(out).decision === 'block';

test('F1 부모 사슬: claude 모양·codex 모양은 담당 세션이고 자식 CLI·모르는 pane은 아니다(합성 표)', () => {
  const table = rows => new Map(rows.map(([pid, ppid, command]) => [String(pid), {ppid: String(ppid), command}]));
  const hook = [10, 9, 'node /repo/src/stop-hook.mjs'], wrapper = [9, 8, '/bin/sh /repo/scripts/stop-hook.sh'];
  // claude: pane이 곧 실행기
  const claude = table([hook, wrapper, [8, 5, 'claude --model m'], [5, 1, 'tmux']]);
  assert.equal(ownsPane(claude, '8', 10), true);
  // codex: 실행기(vendor)의 부모가 pane(node 실행 파일)
  const codex = table([hook, wrapper, [8, 7, '/x/vendor/bin/codex --model m'], [7, 5, 'node /x/bin/codex --model m'], [5, 1, 'tmux']]);
  assert.equal(ownsPane(codex, '7', 10), true);
  // 감싸개가 sh -c 한 겹 더 있어도 된다
  const wrapped = table([hook, [9, 8, '/bin/sh /repo/scripts/stop-hook.sh'], [8, 6, 'sh -c /repo/scripts/stop-hook.sh'], [6, 7, '/x/vendor/bin/codex'], [7, 5, 'node /x/bin/codex']]);
  assert.equal(ownsPane(wrapped, '7', 10), true);
  // 담당 claude가 띄운 자식 claude: 도구 셸이 끼어 있다
  const childClaude = table([hook, wrapper, [8, 21, 'claude -p x'], [21, 30, '/bin/zsh -c claude -p x'], [30, 5, 'claude --model m']]);
  assert.equal(ownsPane(childClaude, '30', 10), false);
  // 자식 claude를 도구 셸이 exec로 바로 띄운 경우: 부모가 pane이지만 pane이 node 실행 파일이 아니다
  const execChild = table([hook, [9, 20, '/bin/sh /repo/scripts/stop-hook.sh'], [20, 8, 'claude -p x'], [8, 5, 'claude --model m']]);
  assert.equal(ownsPane(execChild, '8', 10), false);
  // 담당 codex가 띄운 자식 codex: 자식의 부모는 자식 node 실행 파일이고 pane이 아니다
  const childCodex = table([hook, [9, 20, '/bin/sh /repo/scripts/stop-hook.sh'], [20, 21, '/x/vendor/bin/codex'], [21, 22, 'node /x/bin/codex'], [22, 8, '/bin/zsh -c codex'], [8, 7, '/x/vendor/bin/codex'], [7, 5, 'node /x/bin/codex']]);
  assert.equal(ownsPane(childCodex, '7', 10), false);
  // 모르는 것은 거짓: pane PID 없음·표 없음·사슬 끊김·너무 깊음
  assert.equal(ownsPane(claude, null, 10), false);
  assert.equal(ownsPane(null, '8', 10), false);
  assert.equal(ownsPane(table([hook]), '8', 10), false);
  assert.equal(ownsPane(table([hook, [9, 8, 'sh a'], [8, 7, 'sh b'], [7, 6, 'sh c']]), '1', 10), false);
});

test('F1 processTable: ps 실패·이상한 출력은 null', () => {
  assert.equal(processTable(() => ({status: 1, stdout: ''})), null);
  assert.equal(processTable(() => ({status: 0, stdout: null})), null);
  const table = processTable(() => ({status: 0, stdout: '  10   9 node a b\nzzz\n 9 1 /bin/sh x\n'}));
  assert.deepEqual([...table.keys()], ['10', '9']);
  assert.equal(processTable().get(String(process.pid)).ppid, String(process.ppid)); // 실제 ps
});

test('F1 실제 훅 프로세스: 담당 세션은 block, 같은 역할 환경을 물려받은 자식 CLI·다른 pane·pane 증거 없음은 무출력', () => {
  const s = assigned({startFields: PANE});
  assert.equal(blocked(runHook(s.home, hookInput(transcriptFile(s.home), 'a'), {shape: 'direct'})), true); // claude 모양
  assert.equal(blocked(runHook(s.home, hookInput(transcriptFile(s.home, 'b2'), 'b'), {shape: 'launcher'})), true); // codex 모양
  assert.equal(runHook(s.home, hookInput(transcriptFile(s.home, 'b3'), 'c'), {shape: 'shell'}), ''); // 자식 CLI(검수 probe inherited-role-unrelated-child)
  const other = assigned({startFields: {floor: 'tmux', panePid: 1}}); // 담당 pane이 다른 프로세스
  assert.equal(runHook(other.home, hookInput(transcriptFile(other.home)), {shape: 'direct'}), '');
  const noPid = assigned({startFields: {floor: 'tmux'}}), herdr = assigned({startFields: {floor: 'herdr', panePid: process.pid}}), none = assigned();
  for (const x of [noPid, herdr, none]) assert.equal(runHook(x.home, hookInput(transcriptFile(x.home)), {shape: 'direct'}), '');
});

test('F2 열린 사용자 결정(카드·업무에 연결)이 있으면 무출력, 결정 저장소를 못 읽어도 무출력', () => {
  const s = assigned({startFields: PANE});
  const decisions = new DecisionStore(s.home, {notify() {}, userNotify() {}, threadNote() {}});
  const d = decisions.request(s.execution, {question: '이 실행을 계속할까요?\n확인 경로 없음: 시험', options: ['계속', '보류'],
    recommendation: '계속', reason: '시험', work: 'r/w1'}, 'r-슈퍼감독');
  assert.equal(d.status, 'open');
  assert.deepEqual(lookupExecutions(s.home, 'r-작업자').keys, []);
  assert.equal(runHook(s.home, hookInput(transcriptFile(s.home))), ''); // user-decision-waiting
  const ok = assigned({startFields: PANE}); // 결정이 없으면 그대로 block
  assert.equal(blocked(runHook(ok.home, hookInput(transcriptFile(ok.home)))), true);
  const broken = assigned({startFields: PANE});
  new DecisionStore(broken.home, {notify() {}, userNotify() {}, threadNote() {}}).write({id: 'bad', status: 'open'});
  assert.equal(runHook(broken.home, hookInput(transcriptFile(broken.home))), ''); // 읽지 못하면 통과
});

test('F3 마지막 경계가 깨졌거나 쓰는 중이면 앞 경계로 대신하지 않는다', () => {
  const good = claudeBoundary('b1', NOW - 9000);
  const cases = [
    [[good, '{"type":"compacted","payload":'], '\n', null], // 잘린 새 경계(검수 probe corrupt-latest-boundary)
    [[good, '{"type":"system","subtype":"compact_boundary","uuid":"b2'], '\n', null], // claude 모양이 잘림
    [[good, '{"type":"assistant","messa'], '', null], // 줄바꿈 없이 끝난 쓰는 중인 마지막 줄
    [[good, 'not json'], '\n', 'b1'], // 경계 낱말이 없는 손상 줄은 건너뛴다
    [[good, {type: 'assistant', text: 'compacted 라는 말'}], '\n', 'b1'], // 낱말이 보통 기록 안에 있는 것은 경계가 아니다
    [[good, '{"type":"compacted","payload":', claudeBoundary('b3', NOW - 1000)], '\n', 'b3'], // 손상 뒤의 정상 경계가 마지막이면 그것이다
    [[good, claudeBoundary('b3', NOW - 1000), '{"type":"compacted"'], '', null], // 마지막이 손상이면 정상 b3로 돌아가지 않는다
  ];
  for (const [rows, tail, expected] of cases) {
    const {file} = setup(rows);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n$/, tail));
    assert.equal(lastCompactBoundary(file)?.id ?? null, expected, JSON.stringify(rows).slice(0, 80));
  }
});

test('F3 꼬리 읽기 범위의 잘린 첫 줄은 손상으로 보지 않는다', () => {
  const {file} = setup([]);
  const filler = JSON.stringify({type: 'assistant', text: 'compacted '.repeat(100)});
  const tail = [claudeBoundary('b9', NOW - 1000), {type: 'assistant'}].map(r => JSON.stringify(r)).join('\n');
  fs.writeFileSync(file, `${JSON.stringify(claudeBoundary('old', NOW - 9000))}\n${Array(300).fill(filler).join('\n')}\n${tail}\n`);
  assert.ok(fs.statSync(file).size > 256 * 1024);
  assert.equal(lastCompactBoundary(file).id, 'b9');
});

test('독립검수 probe 이관: 담당이 없거나 실행이 끝났거나 대기 중이면 조회가 비어 있다', () => {
  for (const state of ['hold', 'cancelled', 'draft', 'ready', 'superseded', 'done']) {
    const s = assigned();
    if (state === 'done') appendLedger({kind: 'done', role: 'r-작업자', taskId: s.execution, executionKey: s.execution, result: 'ok'}, s.home);
    else s.store.update(s.execution, {status: state, ...(state === 'superseded' ? {replacedByText: '후속 작업'} : {})}, {revision: s.store.get(s.execution).revision, note: state});
    assert.deepEqual(lookupExecutions(s.home, 'r-작업자').keys, [], state);
  }
  const old = assigned();
  appendLedger({kind: 'done', role: 'r-작업자', taskId: 'r/old-card', result: 'ok'}, old.home);
  assert.deepEqual(lookupExecutions(old.home, 'r-작업자').keys, [old.execution]); // 다른 옛 카드의 완료는 현재 실행을 가리지 않는다
  const generation = assigned();
  appendLedger({kind: 'start', role: 'r-작업자', session: 'kadan-r-작업자', panePid: 424242}, generation.home);
  assert.deepEqual(lookupExecutions(generation.home, 'r-작업자').keys, []); // 이전 세대
  const waiting = assigned();
  waiting.store.update(waiting.execution, {activity: 'waiting'}, {revision: waiting.store.get(waiting.execution).revision, by: 'r-작업자', note: '외부 대기', noteKind: 'progress'});
  assert.deepEqual(lookupExecutions(waiting.home, 'r-작업자').keys, []);
  const question = assigned({startFields: PANE});
  appendLedger({kind: 'send', role: 'r-감독', by: 'r-작업자', expectReply: true, mailId: 'q1', executionKey: question.execution}, question.home);
  assert.deepEqual(lookupExecutions(question.home, 'r-작업자').keys, []);
  assert.equal(runHook(question.home, hookInput(transcriptFile(question.home))), '');
});

test('독립검수 probe 이관: 인계 확정·복수 실행·pane 증거 전달', () => {
  const s = assigned({startFields: PANE});
  appendLedger({kind: 'handover', phase: 'transferred', from: 'r-작업자', to: 'r-후임', taskIds: [s.execution], handoverId: 'h1'}, s.home);
  assert.deepEqual(lookupExecutions(s.home, 'r-작업자').keys, []);
  assert.deepEqual(lookupExecutions(s.home, 'r-후임').keys, [s.execution]);
  const two = assigned({startFields: PANE}), works = new WorkStore(two.home), work = works.get('r/w1');
  const next = works.change('r/w1', 'execute', {phase: 'implementation', round: 2, title: '두 번째', body: '시험'}, {revision: work.revision, by: '사람', note: '두 번째'});
  const key = next.executions.at(-1).key;
  two.store.update(key, {status: 'assigned', role: 'r-작업자', board: 'b', scope: 's', rallyId: 'r1', rallyTitle: 't', rallyRound: '2', rallyStep: 'implementation'}, {revision: two.store.get(key).revision, note: '발령'});
  appendLedger({kind: 'send', role: 'r-작업자', taskId: key, executionKey: key}, two.home);
  const found2 = lookupExecutions(two.home, 'r-작업자');
  assert.equal(found2.keys.length, 2);
  assert.equal(found2.panePid, String(process.pid));
  const out = runHook(two.home, hookInput(transcriptFile(two.home)));
  assert.ok(blocked(out) && out.includes(two.execution) && out.includes(key)); // 한 안내에 모두 적는다
});

test('독립검수 probe 이관: 감독·역할 없음·재호출·깨진 입력·없는 기록·옛 경계·쓰기 실패·마커는 무출력', () => {
  const s = assigned({startFields: PANE}), file = transcriptFile(s.home);
  assert.equal(runHook(s.home, hookInput(file), {role: null}), ''); // 개인 실행
  for (const role of ['r-감독', 'r-슈퍼']) assert.equal(runHook(s.home, hookInput(file, `${role}-s`), {role}), '');
  assert.equal(runHook(s.home, hookInput(file, 'active', {stop_hook_active: true})), '');
  assert.equal(runHook(s.home, 'not JSON'), '');
  const bad = path.join(s.home, 'broken.jsonl'); fs.writeFileSync(bad, 'not JSON\n');
  assert.equal(runHook(s.home, hookInput(bad)), '');
  assert.equal(runHook(s.home, hookInput(path.join(s.home, 'missing.jsonl'))), '');
  assert.equal(runHook(s.home, hookInput(transcriptFile(s.home, '31m', 31 * 60000))), '');
  assert.equal(runHook(s.home, hookInput(transcriptFile(s.home, 'done', 1000), 'done', {last_assistant_message: '완료\nKADAN:DONE x ok'})), '');
  const disk = assigned({startFields: PANE}); fs.writeFileSync(path.join(disk.home, 'stop-hook'), 'not a directory');
  assert.equal(runHook(disk.home, hookInput(transcriptFile(disk.home))), '');
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-bad-storage-')); fs.writeFileSync(path.join(storage, 'storage.json'), 'not JSON');
  assert.equal(runHook(storage, hookInput(transcriptFile(storage))), '');
  // 위의 무출력들은 기회를 쓰지 않은 것과 쓴 것이 섞여 있다. 같은 세션의 첫 안내와 두 번째 통과, 새 경계 재안내를 따로 본다
  const fresh = assigned({startFields: PANE}), freshFile = transcriptFile(fresh.home);
  assert.equal(blocked(runHook(fresh.home, hookInput(freshFile, 'main'))), true);
  assert.equal(runHook(fresh.home, hookInput(freshFile, 'main')), '');
  assert.equal(blocked(runHook(fresh.home, hookInput(transcriptFile(fresh.home, 'boundary-2'), 'main'))), true);
});

test('독립검수 probe 이관: 동시 Stop 6개 중 하나만 block, 잠금 대기·시간 상한', async () => {
  const s = assigned({startFields: PANE}), raw = hookInput(transcriptFile(s.home), 'race');
  const results = await Promise.all(Array.from({length: 6}, () => new Promise(resolve => {
    const child = spawn('/bin/sh', [hookScript], {env: {...process.env, KADAN_HOME: s.home, KADAN_ROLE: 'r-작업자'}, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = ''; child.stdout.on('data', b => { stdout += b; });
    child.on('close', status => resolve({status, stdout})); child.stdin.end(raw);
  })));
  assert.ok(results.every(r => r.status === 0));
  assert.equal(results.filter(r => r.stdout).length, 1);
  assert.equal(fs.readdirSync(path.join(s.home, 'stop-hook', 'compact-reminders')).length, 1);
  const dir = tmp(); createDatabase(dir); writeStorageMarker(dir, 'sqlite');
  delete process.env.KADAN_BUSY_TIMEOUT_MS;
  const wait = () => { const db = openDatabase(dir, {readOnly: true}); try { return db.prepare('PRAGMA busy_timeout').get().timeout; } finally { db.close(); } };
  assert.equal(wait(), 15000);
  process.env.KADAN_BUSY_TIMEOUT_MS = '800';
  try { assert.equal(wait(), 800); } finally { delete process.env.KADAN_BUSY_TIMEOUT_MS; }
  assert.deepEqual(lookupExecutions(dir, 'r-작업자', 1).keys, []); // 시간 상한 1ms는 빈 결과
});
