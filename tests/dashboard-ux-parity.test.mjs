import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardFixture } from './helpers/dashboard-fixture.mjs';
import { dashboardData } from '../src/dashboard-api.mjs';

test('실행 기록은 상태·검색을 페이지 분할 전에 적용하고 기존 주소와 한국어 표시를 유지한다', () => {
  const f = dashboardFixture({count: 2}), snapshot = f.snapshot();
  const at = n => new Date(Date.UTC(2026, 8, 26, 0, n)).toISOString();
  snapshot.center.cards[0].runs = Array.from({length: 52}, (_, i) => ({state: 'failed', role: '작업자', at: at(i)}));
  snapshot.center.cards[1].runs = [{state: 'done', role: '검수자', at: at(53)}, {state: 'unconfirmed', role: '감독', at: at(54)}];
  snapshot.center.unregistered = [{state: 'orphaned', role: '미연결', taskId: '옛 실행', at: at(55)}];
  const get = query => dashboardData(snapshot, new URL('http://local/api/dashboard/runs?' + query));
  const all = get('');
  assert.equal(all.total, 55);
  assert.deepEqual(all.states.map(s => [s.value, s.count]), [['failed', 52], ['unconfirmed', 1], ['orphaned', 1], ['done', 1]]);
  assert.equal(all.items[0].stateLabel, '세션 없음·미완료');
  const first = get('runState=failed'), last = get('runState=failed&runPage=2');
  assert.equal(first.total, 52);
  assert.equal(first.pages, 2);
  assert.equal(first.items.length, 50);
  assert.equal(last.items.length, 2);
  assert.ok([...first.items, ...last.items].every(r => r.stateLabel === '실패 기록'));
  assert.equal(new Set([...first.items, ...last.items].map(r => r.at)).size, 52);
  assert.deepEqual(get('runState=failed&page=2').items, last.items);
  assert.equal(get('runState=done&runPage=2&page=2').page, 1);
  assert.equal(get('runState=done').items[0].stateLabel, '완료 기록');
  assert.equal(get('runState=unconfirmed').items[0].stateLabel, '완료 미확인');
  assert.equal(get('runState=failed&q=검수자').total, 0);
  assert.equal(get('q=실패 기록').total, 52);
  assert.equal(get('runState=constructor').total, 55);
});

test('우편의 옛 taskId·완료 통지·정식 주소를 연결하되 중복·충돌·없는 카드는 추측하지 않는다', () => {
  const f = dashboardFixture({count: 2}), snapshot = f.snapshot();
  snapshot.center.cards.push({...snapshot.center.cards.find(c => c.id === 'card-2'), repo:'other', key:'other/card-2'});
  snapshot.entries = [
    {mailId:'legacy', taskId:'card-1'},
    {mailId:'completion', completion:true, completionTaskId:'card-1'},
    {mailId:'modern', taskId:'card-2', executionKey:'demo/card-2'},
    {mailId:'ambiguous', taskId:'card-2'},
    {mailId:'conflict', taskId:'card-1', executionKey:'demo/card-2'},
    {mailId:'missing', executionKey:'demo/missing'},
  ].map((m, i) => ({kind:'send', t:'2026-09-26T00:00:00Z', by:'감독', role:'작업자', digest:m.mailId, expectReply:true, _ledgerOrder:i+1, ...m}));
  const original = JSON.stringify(snapshot.entries);
  const result = dashboardData(snapshot, new URL('http://local/api/dashboard/mail'));
  const byId = Object.fromEntries(result.items.map(m => [m.mailId, m]));
  assert.equal(byId.legacy.card.key, 'demo/card-1');
  assert.equal(byId.completion.card.key, 'demo/card-1');
  assert.equal(byId.modern.card.key, 'demo/card-2');
  for (const id of ['ambiguous', 'conflict', 'missing']) assert.equal(byId[id].card, null, id);
  assert.equal(byId.legacy.executionKey, null, '표시용 연결을 저장 원문으로 꾸미지 않는다');
  assert.match(byId.legacy.status, /읽음 미확인.*답변 대기/);
  const detail = dashboardData(snapshot, new URL('http://local/api/dashboard/detail?card=demo/card-1'));
  assert.ok(detail.mail.some(m => m.mailId === 'legacy' && m.card.key === 'demo/card-1'));
  assert.equal(JSON.stringify(snapshot.entries), original);
});
