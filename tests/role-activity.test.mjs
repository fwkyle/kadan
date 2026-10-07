import test from 'node:test';
import assert from 'node:assert/strict';
import {roleActivity} from '../src/dashboard-band.mjs';

test('담당별 최근 1시간 활동: 5분 칸 12개, 받은 쪽·한 쪽 모두, 감시기·사람·범위 밖·정기 기록은 뺀다', () => {
  const now = Date.parse('2026-10-07T10:00:00Z');
  const at = (minAgo) => new Date(now - minAgo * 60_000).toISOString();
  const entries = [
    {t:at(1), kind:'send', role:'작업자', by:'감독'},          // 마지막 칸: 작업자·감독 둘 다
    {t:at(3), kind:'done', role:'작업자', by:'작업자'},        // 같은 역할이면 한 번만
    {t:at(58), kind:'start', role:'검수자', by:'사람'},         // 첫 칸, 사람은 빼고
    {t:at(61), kind:'send', role:'작업자', by:'감독'},          // 1시간 밖
    {t:at(10), kind:'watch-cycle', role:'작업자', by:'watch'},  // 정기 기록
    {t:'깨진 시각', kind:'send', role:'작업자'},
  ];
  const out = roleActivity(entries, {now, skip:e => e.kind === 'watch-cycle'});
  assert.deepEqual(Object.keys(out).sort(), ['감독', '검수자', '작업자']);
  assert.equal(out['작업자'].length, 12);
  assert.equal(out['작업자'][11], 2);
  assert.equal(out['감독'][11], 1);
  assert.equal(out['검수자'][0], 1);
  assert.equal(out['작업자'].reduce((a, b) => a + b), 2, '범위 밖·정기 기록·깨진 시각은 세지 않는다');
  assert.deepEqual(roleActivity(null), {});
});
