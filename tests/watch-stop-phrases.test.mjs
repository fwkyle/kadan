import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {STOP_PHRASES, STOP_ACTIONS, SUPERVISOR_ERROR_PATTERN, WORKER_PHRASES, phraseOfLine, phraseAction}
  from '../src/watch-stop-phrases.mjs';
import {screenDisconnects, disconnectKind, DISCONNECT_ALERT_KINDS} from '../src/watch.mjs';

const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('목록 항목은 id가 겹치지 않고 행동이 셋 중 하나이며 낱말 또는 구조 판정 하나를 가진다', () => {
  const ids = STOP_PHRASES.map(p => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of STOP_PHRASES) {
    assert.ok(STOP_ACTIONS.includes(p.action), p.id);
    assert.equal(Boolean(p.pattern) !== Boolean(p.detect), true, `${p.id}: pattern 또는 detect 하나`);
    assert.ok(p.scope.length > 0 && p.sample, p.id);
  }
});

test('intervention.md 표가 목록의 모든 id를 참조한다(목록이 원본)', () => {
  const doc = read('skills/kadan-super/references/intervention.md');
  const missing = STOP_PHRASES.filter(p => !doc.includes('`' + p.id + '`')).map(p => p.id);
  assert.deepEqual(missing, [], '표에 없는 목록 id');
  assert.match(doc, /watch-stop-phrases\.mjs/);
});

test('감독 감시의 기존 판정 낱말은 목록으로 옮긴 뒤에도 같은 화면을 잡는다', () => {
  for (const text of ['stream disconnected', 'stream error', 'idle timeout waiting for SSE', 'Error running remote compact task',
    'Reconnecting...', '502 Bad Gateway', 'Provider unreachable', 'rate limit', 'No API key'])
    assert.equal(SUPERVISOR_ERROR_PATTERN.test(`• ${text} x`), true, text);
  for (const text of ['Working (5m 12s)', 'Context 67% used', '정상 대기']) assert.equal(SUPERVISOR_ERROR_PATTERN.test(text), false, text);
});

test('작업자 화면의 낱말 종류: 한도·설정·인증·끊김, 같은 목록을 작업자와 감독이 함께 쓴다', () => {
  const kind = text => disconnectKind(text);
  assert.equal(kind('Exceeded retry limit, last status: 429 Too Many Requests'), '한도');
  assert.equal(kind('No API key found'), '설정');
  assert.equal(kind('oauth/token request failed'), '인증');
  assert.equal(kind('• Reconnecting... 5/5 (1m 02s • esc to interrupt)'), '끊김');
  assert.deepEqual([...DISCONNECT_ALERT_KINDS].sort(), ['끊김', '설정', '인증', '한도']);
  const shared = WORKER_PHRASES.filter(p => p.scope.includes('supervisor')).map(p => p.id);
  for (const id of ['rate-limit-text', 'no-api-key', 'reconnecting', 'stream-error', 'bad-gateway']) assert.ok(shared.includes(id), id);
  assert.equal(phraseAction('설정'), 'replace-runner');
  assert.equal(phraseAction('한도'), 'auto-resume');
  assert.equal(phraseAction('끊김'), 'alert-supervisor');
  assert.equal(phraseOfLine('nothing here'), null);
});

test('시계 숫자만 다른 Reconnecting 줄은 같은 줄로 센다', () => {
  const a = screenDisconnects('x\n• Reconnecting... 2/5 (9m 34s • esc to interrupt)\n› Ask Codex to do anything');
  const b = screenDisconnects('x\n• Reconnecting... 3/5 (10m 34s • esc to interrupt)\n› Ask Codex to do anything');
  assert.deepEqual([...a.keys()], [...b.keys()]);
});

test('일하는 줄에 Working만 있고 오류 낱말이 없으면 잡지 않는다', () => {
  assert.equal(screenDisconnects('• Working (5m 12s • esc to interrupt)\n\n› Ask Codex to do anything\n').size, 0);
});
