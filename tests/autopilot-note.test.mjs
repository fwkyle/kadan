import "./helpers/isolated-home.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {autopilotCommand} from '../src/commands/autopilot.mjs';
import {autopilotState, finishAutopilot, AUTO_LINES} from '../src/autopilot.mjs';
import {summarizeAutopilot, NOTICE_LIMIT} from '../src/autopilot-summary.mjs';
import {buildAutopilotNote} from '../src/autopilot-note.mjs';

// 가짜 시계·가짜 우편만 쓴다. 운영 홈·우편·디코·OS 알림에 닿지 않는다. 역할 이름도 시험용이다.
const T0 = Date.parse('2026-11-02T14:00:00.000Z');
const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;

function fixture({level = null} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-autopilot-note-'));
  const file = path.join(home, 'hierarchy.json');
  fs.writeFileSync(file, JSON.stringify({'a-슈퍼감독': '@user', 'a-감독': 'a-슈퍼감독'}));
  appendLedger({kind: 'hierarchy-loaded', path: file, hash: 'x', by: 'watch'}, home);
  appendLedger({kind: 'start', role: 'a-슈퍼감독', session: 'kadan-a-슈퍼감독', roleProfile: 'super'}, home);
  let now = T0;
  const deps = {
    now: () => now,
    readWorks: () => [{key: 'a/w1', status: 'open', owner: 'a-감독', executions: []}],
    sendMail: () => ({ok: true, mailId: 'm1'}),
    notify: () => {},
  };
  const run = (args, flags = {}, by = '사람') => autopilotCommand(args, flags, {home, by, deps});
  const notes = () => readLedger(home).filter(e => e.kind === 'autopilot-note');
  const on = () => run(['on', '밤 위임'], level ? {level} : {});
  return {home, run, notes, on, tick: ms => { now += ms; }, deps};
}

test('켜진 동안 autopilot note decision: autopilot-note 사건 기록, 출력에 [Autopilot 결정] 접두', () => {
  const f = fixture({level: 'autopilot'});
  f.on();
  f.tick(60_000);
  const line = f.run(['note', 'decision', '추천안', 'A로', '진행'], {work: 'a/w1'}, 'a-감독');
  assert.equal(typeof line, 'string');
  assert.match(line, /^\[Autopilot 결정\] 추천안 A로 진행/);
  const [n] = f.notes();
  assert.equal(n.noteKind, 'decision');
  assert.equal(n.text, '추천안 A로 진행');
  assert.equal(n.work, 'a/w1');
  assert.equal(n.by, 'a-감독');
  assert.equal(n.t, new Date(T0 + 60_000).toISOString());
});

test('꺼진 동안 autopilot note: 종료 코드 2로 거절하고 기록 없음', () => {
  const f = fixture();
  assert.throws(() => f.run(['note', 'decision', '아무거나']), e => e.exitCode === 2 && /켜져 있을 때만/.test(e.message));
  f.on();
  f.run(['off']);
  assert.throws(() => f.run(['note', 'start', '아무거나']), e => e.exitCode === 2);
  assert.equal(f.notes().length, 0);
});

test('입력 검사: 종류·hold 종류·gate 판정·PR 모양·빈 문구', () => {
  const f = fixture();
  f.on();
  assert.throws(() => f.run(['note', 'wat', '문구']), /decision\|hold\|gate\|merge\|start/);
  assert.throws(() => f.run(['note', 'decision']), /한 줄/);
  assert.throws(() => f.run(['note', 'hold', '보류']), /--hold-kind/);
  assert.throws(() => f.run(['note', 'hold', '보류'], {'hold-kind': 'x'}), /--hold-kind/);
  assert.throws(() => f.run(['note', 'decision', '결정'], {'hold-kind': 'gate'}), /hold에만/);
  assert.throws(() => f.run(['note', 'gate', '판정']), /--verdict/);
  assert.throws(() => f.run(['note', 'merge', '머지'], {pr: '잘못'}), /저장소#번호/);
  assert.equal(f.notes().length, 0);
});

test('text는 글자 200개 + …로 자르고 줄바꿈은 공백 하나로 접는다', () => {
  const f = fixture();
  f.on();
  f.run(['note', 'decision', `가${'나'.repeat(300)}\n다`]);
  const [n] = f.notes();
  assert.equal([...n.text].length, 201);
  assert.ok(n.text.endsWith('…'));
  assert.ok(!n.text.includes('\n'));
});

test('함정 회귀: autopilot-note가 많아도 autopilotState 켜짐·꺼짐 판정이 바뀌지 않는다', () => {
  const f = fixture();
  f.on();
  for (let i = 0; i < 5; i++) f.run(['note', 'decision', `결정 ${i}`]);
  const entries = readLedger(f.home);
  assert.equal(autopilotState(entries, [], T0 + 1000).on, true);
  // 끝 시각이 지나면 autopilot-note가 뒤에 있어도 꺼짐(만료 대기)으로 읽힌다.
  const after = autopilotState(entries, [], T0 + 9 * 3600_000);
  assert.equal(after.on, false);
  assert.equal(after.pending?.phase, 'expired');
  // 끄고 나면 autopilot-note가 마지막 사건이어도 꺼짐이다.
  f.run(['off']);
  assert.equal(autopilotState(readLedger(f.home), [], T0 + 1000).on, false);
});

const startEvent = {kind: 'autopilot', phase: 'on', by: '사람', text: '밤', viaChat: false, t: new Date(T0).toISOString(), until: new Date(T0 + 8 * 3600_000).toISOString(), to: [], delivered: []};
const note = (i, noteKind, text, extra = {}) => ({kind: 'autopilot-note', noteKind, text, by: 'a-감독', t: new Date(T0 + (i + 1) * 60_000).toISOString(), ...extra});
const summarize = notes => summarizeAutopilot({start: startEvent, phase: 'expired', endedAt: T0 + 8 * 3600_000, entries: notes, decisionEvents: [], readBody: () => null});

test('요약: 종류별 줄(결정 3·보류 3종·관문 2·머지 1·시작 2)이 맞고 1,800자 안', () => {
  const notes = [
    note(0, 'decision', '결정 하나'), note(1, 'decision', '결정 둘'), note(2, 'decision', '결정 셋'),
    note(3, 'hold', '결정 보류 하나', {holdKind: 'decision'}),
    note(4, 'hold', '관문 실패 하나', {holdKind: 'gate', reason: 'CI 실패'}),
    note(5, 'hold', '배포 저장소 하나', {holdKind: 'deploy-repo', reason: '/tmp/근거.md', pr: 'x/site#7'}),
    note(6, 'gate', '통과', {verdict: 'pass', pr: 'kadan#1'}), note(7, 'gate', '거절', {verdict: 'reject', pr: 'kadan#2', reason: '검수 없음'}),
    note(8, 'merge', '머지 완료', {pr: 'kadan#1', sha: 'abc1234'}),
    note(9, 'start', '일감 하나', {work: 'a/w2'}), note(10, 'start', '일감 둘', {work: 'a/w3'}),
  ];
  const s = summarize(notes);
  assert.ok(s.text.length <= NOTICE_LIMIT);
  assert.equal(s.counts.noteDecisions, 3);
  assert.deepEqual(s.counts.noteHolds, {decision: 1, gate: 1, 'deploy-repo': 1});
  assert.equal(s.counts.gatePass, 1);
  assert.equal(s.counts.gateReject, 1);
  assert.equal(s.counts.merges, 1);
  assert.equal(s.counts.starts, 2);
  assert.match(s.text, /대신 정한 결정 3건/);
  assert.match(s.text, /보류: 결정 1건 · 관문 실패 1건 · 배포 저장소 1건/);
  assert.match(s.text, /배포 저장소 보류[^\n]*x\/site#7/);
  assert.match(s.text, /관문 통과 1건 · 거절 1건/);
  assert.match(s.text, /kadan#1[^\n]*abc1234/);
  assert.match(s.text, /시작한 밤 일감 2건/);
});

test('요약: 구간 밖 autopilot-note는 세지 않는다', () => {
  const early = note(-5, 'decision', '구간 전');
  const late = {...note(0, 'decision', '구간 후'), t: new Date(T0 + 9 * 3600_000).toISOString()};
  const s = summarize([early, late, note(1, 'decision', '구간 안')]);
  assert.equal(s.counts.noteDecisions, 1);
});

test('요약: 결정 50개(긴 문장)여도 1,800자 안이고 외 n건이 맞다', () => {
  const notes = Array.from({length: 50}, (_, i) => note(i, 'decision', `긴 결정 ${i} ${'가'.repeat(190)}`));
  const s = summarize(notes);
  assert.ok(s.text.length <= NOTICE_LIMIT, `길이 ${s.text.length}`);
  assert.equal(s.counts.noteDecisions, 50);
  const listed = (s.text.match(/^ {2}· 결정:/gm) ?? []).length;
  assert.ok(listed > 0 && listed < 50);
  assert.match(s.text, new RegExp(`결정 외 ${50 - listed}건`));
  // 모든 종류가 길게 쌓여도 상한 안이다.
  const all = ['decision', 'hold', 'gate', 'merge', 'start'].flatMap((k, j) => Array.from({length: 30}, (_, i) => note(j * 30 + i, k, `${k} ${i} ${'나'.repeat(190)}`,
    {...(k === 'hold' ? {holdKind: 'gate'} : {}), ...(k === 'gate' ? {verdict: i % 2 ? 'pass' : 'reject'} : {}), pr: `r#${i}`, sha: 'abcdef1'})));
  const t = summarize(all).text;
  assert.ok(t.length <= NOTICE_LIMIT, `길이 ${t.length}`);
  assert.match(t, /대신 정한 결정 30건/);
});

test('요약: 통과 2건과 머지 기록 1건이면 "통과 후 머지 미확인 1건"과 그 PR이 나온다', () => {
  const gate = (i, pr) => note(i, 'gate', '통과', {verdict: 'pass', pr, sha: 'abcdef1234'});
  const t = summarize([gate(0, 'k#1'), gate(1, 'k#2'), note(2, 'merge', '머지', {pr: 'k#1', sha: 'abc1234'})]);
  assert.equal(t.counts.unmerged, 1);
  assert.match(t.text, /통과 후 머지 미확인 1건/);
  assert.match(t.text, /미확인: k#2/);
  assert.doesNotMatch(t.text, /미확인: k#1/);
  const all = summarize([gate(0, 'k#1'), note(1, 'merge', '머지', {pr: 'k#1'})]);
  assert.equal(all.counts.unmerged, 0);
  assert.doesNotMatch(all.text, /머지 미확인/);
  assert.ok(t.text.length <= 1800);
});

test('F4. 대소문자만 다른 PR 키(관문 acme/app#7, 머지 Acme/App#7)는 같은 PR로 짝지어 미확인 0건이다', () => {
  const g = note(0, 'gate', '통과', {verdict: 'pass', pr: 'acme/app#7'});
  const m = note(1, 'merge', '머지', {pr: 'Acme/App#7', sha: 'abc1234'});
  const t = summarize([g, m]);
  assert.equal(t.counts.unmerged, 0);
  assert.equal(t.counts.merges, 1);
  assert.doesNotMatch(t.text, /머지 미확인/);
  assert.equal(buildAutopilotNote({words: ['merge', '머지'], flags: {pr: 'Acme/App.git#7'}, by: 'a', now: T0}).pr, 'acme/app#7');
  assert.equal(buildAutopilotNote({words: ['merge', '머지'], flags: {pr: 'kadan#7'}, by: 'a', now: T0}).pr, 'kadan#7');
});

test('F5. 허용 키 50개와 긴 원문이어도 요약은 1,800자 이하이고 허용 첫 줄은 앞 5개 + 접기다', () => {
  const allow = Array.from({length: 50}, (_, i) => `owner${i}/repo${i}`);
  const r = summarizeAutopilot({start: {...startEvent, allow, quote: '원'.repeat(3000)}, phase: 'expired', endedAt: T0 + 8 * 3600_000,
    entries: Array.from({length: 40}, (_, i) => note(i, 'decision', '결'.repeat(190))), decisionEvents: [], readBody: () => null});
  assert.ok(r.text.length <= 1800, String(r.text.length));
  const first = r.text.split('\n')[0];
  assert.match(first, /^머지 허용\(--allow\): owner0\/repo0, owner1\/repo1, owner2\/repo2, owner3\/repo3, owner4\/repo4 외 45개 \(전체: kadan autopilot status\)/);
  assert.doesNotMatch(first, /owner5\//);
});

test('요약: 허용(--allow)이 있으면 첫 줄에 보이고, 없으면 줄이 없다', () => {
  const withAllow = summarizeAutopilot({start: {...startEvent, allow: ['acme/app', 'foo/bar'], quote: '이번엔 승인'}, phase: 'expired', endedAt: T0 + 8 * 3600_000,
    entries: [note(0, 'decision', '결정')], decisionEvents: [], readBody: () => null});
  const lines = withAllow.text.split('\n');
  assert.equal(lines[0], '머지 허용(--allow): acme/app, foo/bar — kyle "이번엔 승인"');
  assert.match(lines[1], /^kyle 위임:/);
  assert.doesNotMatch(summarize([note(0, 'decision', '결정')]).text, /--allow/);
});

test('요약 머지 문구: 정직하게 쓴다(기록 없는 머지를 0이라고 단정하지 않는다)', () => {
  const gate = (i, pr) => note(i, 'gate', '통과', {verdict: 'pass', pr});
  const merge = (i, pr) => note(i, 'merge', '머지', {pr, sha: 'abc1234'});
  const fewer = summarize([gate(0, 'k#1'), gate(1, 'k#2'), merge(2, 'k#1')]).text;
  assert.match(fewer, /관문 통과 2건 · 머지 기록 1건/);
  assert.match(fewer, /관문 기록 없이 한 머지는 GitHub에서 확인/);
  const more = summarize([gate(0, 'k#1'), merge(1, 'k#1'), merge(2, 'k#9')]).text;
  assert.match(more, /관문 통과 1건 · 머지 기록 2건/);
  assert.match(more, /통과 기록보다 머지 기록이 많음/);
  const none = summarize([note(0, 'decision', '결정')]).text;
  assert.doesNotMatch(none, /머지 기록 0건/);
  assert.match(none, /관문·머지 기록 없음[^\n]*GitHub에서 확인/);
});

test('끝 사건에 autopilot-note 집계가 담긴다(finishAutopilot 경로)', () => {
  const f = fixture({level: 'autopilot'});
  f.on();
  f.run(['note', 'decision', '정한 것']);
  f.run(['note', 'start', '시작한 것']);
  f.tick(60_000);
  const end = finishAutopilot({home: f.home, by: '사람', phase: 'off', deps: f.deps});
  assert.equal(end.summary.counts.noteDecisions, 1);
  assert.equal(end.summary.counts.starts, 1);
  assert.match(end.summary.text, /대신 정한 결정 1건/);
});

test('Autopilot 단계 지침 (5)번 줄에 autopilot note 안내가 있고 줄 번호는 그대로다', () => {
  assert.ok(AUTO_LINES.some(l => /kadan autopilot note/.test(l)));
  const f = fixture({level: 'autopilot'});
  const sent = [];
  f.deps.sendMail = (role, message) => { sent.push(message); return {ok: true, mailId: 'm'}; };
  f.run(['on', '밤'], {level: 'autopilot'});
  assert.match(sent[0], /kadan autopilot note/);
  assert.match(sent[0], /\(10\) 새 일감은 `kadan autopilot picks/);
  assert.match(sent[0], /위 \(1\)~\(10\) 줄/);
});

test('CLI 입구: Autopilot 단계 켜짐 홈에서 역할 세션의 autopilot note가 autopilotGuard를 통과해 기록된다', () => {
  const f = fixture();
  appendLedger({...startEvent, level: 'autopilot',
    t: new Date().toISOString(), until: new Date(Date.now() + 3600_000).toISOString()}, f.home);
  const env = {...process.env, KADAN_HOME: f.home, KADAN_WINDOW: 'none', KADAN_ROLE: 'a-감독'};
  const r = spawnSync(process.execPath, [CLI, 'autopilot', 'note', 'decision', '입구 통과', '--work', 'a/w1'], {env, encoding: 'utf8', timeout: 20_000});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\[Autopilot 결정\] 입구 통과/);
  assert.equal(f.notes().length, 1);
  assert.equal(f.notes()[0].by, 'a-감독');
  // 꺼진 홈은 거절 종료 코드 2.
  const off = fixture();
  const r2 = spawnSync(process.execPath, [CLI, 'autopilot', 'note', 'decision', '꺼짐'], {env: {...env, KADAN_HOME: off.home}, encoding: 'utf8', timeout: 20_000});
  assert.equal(r2.status, 2);
  assert.equal(off.notes().length, 0);
});

// ── 1차 검수 지적(F1~F4) 회귀. 제어 문자는 문자열로만 단언하고 터미널에 출력하지 않는다.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

test('F1 제어 문자: 저장된 text·reason·work·pr와 명령 출력·요약에 제어 문자가 남지 않는다', () => {
  const f = fixture({level: 'autopilot'});
  f.on();
  const out = f.run(['note', 'decision', '정상\u001b[2J\u0000\b\u0085\n다음'], {work: 'a/w\u001b1', reason: '이유\u0007\t끝', pr: 'k\u001b#3'});
  const [n] = f.notes();
  assert.equal(n.text, '정상[2J 다음');
  assert.equal(n.reason, '이유 끝');
  assert.equal(n.work, 'a/w1');
  assert.equal(n.pr, 'k#3');
  assert.doesNotMatch(out, CONTROL);
  // 옛 기록·직접 쓴 사건도 요약에서 한 번 더 정리한다.
  const s = summarize([note(0, 'decision', '직접\u001b[31m쓴\u0000'), note(1, 'hold', '보류\b', {holdKind: 'deploy-repo', pr: 'x#1\u001b', reason: '근거\u0000'}), note(2, 'gate', '통과\u001b', {verdict: 'pass', pr: 'k\u001b#9'})]);
  assert.doesNotMatch(s.text, CONTROL);
  assert.match(s.text, /직접\[31m쓴/);
});

test('F1 반대 대조: 정상 문구·줄접기·탭·유니코드 200자+…는 그대로', () => {
  const f = fixture();
  f.on();
  f.run(['note', 'decision', '가\n나\t다  라']);
  f.run(['note', 'decision', '😀'.repeat(201)]);
  const [a, b] = f.notes();
  assert.equal(a.text, '가 나 다 라');
  assert.equal([...b.text].length, 201);
  assert.ok(b.text.endsWith('…'));
});

test('F2 거절만 있으면 관문 기록 없음이라 쓰지 않고 센 것을 그대로 쓴다', () => {
  const s = summarize([note(0, 'gate', '거절', {verdict: 'reject', pr: 'sample/repo#1', reason: '검수 없음'})]);
  assert.match(s.text, /관문 통과 0건 · 거절 1건/);
  assert.match(s.text, /머지 기록 0건[^\n]*GitHub에서 확인/);
  assert.doesNotMatch(s.text, /관문·머지 기록 없음/);
  // 관문·머지 기록이 정말 0일 때만 없음 문구
  assert.match(summarize([note(0, 'decision', '결정')]).text, /관문·머지 기록 없음/);
});

test('F3 통과 PR도 거절·머지처럼 목록에 보이고, 길면 줄이기 순서대로 줄어 1,800자 안', () => {
  const one = summarize([note(0, 'gate', '통과', {verdict: 'pass', pr: 'sample/repo#99'})]).text;
  assert.match(one, /통과: sample\/repo#99/);
  const many = Array.from({length: 60}, (_, i) => note(i, 'gate', '통과 '.repeat(40), {verdict: 'pass', pr: `sample/repo#${i + 1}`}));
  const s = summarize(many);
  assert.ok(s.text.length <= NOTICE_LIMIT);
  assert.match(s.text, /통과 외 \d+건/);
});

test('F4 기록이 있는 밤에는 처리한 일 없음 같은 전체 없음 문구를 쓰지 않고 칸만 좁혀 없음으로 쓴다', () => {
  const s = summarize([note(0, 'decision', '결정')]);
  assert.doesNotMatch(s.text, /밤사이 처리한 일 없음/);
  assert.match(s.text, /결정 답·우편·재시작 없음/);
  assert.match(s.text, /대신 정한 결정 1건/);
  // 기록도 없으면 옛 문구 그대로
  assert.match(summarize([]).text, /밤사이 처리한 일 없음/);
});
