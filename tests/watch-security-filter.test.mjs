import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {securityFilterNotice} from '../src/watch-security-filter.mjs';
import {assessRoles, screenDisconnects} from '../src/watch.mjs';
import {RateLimitRetry, terminal429} from '../src/watch-rate-limit.mjs';
import {formatAlertBody} from '../src/watch-alert-body.mjs';

// 실제 codex 화면 표본(비밀·개인 경로 제거). A: 도구 출력 뒤, B: 지시문 에코 뒤.
const samples = JSON.parse(readFileSync(new URL('./fixtures/security-filter-screens.json', import.meta.url), 'utf8'));
const A = samples['A-test-output-then-notice'];
const B = samples['B-prompt-echo-then-notice'];
const notice = 'ⓘ This content can’t be shown\n  We take extra care with some cybersecurity requests.\n  Learn more: https://help.openai.com/en/articles/20001326';
const footer = '  gpt-6.1-sol high · ~/Dev/PROJ · main · Context 65% used · weekly 37% left · 258K …';
const screen = (body = 'ordinary output', mid = '\n\n\n› Ask Codex to do anything\n\n') => `${body}\n\n${notice}${mid}${footer}\n`;

test('real screens are detected by shape', () => {
  for (const s of [A, B]) {
    const hit = securityFilterNotice(s);
    assert(hit, 'detected');
    assert.match(hit.line, /This content can.t be shown/u);
  }
  assert(securityFilterNotice(screen('x', '\n\n›\n\n')), 'empty prompt also ok');
  assert(securityFilterNotice(screen().replace('’', "'")), 'straight apostrophe');
});

test('fingerprint ignores the footer but separates a second notice', () => {
  const first = securityFilterNotice(A).fingerprint;
  assert.equal(securityFilterNotice(A.replace('weekly 37%', 'weekly 36%')).fingerprint, first);
  const again = `${A.trimEnd()}\n\nnew work\n\n${notice}\n\n\n› Ask Codex to do anything\n\n${footer}\n`;
  assert.notEqual(securityFilterNotice(again).fingerprint, first);
});

test('not by word: quotes, prose, busy, typed input, scrolled-up and wrong shape are ignored', () => {
  const noteLine = 'ⓘ This content can’t be shown';
  const cases = {
    prose: '• reviewing the cybersecurity requests; "This content can\'t be shown" appeared once\n\n› Ask Codex to do anything\n',
    bullet: `• ${noteLine}\n  We take extra care with some cybersecurity requests.\n\n› Ask Codex to do anything\n`,
    noCyberLine: `${noteLine}\n  Learn more: https://example.invalid\n\n\n› Ask Codex to do anything\n`,
    working: `${notice}\n\n• Working (3s • esc to interrupt)\n\n› Ask Codex to do anything\n`,
    typed: `${notice}\n\n\n› stop please\n`,
    noComposer: `${notice}\n\nsome shell prompt $\n`,
    textBetween: `${notice}\n\nagent kept talking here\n\n› Ask Codex to do anything\n`,
    done: `${notice}\n\nKADAN:DONE exec-1 ok\n\n› Ask Codex to do anything\n`,
    fenceQuote: `• The following is an example of the security message:\n\n\`\`\`text\n${notice}\n\n› Ask Codex to do anything\n\`\`\`\n\n› Ask Codex to do anything\n`,
    paragraphQuote: `• Observed notice was:\n\n${notice}\n\n› Ask Codex to do anything\n`,
    indentedQuote: `• 설명\n\n  ${notice.split('\n').join('\n  ')}\n\n› Ask Codex to do anything\n`,
    mentionedAbove: `the model said it can’t be shown earlier\n\n${notice}\n\n› Ask Codex to do anything\n`,
    laterOutput: `${notice}\n\n› Ask Codex to do anything\n\n• more work follows\n`,
    scrolledUp: `${notice}\n\n\n› Ask Codex to do anything\n${Array(20).fill('later output').join('\n')}\n`,
  };
  for (const [name, text] of Object.entries(cases)) assert.equal(securityFilterNotice(text), null, name);
  assert.equal(securityFilterNotice(undefined), null);
});

test('429 machinery stays untouched on a security-filter screen', () => {
  assert.equal(terminal429(A, 0), null);
  assert.equal(screenDisconnects(A).size, 0);
  const entries = [];
  const retry = new RateLimitRetry({record: e => entries.push(e), resume: () => assert.fail('no resume')});
  const seen = {role: 'rv', alive: true, pid: 1, expectedPid: 1, startedAt: 's', screen: A};
  retry.tick({entries, now: 0, tasks: [{role: 'rv', taskId: 't'}], observations: new Map([['kadan-rv', seen]]), fresh: () => true});
  assert.deepEqual(entries, []);
  assert.deepEqual(retry.alerts, []);
});

const obs = (s, digest = 'd', harness = 'codex') => ({role: 'rv', harness, alive: true, pid: 1, expectedPid: 1, digest, screen: s});
test('alert on the first cycle, one per fingerprint, no stall alert behind it, clears with the screen', () => {
  let states = new Map();
  let r = assessRoles(states, new Map([['kadan-rv', obs(A)]]), 30_000, 30_000, 3);
  const [alert, ...rest] = r.alerts;
  assert.equal(rest.length, 0);
  assert.equal(alert.kind, '보안필터');
  assert.notEqual(alert.kind, '한도');
  assert.equal(alert.role, 'rv');
  assert.match(alert.id, /^security-filter:kadan-rv:/u);
  states = r.states;
  for (let i = 0; i < 6; i++) {
    r = assessRoles(states, new Map([['kadan-rv', obs(A.replace('weekly 37%', `weekly ${30 - i}%`), 'same')]]), 30_000, 30_000, 3);
    states = r.states;
    assert.deepEqual(r.alerts.map(a => a.id), [alert.id], `cycle ${i}`);
  }
  r = assessRoles(states, new Map([['kadan-rv', obs('› Ask Codex to do anything\n', 'moved')]]), 30_000, 30_000, 3);
  assert.deepEqual(r.alerts, []);
});

test('alert body says the stop reason and the needed action', () => {
  const body = formatAlertBody({kind: '보안필터', role: 'rv', session: 'kadan-rv', id: 'x'});
  assert.match(body, /보안 필터로 멈춤/u);
  assert.match(body, /다른 실행기로 교대/u);
});

test('harness: only codex runs are checked; claude or unknown never alert', () => {
  for (const harness of ['claude', null, 'unset', 'devin']) {
    const o = obs(A, 'd', harness);
    if (harness === 'unset') delete o.harness;
    const r = assessRoles(new Map(), new Map([['kadan-rv', o]]), 30_000, 30_000, 3);
    assert.deepEqual(r.alerts, [], String(harness));
  }
  for (const harness of ['codex', 'kadan-codex']) {
    const r = assessRoles(new Map(), new Map([['kadan-rv', obs(A, 'd', harness)]]), 30_000, 30_000, 3);
    assert.equal(r.alerts.length, 1, harness);
  }
});

test('alert body shows the execution id when linked', () => {
  const body = formatAlertBody({kind: '보안필터', role: 'rv', session: 'kadan-rv', taskId: 'exec-1', id: 'x'});
  assert.match(body, /rv \/ exec-1/u);
});
