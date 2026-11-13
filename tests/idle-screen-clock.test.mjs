import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {stableScreenText, screenDigest, observeScreens, readIdleState, writeIdleState, idleStatePath} from '../src/idle-screen-clock.mjs';

// Why: 쉼 시계는 "화면 글자가 그대로인가"로 잰다. 저절로 바뀌는 줄(바닥글·자동 압축 안내)은 지문에서 빠져야 하고,
// 모르는 모양·읽기 실패·프로세스 교체는 모두 "방금 바뀜"이어야 한다. 화면 모양은 2026-11-13 운영 표본(claude 2.1.323, codex)을 옮긴 것이다.
const RULE = '─'.repeat(60);
const claude = ({ctx = '13%', body = ['⏺ 결과를 등록했습니다.', ''], extra = []} = {}) => [
  ...body, ...extra, RULE, '❯ ', RULE, '  ~/Dev/kadan[main]', `  Fable 5.2 | effort:high | ctx:${ctx}`,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents', '', '',
].join('\n');
const codex = ({weekly = '55%', body = ['  KADAN:DONE exec-1 ok', '', '  Worked for 15m 34s • 3:29 PM', '', '']} = {}) => [
  ...body, '›', '', `  GPT-6.1-Sol high · ~/Dev/kadan · main · Context 52% used · weekly ${weekly} left · 475K window    ⚠ 2 warnings · f2 to view`,
].join('\n');

test('claude: 입력칸 아래 바닥글(ctx %·모델·권한 줄)이 바뀌어도 지문은 같다', () => {
  assert.equal(screenDigest(claude({ctx: '13%'})), screenDigest(claude({ctx: '0%'})));
  assert.doesNotMatch(stableScreenText(claude()), /ctx:|bypass permissions/);
  assert.match(stableScreenText(claude()), /결과를 등록했습니다/);
});

test('claude: 본문이 바뀌면 지문이 바뀐다', () => {
  assert.notEqual(screenDigest(claude()), screenDigest(claude({body: ['⏺ 다른 답입니다.', '']})));
});

test('claude: 쉬는 동안 자동 압축 안내 줄은 지문에서 뺀다', () => {
  const notice = '⏺ Compacted while idle, before the prompt cache expired · turn off with "idleCompaction": false in settings.json';
  assert.equal(screenDigest(claude()), screenDigest(claude({extra: [notice]})));
});

test('codex: 입력 줄 아래 상태 줄(주간 한도 %)이 바뀌어도 지문은 같다', () => {
  assert.equal(screenDigest(codex({weekly: '55%'})), screenDigest(codex({weekly: '54%'})));
  assert.notEqual(screenDigest(codex()), screenDigest(codex({body: ['  다른 출력', '', '']})));
});

test('입력칸 모양을 확인하지 못한 화면은 아무것도 빼지 않는다(덜 고르는 쪽)', () => {
  const unknown = ctx => ['출력 한 줄', `  Fable 5.2 | effort:high | ctx:${ctx}`].join('\n');
  assert.notEqual(screenDigest(unknown('13%')), screenDigest(unknown('14%')));
  assert.equal(stableScreenText(unknown('13%')), unknown('13%'));
});

test('끝의 빈 줄 수는 지문에 들어가지 않는다', () => {
  assert.equal(screenDigest('가\n나\n\n\n'), screenDigest('가\n나'));
});

const live = (session, pid = '100', created = 1) => ({session, pid, created});

test('처음 본 세션은 지금부터 센다. 지문이 같으면 처음 시각을 유지한다', () => {
  const first = observeScreens({previous: {}, live: [live('kadan-a')], read: () => claude(), now: 1000});
  assert.equal(first.clocks.get('kadan-a').since, 1000);
  const second = observeScreens({previous: first.sessions, live: [live('kadan-a')], read: () => claude({ctx: '0%'}), now: 5000});
  assert.equal(second.clocks.get('kadan-a').since, 1000, '바닥글만 바뀌었으면 그대로다');
  const third = observeScreens({previous: second.sessions, live: [live('kadan-a')], read: () => claude({body: ['새 글']}), now: 9000});
  assert.equal(third.clocks.get('kadan-a').since, 9000, '본문이 바뀌면 다시 센다');
});

test('프로세스가 바뀐 세션(같은 이름·같은 화면)은 다시 센다', () => {
  const first = observeScreens({previous: {}, live: [live('kadan-a', '100')], read: () => claude(), now: 1000});
  const second = observeScreens({previous: first.sessions, live: [live('kadan-a', '200')], read: () => claude(), now: 5000});
  assert.equal(second.clocks.get('kadan-a').since, 5000);
});

test('화면을 못 읽은 세션은 시각이 없고 상태에서도 빠진다. 사라진 세션의 줄도 없어진다', () => {
  const first = observeScreens({previous: {}, live: [live('kadan-a'), live('kadan-b'), live('kadan-c')], read: () => claude(), now: 1000});
  const second = observeScreens({previous: first.sessions, live: [live('kadan-a'), live('kadan-b')], now: 5000,
    read: session => { if (session === 'kadan-a') throw new Error('읽기 실패'); return session === 'kadan-b' ? '' : claude(); }});
  assert.deepEqual(second.clocks.get('kadan-a'), {unknown: '화면을 읽지 못함'});
  assert.deepEqual(second.clocks.get('kadan-b'), {unknown: '화면을 읽지 못함'}, '빈 화면도 읽지 못한 것이다');
  assert.deepEqual(Object.keys(second.sessions), []);
  // 다음에 다시 읽히면 이전 시각을 잇지 않고 지금부터 센다.
  const third = observeScreens({previous: second.sessions, live: [live('kadan-a')], read: () => claude(), now: 9000});
  assert.equal(third.clocks.get('kadan-a').since, 9000);
});

test('상태의 시각이 미래이거나 모양이 다르면 다시 센다', () => {
  const digest = screenDigest(claude());
  const cases = [{identity: '100:1', digest, since: 99_999}, {identity: '100:1', digest, since: 'x'}, {identity: '100:1', digest: '', since: 1}, null];
  for (const before of cases) {
    const out = observeScreens({previous: {'kadan-a': before}, live: [live('kadan-a')], read: () => claude(), now: 5000});
    assert.equal(out.clocks.get('kadan-a').since, 5000, JSON.stringify(before));
  }
});

test('상태 파일: 없거나 깨졌거나 모양이 다르면 빈 상태로 읽는다. 쓰기는 임시 파일을 남기지 않는다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-idle-clock-'));
  assert.deepEqual(readIdleState(home), {version: 1, lastRunAt: null, sessions: {}, attempts: {}, candidates: null, candidatesAt: null});
  for (const broken of ['{', '[]', '{"version":2,"sessions":{}}', '{"version":1,"sessions":[]}']) {
    fs.writeFileSync(idleStatePath(home), broken);
    assert.deepEqual(readIdleState(home).sessions, {}, broken);
  }
  writeIdleState(home, {lastRunAt: 7, sessions: {'kadan-a': {identity: '1:1', digest: 'd', since: 3}}, attempts: {a: 5}});
  assert.deepEqual(fs.readdirSync(home), ['idle-roles-state.json']);
  assert.equal(fs.statSync(idleStatePath(home)).mode & 0o777, 0o600);
  const back = readIdleState(home);
  assert.equal(back.lastRunAt, 7);
  assert.deepEqual(back.sessions['kadan-a'], {identity: '1:1', digest: 'd', since: 3});
  assert.deepEqual(back.attempts, {a: 5});
});
