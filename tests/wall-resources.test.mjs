import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import * as wall from '../src/wall.mjs';

const sample = (current = {}) => ({ current: { memory: 'normal', freePercent: 44, swapUsed: 10114.56, load5: 16.59, ncpu: 12, ...current }, ncpu: 12 });
const snapshot = (extra = {}) => ({ tree: [], collectedAt: '2026-09-05T09:00:00Z', ledgerPath: '/fixed/ledger.jsonl', ledgerLines: 0, resources: sample(), ...extra });
const render = extra => wall.renderWallHtml(snapshot(extra));

test('관제 화면은 자원 숫자를 보인다 — Stats가 없는 사용자는 볼 곳이 없었다(2026-09-05)(card-60)', () => {
  assert.match(render(), /자원 · 메모리 여유 44% \(normal\) · 스왑 10114\.56MB · CPU 5분 16\.59\/12/);
  assert.match(render({ resources: sample({ freePercent: 43.6, swapUsed: 1, load5: 0 }) }), /44%.*1\.00MB.*0\.00\/12/);
});

test('카단 판정은 토글이고 기본은 꺼짐이다 — 판정은 의견이라 켠 사람만 본다(2026-09-05)(card-60)', () => {
  assert.doesNotMatch(render(), /카단 판정 (GREEN|AMBER|RED|모름)/);
  assert.match(render(), /href="\?judge=1"/);
  assert.match(render({ judge: true }), /카단 판정 AMBER \(cpu\)/);
  assert.match(render({ judge: true }), /href="\?"/);
});

test('판정과 숫자는 같은 표본이다 — 한 화면에서 다른 값을 말하지 않는다(card-35r)(card-60)', () => {
  for (const [memory, freePercent, load5, level, signals] of [['normal',80,0,'GREEN',''], ['warning',25,13,'AMBER',' (memory, cpu)'], ['critical',15,0,'RED',' (memory)']]) {
    const html = render({ resources: sample({ memory, freePercent, load5 }), judge: true });
    assert.ok(html.includes(`${freePercent}% (${memory})`));
    assert.ok(html.includes(`${load5.toFixed(2)}/12`));
    assert.ok(html.includes(`카단 판정 ${level}${signals}`));
  }
});

test('자원 실패와 필드 모름은 0이 아니다(card-35r)(card-60)', () => {
  const html = render({ resources: null, resourceError: '<failed>&', judge: true });
  assert.match(html, /자원 모름 \(&lt;failed&gt;&amp;\)/);
  assert.match(html, /카단 판정 모름/);
  const unknown = render({ resources: { current: { memory: 'unknown', freePercent: null, swapUsed: null, load5: null }, ncpu: null }, judge: true });
  assert.match(unknown, /메모리 여유 모름 \(모름\) · 스왑 모름 · CPU 5분 모름\/모름/);
  assert.match(unknown, /카단 판정 AMBER \(memory\)/);
  assert.doesNotMatch(unknown, /0\.00|unknown/);
});

test('전체 판 토글을 보존하고 원장 실패와 자원은 독립이다(card-60)', () => {
  assert.match(render({ all: true }), /href="\?judge=1&amp;all=1"/);
  const html = render({ all: true, judge: true, ledgerLines: null, error: 'EISDIR' });
  assert.match(html, /href="\?all=1"/);
  assert.match(html, /살아있는 역할 모름 · 도는 판 모름 · 안 끝난 카드 모름 · 발령 전 모름/);
  assert.match(html, /자원 · 메모리 여유 44%/);
});

test('표본 수집은 한 번이고 예외는 오류와 null로 남는다(card-60)', () => {
  let calls = 0;
  const resources = sample();
  assert.equal(typeof wall.buildWallSnapshot, 'function');
  const data = wall.buildWallSnapshot({ collect: () => { calls++; return resources; } });
  assert.equal(calls, 1);
  assert.equal(data.resources, resources);
  assert.equal(data.resourceError, null);
  assert.deepEqual(wall.buildWallSnapshot({ collect: () => { throw Error('broken'); } }), { resources: null, resourceError: 'broken' });
});

test('HTTP judge=1만 판정을 켜고 같은 수집 표본을 재사용한다(card-60)', async () => {
  let calls = 0;
  const server = wall.createWallServer(() => { calls++; return snapshot(); });
  const ready = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await ready;
  try {
    for (const [query, on] of [['',false], ['?judge=0',false], ['?judge=1&all=1',true]]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/${query}`, { signal: AbortSignal.timeout(5000) });
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.equal(/카단 판정 AMBER/.test(html), on);
      if (on) assert.match(html, /href="\?all=1"/);
    }
    assert.equal(calls, 1);
  } finally {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
});
