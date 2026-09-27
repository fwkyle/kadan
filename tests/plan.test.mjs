import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as cli from '../src/cli.mjs';
const t = '2026-09-05T00:00:00.000Z';
const now = Date.parse(t) + 32 * 60_000;
const states = new Map([['kadan-p-감독', {alive:true, digest:'same', unchangedMs:32*60_000}]]);
const send = {kind:'send', role:'p-작업자', taskId:'card-a', t};
const done = {...send, kind:'done', result:'ok'};
const plan = taskId => ({kind:'plan', board:'p', taskId, t, by:'사람'});
test('plan 없는 원장은 send−done 유휴 계산을 유지한다 — 기준선(card-53)', () => {
  assert.equal(cli.assessSupervisorIdle([send], states, now, 60_000)[0].openCards, 1);
  assert.deepEqual(cli.assessSupervisorIdle([send, done], states, now, 60_000), []);
  assert.deepEqual(cli.assessSupervisorIdle([done, send], states, now, 60_000), []);
});
test('발령 전 TODO도 감독 유휴 카드로 센다 — 첫 카드 완료 뒤 다음 발령을 잊었다(2026-09-05)(card-53)', () => {
  const entries = [plan('card-a'), plan('card-b'), plan('card-b'), send, done];
  const alerts = cli.assessSupervisorIdle(entries, states, now, 60_000);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].openCards, 1);
  assert.equal(alerts[0].session, 'kadan-p-감독');
  for (const entries of [[done, plan('card-a')], [done, plan('card-a'), send]]) {
    assert.deepEqual(cli.assessSupervisorIdle(entries, states, now, 60_000), []);
  }
  const recent = {...send, t:new Date(now-1000).toISOString()};
  assert.equal(cli.assessSupervisorIdle([plan('card-a'), recent], states, now, 60_000).length, 1);
});
test('kadan plan은 인자 전부 선검증 뒤 1줄씩 append한다(card-53)', () => {
  for (const env of [{}, {KADAN_ROLE:'p-감독'}]) {
    const records=[];
    cli.planCards({board:'p', taskIds:['a','b'], env, record:e=>records.push(e)});
    assert.deepEqual(records, ['a','b'].map(taskId=>({kind:'plan',board:'p',taskId,by:env.KADAN_ROLE??'사람'})));
  }
  for (const [board,taskIds] of [['p',['a','a']],['p',['a','b c']],['p',['a','']],['p',[]],['p',null],['p',[3]],['', ['a']],['p q',['a']],[null,['a']]]) {
    const records=[];
    assert.throws(()=>cli.planCards({board,taskIds,record:e=>records.push(e)}), e=>e.exitCode===2);
    assert.deepEqual(records, []);
  }
});
test('tree·wall은 plan 줄을 발령 전 카드로 보여준다 — 원장에 있어도 화면에 없었다(card-53)', () => {
  const tree=cli.buildTree([plan('card-a'),plan('card-b'),plan('card-b'),send]);
  assert.equal(tree[0].name,'p');
  assert.deepEqual(tree[0].plannedCards.map(c=>c.taskId),['card-b']);
  assert.deepEqual(tree[0].roles[0].cards.map(c=>c.taskId),['card-a']);
  assert.ok(cli.renderTree(tree).includes('card-b'));
  for (const entries of [[done,plan('card-a')],[send,plan('card-a')]]) {
    assert.deepEqual(cli.buildTree(entries)[0].plannedCards,[]);
  }
  const only=cli.buildTree([plan('card-b')]);
  assert.equal(only[0].roles.length,0);
  assert.equal(only[0].plannedCards.length,1);
});
test('wall도 발령 전 카드를 보여준다(card-53)', () => {
  const snapshot=entries=>({tree:cli.buildTree(entries),collectedAt:t,ledgerPath:'/qa',ledgerLines:entries.length,all:true});
  const html=cli.renderWallHtml(snapshot([plan('card-a'),plan('card-b'),send]));
  assert.ok(html.includes('발령 전'));
  assert.ok(html.includes('card-b'));
  const noPlanHtml=cli.renderWallHtml(snapshot([send]));
  assert.ok(!noPlanHtml.includes('<p>발령 전'));
  assert.match(noPlanHtml, /<p class="summary">[^<]*발령 전 0장<\/p>/);
  assert.ok(cli.renderWallHtml(snapshot([plan('<b>')])).includes('&lt;b&gt;'));
});
