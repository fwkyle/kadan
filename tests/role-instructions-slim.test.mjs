// 역할 우편 지침 축소 시험(kadan 판 conductor만 요약). 운영 이름 대신 가짜 역할 이름과 격리 홈만 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {composeRoleInstructions,FULL_INTERVAL_MS} from '../src/role-instructions.mjs';
import {guardedSend} from '../src/cli.mjs';
import {readLedger} from '../src/ledger.mjs';

const KADAN_ROLE_NAME = 'kadan-시험판-감독', OTHER_ROLE_NAME = '타레포-시험-감독';
const NOW = Date.parse('2026-10-16T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-slim-'));
const start = (role, t = NOW - 3 * FULL_INTERVAL_MS, extra = {}) => ({kind: 'start', role, session: `kadan-${role}`, panePid: '100', cmd: 'x', cwd: '/x/Dev/kadan', t: iso(t), ...extra});
const fullSend = (role, f, extra = {}) => ({kind: 'send', role, keyDelivery: 'sent', t: iso(NOW - 600_000),
  instructions: {mode: 'full', reason: 'x', profile: 'conductor', templateDigest: f.digest, generation: 0}, ...extra});
function compose(role, {entries = [], profile = 'conductor', home: h = home(), ...rest} = {}) {
  return composeRoleInstructions({home: h, role, message: '본문', profile, entries, slim: true, now: NOW, ...rest});
}
// 같은 격리 홈에서 지문을 얻는다.
const digestOf = (role, h) => composeRoleInstructions({home: h, role, profile: 'conductor', entries: [start(role)], slim: true, now: NOW}).metadata.templateDigest;
function setup(role = KADAN_ROLE_NAME) {
  const h = home(), f = {digest: digestOf(role, h)};
  return {h, f, entries: [start(role), fullSend(role, f)]};
}
const meta = r => [r.metadata.instructionsMode, r.metadata.instructionsReason];

test('1 세대에 full 없음 → full/generation-first', () => {
  const r = compose(KADAN_ROLE_NAME, {entries: [start(KADAN_ROLE_NAME)]});
  assert.deepEqual(meta(r), ['full', 'generation-first']);
  assert.match(r.message, /kadan:receiver-instructions/);
});

test('2 전달 성공 full 1시간 안 → summary(B 줄·금지선 두 줄·전문 경로 두 개)', () => {
  const s = setup(), r = compose(KADAN_ROLE_NAME, {home: s.h, entries: s.entries});
  assert.deepEqual(meta(r), ['summary', 'within-interval']);
  assert.match(r.instructions, /수신 역할: kadan-시험판-감독/);
  assert.match(r.instructions, /최신 사용자 지시·승인 범위·보류를 지킨다/);
  assert.match(r.instructions, /확대하지 않는다/);
  assert.match(r.instructions, /role-templates\/common\.md/);
  assert.match(r.instructions, /role-templates\/conductor\.md/);
  assert.doesNotMatch(r.instructions, /herdr 화면 확인/); // 템플릿 전문은 빠진다
  assert.ok(r.metadata.templateDigest);
});

test('3 현재 발령 → full/dispatch', () => {
  const s = setup(), h = s.h;
  // 발령 카드: 격리 홈의 카드로 current 분기를 만든다
  const {CardStore} = awaitImport();
  const store = new CardStore(h), c = store.create({repo: 'kadan', id: 'cur', repoPath: h, body: '# 시험'});
  const a = store.update(c.key, {status: 'assigned', role: KADAN_ROLE_NAME, board: 'kadan-시험판', scope: 's', rallyId: 'r', rallyTitle: 't', rallyRound: '1', rallyStep: 'implementation'}, {revision: c.revision, note: '배정'});
  const r = compose(KADAN_ROLE_NAME, {home: h, entries: s.entries, taskId: a.id, mailContext: {executionKey: a.key}});
  assert.deepEqual(meta(r), ['full', 'dispatch']);
});

test('4 직전 full이 not-sent·unknown → full/delivery-unclear', () => {
  for (const keyDelivery of ['not-sent', 'unknown']) {
    const s = setup(), entries = [start(KADAN_ROLE_NAME), fullSend(KADAN_ROLE_NAME, s.f, {keyDelivery})];
    assert.deepEqual(meta(compose(KADAN_ROLE_NAME, {home: s.h, entries})), ['full', 'delivery-unclear']);
  }
});

test('5 full 뒤 1시간 넘음 → full/interval', () => {
  const s = setup(), old = fullSend(KADAN_ROLE_NAME, s.f, {t: iso(NOW - FULL_INTERVAL_MS - 1000)});
  assert.deepEqual(meta(compose(KADAN_ROLE_NAME, {home: s.h, entries: [start(KADAN_ROLE_NAME), old]})), ['full', 'interval']);
});

test('6 템플릿 수정 → full/template-changed', () => {
  const s = setup(), custom = path.join(s.h, 'conductor.md');
  fs.writeFileSync(custom, '# 격리 conductor 지침 v2');
  fs.writeFileSync(path.join(s.h, 'role-instructions.json'), JSON.stringify({version: 1, templates: {conductor: custom}}));
  assert.deepEqual(meta(compose(KADAN_ROLE_NAME, {home: s.h, entries: s.entries})), ['full', 'template-changed']);
});

test('7 프로필 변경 → full/profile-changed', () => {
  const s = setup(), entries = [start(KADAN_ROLE_NAME), fullSend(KADAN_ROLE_NAME, s.f, {instructions: {mode: 'full', reason: 'x', profile: 'super', templateDigest: s.f.digest, generation: 0}})];
  assert.deepEqual(meta(compose(KADAN_ROLE_NAME, {home: s.h, entries})), ['full', 'profile-changed']);
});

test('8 같은 역할 새 start(새 대화) → full/generation-first', () => {
  const s = setup(), restarted = start(KADAN_ROLE_NAME, NOW - 300_000, {panePid: '200', conversationMode: 'new'});
  const r = compose(KADAN_ROLE_NAME, {home: s.h, entries: [...s.entries, restarted]});
  assert.deepEqual(meta(r), ['full', 'generation-first']);
  assert.equal(r.metadata.generation, 1);
});

test('9 worker·reviewer·super 수신자는 항상 full', () => {
  for (const profile of ['worker', 'reviewer', 'super']) {
    const role = 'kadan-시험판-' + profile, h = home();
    const f = {digest: composeRoleInstructions({home: h, role, profile, entries: [], slim: true, now: NOW}).metadata.templateDigest};
    const entries = [start(role), {...fullSend(role, f), instructions: {mode: 'full', reason: 'x', profile, templateDigest: f.digest, generation: 0}}];
    const r = compose(role, {home: h, entries, profile});
    assert.deepEqual(meta(r), ['full', 'profile-not-in-trial']);
    assert.match(r.instructions, /herdr 화면 확인|## Why/);
  }
});

test('10 raw 전송 → instructions 없음, 이력 영향 없음', () => {
  const s = setup(), raw = compose(KADAN_ROLE_NAME, {home: s.h, entries: s.entries, raw: true});
  assert.equal(raw.metadata.status, 'not-applied');
  assert.equal(raw.metadata.instructionsMode, undefined);
  // raw 줄(instructions 없음)이 사이에 있어도 요약 판정은 그대로다
  const rawEntry = {kind: 'send', role: KADAN_ROLE_NAME, keyDelivery: 'sent', t: iso(NOW - 1000), roleInstructions: raw.metadata};
  assert.deepEqual(meta(compose(KADAN_ROLE_NAME, {home: s.h, entries: [...s.entries, rawEntry]})), ['summary', 'within-interval']);
});

test('11 context.unavailable(원장 손상) → full/facts-unavailable', () => {
  const s = setup();
  assert.deepEqual(meta(compose(KADAN_ROLE_NAME, {home: s.h, entries: [...s.entries, {broken: '손상'}]})), ['full', 'facts-unavailable']);
});

test('12 guardedSend 원장 줄에 instructions 객체와 keyDelivery', () => {
  const h = home(), env = {KADAN_HOME: h};
  const floor = {name: 'fake', alive: () => true, pid: () => '100', send: () => ({keyDelivery: 'sent', inputAcceptance: 'accepted'})};
  const send = () => guardedSend({floor, session: `kadan-${KADAN_ROLE_NAME}`, role: KADAN_ROLE_NAME, message: '안녕', roleProfile: 'conductor', recordedPid: '100', env,
    readEntries: () => readLedger(h), record: e => appendLedger(e, h), saveBody: () => {}});
  const prior = {kind: 'start', role: KADAN_ROLE_NAME, session: `kadan-${KADAN_ROLE_NAME}`, panePid: '100', cmd: 'x', cwd: '/x/Dev/kadan'};
  fs.mkdirSync(h, {recursive: true});
  appendEntry(h, prior);
  const first = send(), second = send();
  assert.equal(first.keyDelivery, 'sent');
  assert.deepEqual(Object.keys(first.instructions).sort(), ['generation', 'mode', 'profile', 'reason', 'templateDigest']);
  assert.deepEqual([first.instructions.mode, first.instructions.reason], ['full', 'generation-first']);
  assert.deepEqual([second.instructions.mode, second.instructions.reason], ['summary', 'within-interval']);
  assert.ok(second.bytes < first.bytes);
  const stored = readLedger(h).filter(e => e.kind === 'send');
  assert.equal(stored.at(-1).instructions.mode, 'summary');
  assert.equal(stored.at(-1).keyDelivery, 'sent');
});

test('14 다른 레포 판 conductor는 1시간 안이어도 full/board-not-in-trial', () => {
  const h = home(), f = {digest: digestOf(OTHER_ROLE_NAME, h)};
  const entries = [start(OTHER_ROLE_NAME, undefined, {cwd: '/x/Dev/other-repo'}), fullSend(OTHER_ROLE_NAME, f)];
  assert.deepEqual(meta(compose(OTHER_ROLE_NAME, {home: h, entries})), ['full', 'board-not-in-trial']);
});

test('15 판정 불가(레포 근거 없음·이름과 레포 어긋남) → full/facts-unavailable', () => {
  const s = setup();
  const noRepo = [start(KADAN_ROLE_NAME, undefined, {cwd: '/x/_worktrees/kadan-foo'}), fullSend(KADAN_ROLE_NAME, s.f)];
  assert.deepEqual(meta(compose(KADAN_ROLE_NAME, {home: s.h, entries: noRepo})), ['full', 'facts-unavailable']);
  const mismatch = [start(KADAN_ROLE_NAME, undefined, {cwd: '/x/Dev/other-repo'}), fullSend(KADAN_ROLE_NAME, s.f)];
  assert.deepEqual(meta(compose(KADAN_ROLE_NAME, {home: s.h, entries: mismatch})), ['full', 'facts-unavailable']);
  assert.deepEqual(meta(compose('감독없는이름', {home: s.h, entries: s.entries})), ['full', 'facts-unavailable']);
});

import {CardStore} from '../src/card-store.mjs';
import {appendLedger} from '../src/ledger.mjs';
function awaitImport() { return {CardStore}; }
function appendEntry(h, entry) { appendLedger(entry, h); }
