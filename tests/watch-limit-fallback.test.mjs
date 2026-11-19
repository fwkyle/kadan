// 한도 경보에 붙는 교대 명령 한 줄(kadan/work-limit-fallback PR B). 순수 함수만 시험한다: 설정·원장 항목은 손으로 만든 값이다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {limitFallbackLine} from '../src/watch-limit-fallback.mjs';
import {ocxStillLimited} from '../src/ocx-refresh.mjs';
import {formatAlertBody} from '../src/watch-alert-body.mjs';

const RUNNERS = {
  codex: {spawn: 'codex --model {model} -c model_reasoning_effort="{effort}"'},
  claude: {spawn: 'claude --model {model} --effort {effort}'},
  omo: {spawn: 'omo --model {model}'},
};
const item = (runner, model, effort = 'high') => ({runner, model, effort});
const GPT = item('codex', 'gpt-6.1-sol');
const GPT2 = item('codex', 'gpt-6-astra');
const OPUS = item('claude', 'claude-opus-5-5');
const SONNET = item('claude', 'claude-sonnet-5-5');
const DEEP = item('omo', 'command-code/deepseek-v4.1-flash');
const settings = ({roles = {}, fallback = {}} = {}) => ({
  version: 1, revision: 9, activePreset: 'main', runners: RUNNERS,
  presets: {main: {roles: {worker: GPT, reviewer: OPUS, ...roles}, fallback}},
});
const cmdOf = value => RUNNERS[value.runner].spawn.replace('{model}', value.model).replace('{effort}', value.effort);
const start = (role, value, extra = {}) => ({kind: 'start', role, session: `kadan-${role}`, cmd: cmdOf(value), ...extra});
const alertOf = (role, line = "■ You've hit your usage limit. Try again at 3:00 PM.") => ({kind: '한도', role, session: `kadan-${role}`, line});
const STILL = {outcome: 'ok', usage: {fiveHour: 99, weekly: 97}};

test('claude 작업자: 폴백 1번 명령 한 줄(감독 지침 순서, 이유는 한도 줄)', () => {
  const line = limitFallbackLine({alert: alertOf('w', "You've hit your session limit · resets 3pm (Asia/Seoul)"),
    entries: [start('w', SONNET, {roleProfile: 'worker'})], settings: settings({fallback: {worker: [GPT2]}}), ocx: null});
  // 명령에 붙여 넣는 글이라 아포스트로피는 공백으로 바뀐다.
  assert.equal(line, '대체 후보 1번 있음 — 감독 지침 한도 교대 절차대로(교대 전 화면 재확인, 계정 전환 뒤면 원래 세션에 이어가기 1회 먼저 → 후임 시작 → 폴더·브랜치 확인 → 선임 stop): '
    + 'cd <선임 작업 폴더> && kadan start <새 이름> --profile worker --fallback 1 '
    + '--reason "한도: You ve hit your session limit · resets 3pm (Asia/Seoul)"');
});

test('어려운 일 작업자(시작 기록 difficulty hard): --difficulty hard와 worker-hard 목록의 번호', () => {
  const s = settings({roles: {'worker-hard': GPT}, fallback: {worker: [OPUS], 'worker-hard': [GPT2, OPUS]}});
  const line = limitFallbackLine({alert: alertOf('h'), entries: [start('h', GPT, {roleProfile: 'worker', difficulty: 'hard'})],
    settings: s, ocx: STILL});
  assert.match(line, /^대체 후보 1번 있음 — .*cd <선임 작업 폴더> && kadan start <새 이름> --profile worker --difficulty hard --fallback 1 --reason "한도: /);
  assert.match(limitFallbackLine({alert: alertOf('h'), entries: [start('h', GPT, {roleProfile: 'worker', difficulty: 'hard'})],
    settings: settings({roles: {'worker-hard': GPT}, fallback: {worker: [OPUS]}}), ocx: STILL}) ?? '(없음)', /^\(없음\)$/,
  '어려운 일 목록이 비어 있으면 작업자 목록으로 내려가지 않는다');
});

test('이미 폴백 1번으로 떠 있는 세션은 그다음 번호(2)', () => {
  const entries = [start('w', GPT2, {roleProfile: 'worker', launchSource: 'fallback', fallbackIndex: 1})];
  const line = limitFallbackLine({alert: alertOf('w'), entries, settings: settings({fallback: {worker: [GPT2, OPUS]}}), ocx: STILL});
  assert.match(line, /--fallback 2 /);
  assert.match(line, /^대체 후보 2번 있음/);
});

test('줄이 없는 경우: 목록 빔·남은 후보 없음·같은 실행기와 모델', () => {
  const entries = [start('w', GPT, {roleProfile: 'worker'})];
  assert.equal(limitFallbackLine({alert: alertOf('w'), entries, settings: settings(), ocx: STILL}), null, '목록 빔');
  const last = [start('w', OPUS, {roleProfile: 'worker', fallbackIndex: 1})];
  assert.equal(limitFallbackLine({alert: alertOf('w'), entries: last, settings: settings({fallback: {worker: [OPUS]}}), ocx: null}), null, '남은 후보 없음');
  const sameModel = [start('w', GPT, {roleProfile: 'worker'})];
  assert.equal(limitFallbackLine({alert: alertOf('w'), entries: sameModel, settings: settings({fallback: {worker: [GPT]}}), ocx: STILL}), null, '같은 모델');
});

test('codex는 ocx 새로고침이 아직 한도일 때만: 가짜 한도·실패·시간 초과·숫자 없음·대상 아님·결과 없음은 줄 없음', () => {
  const entries = [start('w', GPT, {roleProfile: 'worker', harness: 'codex', model: 'gpt-6.1-sol'})];
  const s = settings({fallback: {worker: [OPUS]}});
  const fake = {outcome: 'ok', usage: {fiveHour: 12, weekly: 3}};
  for (const [name, ocx] of [['가짜 한도', fake], ['실패', {outcome: 'failed'}], ['시간 초과', {outcome: 'timeout'}],
    ['숫자 미확인', {outcome: 'ok', usage: {}}], ['대상 아님', {outcome: 'skipped', reason: 'other-provider'}], ['결과 없음', null], ['미정의', undefined]])
    assert.equal(limitFallbackLine({alert: alertOf('w'), entries, settings: s, ocx}), null, name);
  assert.match(limitFallbackLine({alert: alertOf('w'), entries, settings: s, ocx: STILL}), /^대체 후보 1번 있음/);
  assert.match(limitFallbackLine({alert: alertOf('w'), entries, settings: s, ocx: {outcome: 'ok', usage: {fiveHour: 99}}}), /^대체 후보 1번 있음/, '한쪽 숫자만 높아도');
  assert.equal(ocxStillLimited({outcome: 'ok', usage: {fiveHour: 89, weekly: 100}}), true);
  assert.equal(ocxStillLimited({outcome: 'ok', usage: {fiveHour: 89, weekly: 10}}), false);
});

test('감독·슈퍼감독·비서·프로필 기록 없는 세션에는 붙이지 않는다', () => {
  const s = settings({fallback: {worker: [OPUS]}});
  for (const profile of ['conductor', 'super', 'secretary', undefined])
    assert.equal(limitFallbackLine({alert: alertOf('c'), entries: [start('c', SONNET, profile ? {roleProfile: profile} : {})], settings: s, ocx: null}), null, String(profile));
  assert.equal(limitFallbackLine({alert: alertOf('c'), entries: [], settings: s, ocx: null}), null, '시작 기록 없음');
  assert.equal(limitFallbackLine({alert: alertOf('w'), entries: [start('w', SONNET, {roleProfile: 'worker'})], settings: null, ocx: null}), null, '설정 없음');
});

test('살아 있는 세션을 재사용한 start(명령 없음)는 기준이 아니다: 그 앞의 명령 있는 start를 쓴다', () => {
  const entries = [start('w', SONNET, {roleProfile: 'worker'}), {kind: 'start', role: 'w', session: 'kadan-w', reuseOf: 'abc'}];
  assert.match(limitFallbackLine({alert: alertOf('w'), entries, settings: settings({fallback: {worker: [GPT2]}}), ocx: null}), /--fallback 1 /);
});

test('검수자(reviewFor 없음, 옛 방식): 다음 후보와 계열 확인 문구', () => {
  const entries = [start('r', OPUS, {roleProfile: 'reviewer'})];
  const line = limitFallbackLine({alert: alertOf('r'), entries, settings: settings({fallback: {reviewer: [SONNET, DEEP]}}), ocx: null});
  assert.match(line, /kadan start <새 이름> --profile reviewer --fallback 1 /);
  assert.match(line, /검수 대상 작업자와 계열이 같아지지 않는지 확인 · --for와는 함께 못 씀/);
});

test('검수자(reviewFor 있음): 작업자와 다른 계열 첫 후보의 번호, 같은 계열·계열 모름은 건너뜀', () => {
  const reviewFor = {role: 'w', model: 'gpt-6.1-sol', family: 'gpt'};
  const entries = [start('r', OPUS, {roleProfile: 'reviewer', reviewFor})];
  // 후보 [gpt(같은 계열), claude(지금 세션과 같은 모델), deepseek] → 3번.
  const s = settings({fallback: {reviewer: [GPT2, OPUS, DEEP]}});
  const line = limitFallbackLine({alert: alertOf('r'), entries, settings: s, ocx: null});
  assert.match(line, /--profile reviewer --fallback 3 /);
  assert.match(line, /검수 대상 w gpt-6\.1-sol\(gpt\)와 다른 계열 deepseek 후보/);
  // 후보 [gpt, claude] 중 gpt는 같은 계열, claude는 지금 세션과 같은 모델 → 줄 없음.
  assert.equal(limitFallbackLine({alert: alertOf('r'), entries, settings: settings({fallback: {reviewer: [GPT2, OPUS]}}), ocx: null}), null);
  // 계열을 모르는 후보(이름 규칙에 없음)는 다른 계열로 보지 않는다.
  const unknown = item('omo', 'mystery/model-1');
  assert.equal(limitFallbackLine({alert: alertOf('r'), entries, settings: settings({fallback: {reviewer: [unknown]}}), ocx: null}), null);
});

test('검수자가 폴백 1번으로 떠 있으면 2번부터 본다(reviewFor 있음)', () => {
  const reviewFor = {role: 'w', model: 'gpt-6.1-sol', family: 'gpt'};
  const entries = [start('r', SONNET, {roleProfile: 'reviewer', reviewFor, fallbackIndex: 1})];
  const s = settings({fallback: {reviewer: [SONNET, GPT2, DEEP]}});
  assert.match(limitFallbackLine({alert: alertOf('r'), entries, settings: s, ocx: null}), /--fallback 3 /);
});

test('한도가 아닌 경보에는 붙이지 않고, 이유 글의 따옴표·셸 기호·이메일은 지운다', () => {
  const entries = [start('w', SONNET, {roleProfile: 'worker'})];
  const s = settings({fallback: {worker: [GPT2]}});
  assert.equal(limitFallbackLine({alert: {...alertOf('w'), kind: '끊김'}, entries, settings: s, ocx: null}), null);
  const line = limitFallbackLine({alert: alertOf('w', 'You\'ve hit your usage limit a@b.com "q" `x` $(y) \\ z'), entries, settings: s, ocx: null});
  assert.match(line, /--reason "한도: [^"`$\\@]*"$/);
  assert.ok(!line.includes('a@b.com'));
});

test('일시적 429 경보(자동 재개 대상)에는 붙이지 않고, 재개를 포기한 경보(명시 한도·3회 소진)에는 붙인다', () => {
  const entries = [start('w', SONNET, {roleProfile: 'worker'})];
  const s = settings({fallback: {worker: [GPT2]}});
  const plain = alertOf('w', '■ Exceeded retry limit, last status: 429 Too Many Requests');
  assert.equal(limitFallbackLine({alert: plain, entries, settings: s, ocx: null}), null);
  assert.equal(limitFallbackLine({alert: {...plain, id: 'disconnect:kadan-w:x'}, entries, settings: s, ocx: null}), null);
  for (const reason of ['429 제한 재개 3회 소진', '명시 한도/재시도 시각 확인 필요 — 자동 재개 제외', '재개 전달 실패 — 중복 전송하지 않음'])
    assert.match(limitFallbackLine({alert: {...alertOf('w', reason), id: 'rate-limit:kadan-w:1:2:no-success'}, entries, settings: s, ocx: null}), /^대체 후보 1번 있음/, reason);
});

test('이 모듈은 읽기 함수를 받지 않고 같은 입력에 같은 답을 준다(새 원장 읽기 없음)', () => {
  assert.equal(limitFallbackLine.length, 1, '인자는 값 하나(alert·entries·settings·ocx)뿐이다');
  const args = {alert: alertOf('w'), entries: [start('w', SONNET, {roleProfile: 'worker'})], settings: settings({fallback: {worker: [GPT2]}}), ocx: null};
  assert.equal(limitFallbackLine(args), limitFallbackLine(args));
});

test('경보 본문: fallbackLine이 있으면 ocx 줄 뒤에 붙고, 한도가 아닌 경보나 값이 없으면 변하지 않는다', () => {
  const base = {kind: '한도', session: 'kadan-w', line: "You've hit your session limit"};
  assert.equal(formatAlertBody(base), "한도 kadan-w (You've hit your session limit)");
  assert.equal(formatAlertBody({...base, fallbackLine: '대체 후보 1번 있음 — X'}), "한도 kadan-w (You've hit your session limit) · 대체 후보 1번 있음 — X");
  assert.equal(formatAlertBody({...base, kind: '끊김', fallbackLine: 'X'}), "끊김 kadan-w (You've hit your session limit)");
});

test('교대 순서(감독 지침과 같음): 화면 재확인·이어가기 → 후임 start → 폴더·브랜치 확인 → 선임 stop, 선행 정리 문구 없음', () => {
  const entries = [start('w', SONNET, {roleProfile: 'worker'})];
  const s = settings({fallback: {worker: [GPT2]}});
  const reviewerEntries = [start('r', OPUS, {roleProfile: 'reviewer', reviewFor: {role: 'w', model: 'gpt-6.1-sol', family: 'gpt'}})];
  for (const [role, list, key] of [['w', entries, 'worker'], ['r', reviewerEntries, 'reviewer']]) {
    const line = limitFallbackLine({alert: alertOf(role), entries: list, settings: settings({fallback: {[key]: key === 'worker' ? [GPT2] : [GPT2, DEEP]}}), ocx: null});
    assert.ok(line, role);
    const at = text => line.indexOf(text);
    assert.ok(at('화면 재확인') >= 0 && at('원래 세션에 이어가기 1회 먼저') > at('화면 재확인'), '재확인 → 이어가기');
    assert.ok(at('후임 시작') > at('이어가기'), '이어가기 → 후임 시작');
    assert.ok(at('폴더·브랜치 확인') > at('후임 시작') && at('선임 stop') > at('폴더·브랜치 확인'), '후임 시작 → 확인 → 선임 stop');
    assert.ok(!line.includes('kadan stop'), '명령 줄에 선임 종료를 앞세우지 않는다');
    assert.ok(!/옛 세션 정리|선임 정리 뒤|정리 뒤/u.test(line), '선행 정리 문구 없음');
    assert.match(line, /cd <선임 작업 폴더> && kadan start <새 이름> /u, '선임 작업 폴더에서 start');
  }
});
