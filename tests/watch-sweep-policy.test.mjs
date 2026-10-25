import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createSweepDiagnostics, createSweepPolicy, createFullSchedule} from '../src/watch-sweep-policy.mjs';
import {dedupAlerts, explainAlertRoute} from '../src/watch.mjs';
import {recordAlert, seedAlertState} from '../src/watch-alert-body.mjs';

const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-sweep-policy-'));
const diff = (key = 'ledger-array', fingerprint = 'f1') => ({key, fingerprint, detail: '배열 지문 불일치'});
const diffPass = (fingerprint = 'f1', key = 'ledger-array') => ({status: 'diff', diffs: [diff(key, fingerprint)], position: 9, generation: 'g1',
  arrayDigest: 'a', sourceDigest: 'b', arrayCount: 3, sourceCount: 3});
const policyOf = (dir, extra = {}) => createSweepPolicy({diagnostics: createSweepDiagnostics(dir, extra), now: () => Date.parse('2026-10-25T00:00:00Z')});
const repeatIds = policy => policy.alerts().map(alert => alert.id).filter(id => id.startsWith('sweep-repeat:'));

test('차이는 진단 파일에 남기고 보류·경보를 만들며, 같은 항목이 일치하면 해제를 기록한다', () => {
  const dir = dirOf(), policy = policyOf(dir);
  assert.equal(policy.holding(), false);
  const first = policy.record(diffPass());
  assert.equal(first.replace, true);            // 원본 검증 성공·위치 불변이므로 교체 허용
  assert.equal(policy.holding(), true);
  assert.equal(policy.alerts()[0].id, 'sweep-hold:ledger-array');
  policy.record({status: 'match', diffs: []});
  assert.equal(policy.holding(), false);
  assert.deepEqual(policy.alerts(), []);
  const rows = createSweepDiagnostics(dir).rows();
  assert.deepEqual(rows.map(row => row.kind), ['pass', 'hold', 'pass', 'released']);
  // F9: pass 행에 위치·세대·양쪽 지문을 남긴다.
  assert.deepEqual([rows[0].position, rows[0].generation, rows[0].arrayDigest, rows[0].sourceDigest], [9, 'g1', 'a', 'b']);
});

test('구분 불가(error)는 교체하지 않고 보류하며 일치 전까지 풀지 않는다, 비교 중 위치 변화(moved)는 차이로 세지 않는다', () => {
  const dir = dirOf(), policy = policyOf(dir);
  assert.equal(policy.record({status: 'moved', position: 9}).replace, false);
  assert.equal(policy.holding(), false);
  assert.equal(policy.record({status: 'error', error: '원본 검증 실패', errorKey: 'ledger-source'}).replace, false);
  assert.equal(policy.holding(), true);
  policy.record({status: 'moved'});
  assert.equal(policy.holding(), true);        // moved는 보류를 풀지 않는다
  policy.record({status: 'match', diffs: []});
  assert.equal(policy.holding(), false);
});

test('F1: 가벼운 대조 불일치는 쿨다운과 상관없이 바로 보류하고, 검증된 전체 대조 일치로만 풀린다', () => {
  const dir = dirOf(), policy = policyOf(dir);
  policy.holdLight([{name: '커서 대 최대 순번 mail', incremental: 1, sql: 2}]);
  assert.equal(policy.holding(), true);
  assert.match(policy.alerts()[0].id, /^sweep-hold:light:/u);
  policy.record({status: 'moved'});
  assert.equal(policy.holding(), true);        // 확인되지 않은 대조로는 풀리지 않는다
  policy.record({status: 'match', diffs: []});
  assert.equal(policy.holding(), false);
  assert.ok(createSweepDiagnostics(dir).rows().some(row => row.kind === 'released' && row.key.startsWith('light:')));
});

test('F4: 진단 파일을 쓰지 못해도 메모리 보류·경보는 사라지지 않고 교체를 막으며, 기록이 복구된 뒤 정상 대조가 일치해야 풀린다', () => {
  const rows = [];
  let failing = true;
  const diagnostics = {rows: () => [], append: row => { if (failing) throw Object.assign(new Error('EACCES'), {code: 'EACCES'});rows.push(row); }};
  const policy = createSweepPolicy({diagnostics, now: () => 0});
  assert.doesNotThrow(() => policy.record({status: 'error', error: '원본 조회 실패', errorKey: 'ledger-source'}));
  assert.equal(policy.holding(), true);
  const ids = policy.alerts().map(alert => alert.id);
  assert.ok(ids.includes('sweep-hold:ledger-source') && ids.includes('sweep-hold:sweep-diagnostics'));
  assert.equal(policy.record(diffPass()).replace, false);      // 기록하지 못한 채 상태를 바꾸지 않는다
  assert.equal(policy.record({status: 'match', diffs: []}).replace, false);
  assert.equal(policy.holding(), true);                         // 기록 장애 중 일치는 보류를 풀지 않는다
  failing = false;
  policy.record({status: 'match', diffs: []});                 // 복구: 밀린 행을 순서대로 쓰고
  assert.equal(policy.holding(), false);                        // 정상 대조 일치로 푼다
  const kinds = rows.map(row => row.kind);
  assert.equal(kinds[0], 'pass');                               // 장애 중 쌓인 행이 순서대로 기록됨
  assert.ok(kinds.filter(kind => kind === 'hold').length >= 1 && kinds.includes('released'));
  assert.equal(policy.diagnosticsError(), null);
});

test('F8·F2: 같은 키·지문은 평생 1회 — 3번 연속 뒤에만 알리고, 해제 뒤 재발·새 지문·재시작을 실제 dedup 경로로 확인한다', () => {
  const dir = dirOf();
  let policy = policyOf(dir), active = [];
  const cycle = () => { const out = dedupAlerts(active, policy.alerts());active = out.active;return out.notify.map(alert => alert.id); };
  policy.record(diffPass('f1'));policy.record(diffPass('f1'));
  assert.deepEqual(repeatIds(policy), []);                     // 2번째까지는 사용자 경보가 없다
  assert.deepEqual(cycle().filter(id => id.startsWith('sweep-repeat:')), []);
  policy.record(diffPass('f1'));
  assert.deepEqual(cycle().filter(id => id.startsWith('sweep-repeat:')), ['sweep-repeat:ledger-array:f1']);   // 3번째에 1회
  policy.record(diffPass('f1'));
  assert.deepEqual(cycle().filter(id => id.startsWith('sweep-repeat:')), []);                                   // 계속 이어져도 다시 안 알림
  // 재시작: 같은 id로 이어지므로 새 통지가 아니다.
  policy = policyOf(dir);
  assert.deepEqual(cycle().filter(id => id.startsWith('sweep-repeat:')), []);
  // 해제 → 같은 지문 재발 3번: 평생 1회라 사용자 경보가 다시 나가지 않는다.
  policy.record({status: 'match', diffs: []});
  assert.deepEqual(cycle().filter(id => id.startsWith('sweep-repeat:')), []);
  assert.deepEqual(repeatIds(policy), []);
  for (let n = 0; n < 3; n++) policy.record(diffPass('f1'));
  assert.deepEqual(repeatIds(policy), []);
  assert.deepEqual(cycle().filter(id => id.startsWith('sweep-repeat:')), []);
  // 새 지문 f2: 1~2번은 사용자 경보 없음, 3번째에 새 id로 1회.
  policy.record(diffPass('f2'));
  assert.deepEqual(repeatIds(policy), []);
  policy.record(diffPass('f2'));
  assert.deepEqual(repeatIds(policy), []);
  policy.record(diffPass('f2'));
  assert.deepEqual(cycle().filter(id => id.startsWith('sweep-repeat:')), ['sweep-repeat:ledger-array:f2']);
});

test('F2: 반복 경보는 실제 경보 라우터에서 사용자에게만 가고, 보류 경보는 사용자 전용이 아니다', () => {
  const policy = policyOf(dirOf());
  for (let n = 0; n < 3; n++) policy.record(diffPass('f1'));
  const repeat = policy.alerts().find(alert => alert.id.startsWith('sweep-repeat:'));
  const hold = policy.alerts().find(alert => alert.id.startsWith('sweep-hold:'));
  const parents = new Map([['boss', '@user'], ['worker', 'boss']]);
  const route = explainAlertRoute(repeat, new Map(), ['kadan-boss'], 'boss', parents);
  assert.equal(route.recipient, '@user');
  assert.equal(route.basis, 'sweep-repeat');
  assert.equal(explainAlertRoute(repeat, new Map(), [], null, new Map()).recipient, '@user');   // super가 없어도 사용자
  assert.notEqual(explainAlertRoute(hold, new Map(), ['kadan-boss'], 'boss', parents).basis, 'sweep-repeat');
});

test('진단 파일은 새 행을 더한 크기가 상한을 넘으면 다음 순번 파일로 넘어가고 옛 파일을 지우지 않는다(F9)', () => {
  const dir = dirOf(), diagnostics = createSweepDiagnostics(dir, {maxBytes: 200});
  for (let n = 0; n < 12; n++) diagnostics.append({kind: 'pass', n, pad: 'x'.repeat(60)});
  const sequences = diagnostics.sequences();
  assert.ok(sequences.length >= 3);
  assert.deepEqual(sequences, sequences.map((_, index) => index + 1));
  assert.equal(diagnostics.rows().length, 12);   // 옛 파일의 행이 그대로 남아 있다
  for (const seq of sequences) {
    const size = fs.statSync(path.join(dir, `watch-sweep-diagnostics-${String(seq).padStart(4, '0')}.jsonl`)).size;
    assert.ok(size <= 200, `파일 ${seq} 크기 ${size}`);          // 새 행을 더한 크기로 판단해 상한을 넘지 않는다
  }
  // 행 하나가 상한보다 크면 그 행만 새 파일에 쓴다(상한 초과는 그 경우뿐).
  diagnostics.append({kind: 'pass', pad: 'y'.repeat(500)});
  assert.equal(diagnostics.sequences().length, sequences.length + 1);
  assert.ok(fs.readdirSync(dir).every(name => /^watch-sweep-diagnostics-\d{4}\.jsonl$/u.test(name)));
});

test('가벼운 대조 불일치로 즉시 전체 대조를 돌린 뒤 쿨다운 안에서는 다시 돌리지 않는다', () => {
  const schedule = createFullSchedule({intervalMs: 6 * 3600_000, cooldownMs: 600_000});
  assert.equal(schedule.due({now: 0}), 'start');
  schedule.ran(0);
  assert.equal(schedule.due({now: 1000}), null);
  assert.equal(schedule.due({now: 1000, reason: 'light-mismatch'}), null);       // 쿨다운
  assert.equal(schedule.due({now: 700_000, reason: 'light-mismatch'}), 'light-mismatch');
  schedule.ran(700_000);
  assert.equal(schedule.due({now: 700_000 + 6 * 3600_000}), 'periodic');
});

// 재검수 F8-R1: 새 지문이 생긴 뒤 재시작하면 끝난 이전 지문의 사용자 경보가 다시 살아나던 문제(검수자 재현 도구 2개를 시험으로 옮김).
// 실제 recordAlert → seedAlertState → dedupAlerts → explainAlertRoute 경로를 지난다.
for (const newPasses of [1, 2]) {
  test(`F8-R1: f1 반복 경보 1회 → f2 diff ${newPasses}번 → 재시작해도 f1 사용자 경보가 다시 나오지 않고, f2는 3번 연속 전에는 나오지 않는다`, () => {
    const dir = dirOf(), diagnostics = createSweepDiagnostics(dir);
    const ledger = [];
    let policy = createSweepPolicy({diagnostics, now: () => Date.parse('2026-10-25T00:00:00Z')}), active = [];
    const route = alert => explainAlertRoute(alert, new Map(), ['kadan-boss'], 'boss', new Map()).recipient;
    const cycle = () => {
      const out = dedupAlerts(active, policy.alerts());active = out.active;
      for (const alert of out.notify) recordAlert(entry => ledger.push(entry), alert, route(alert), true);
      for (const alert of out.resolved) recordAlert(entry => ledger.push(entry), alert, null, false, true);
      return {notify: out.notify.map(alert => ({id: alert.id, recipient: route(alert)})), active: out.active.map(alert => alert.id)};
    };
    for (let n = 0; n < 3; n++) policy.record(diffPass('f1'));
    const first = cycle();
    assert.deepEqual(first.notify.filter(item => item.id.startsWith('sweep-repeat:')),
      [{id: 'sweep-repeat:ledger-array:f1', recipient: '@user'}]);                // f1 사용자 경보 1회
    for (let n = 0; n < newPasses; n++) policy.record(diffPass('f2'));            // 새 지문: 아직 3번 연속 전
    const before = cycle();
    assert.equal(before.active.some(id => id.startsWith('sweep-repeat:')), false); // 실행 중에도 옛 반복 경보는 끝난다
    // 재시작: 진단 기록에서 정책을 복원하고 알림 이력(원장)에서 활성 경보를 복원한다.
    policy = createSweepPolicy({diagnostics, now: () => Date.parse('2026-10-25T00:00:00Z')});
    active = seedAlertState(ledger).active;
    const afterRestart = cycle();
    assert.equal(afterRestart.notify.some(item => item.id.startsWith('sweep-repeat:')), false,
      '재시작이 이미 끝난 f1 경보를 사용자에게 다시 내보냈다');
    assert.equal(policy.alerts().some(alert => alert.id.startsWith('sweep-repeat:')), false);
    // f2는 남은 횟수를 채워 3번째에만, 새 지문 id로 사용자에게 1회.
    for (let n = newPasses; n < 2; n++) policy.record(diffPass('f2'));
    assert.deepEqual(cycle().notify.filter(item => item.id.startsWith('sweep-repeat:')), []);
    policy.record(diffPass('f2'));
    assert.deepEqual(cycle().notify.filter(item => item.id.startsWith('sweep-repeat:')),
      [{id: 'sweep-repeat:ledger-array:f2', recipient: '@user'}]);
  });
}

test('F8-R1: 기록 복원은 실행 중과 같은 결과를 낸다 — 해제·재발·지문 전환을 거친 임의 순서에서 재시작 전후 경보가 같다', () => {
  const dir = dirOf();
  let live = policyOf(dir);
  const steps = [['f1', 3], ['match', 1], ['f1', 3], ['f2', 2], ['f2', 1], ['f3', 1], ['f2', 3], ['match', 1], ['f4', 3]];
  for (const [what, count] of steps) {
    for (let n = 0; n < count; n++) live.record(what === 'match' ? {status: 'match', diffs: []} : diffPass(what));
    const restored = policyOf(dir);
    assert.deepEqual(restored.alerts().map(alert => alert.id), live.alerts().map(alert => alert.id), `${what} x${count}`);
    assert.equal(restored.holding(), live.holding());
  }
});
