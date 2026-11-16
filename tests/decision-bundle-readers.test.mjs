import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {DecisionStore, decisionCommand} from '../src/decisions.mjs';
import {CardStore} from '../src/card-store.mjs';
import {readStream, appendStream, transaction} from '../src/storage.mjs';
import {verifyStorage} from '../src/storage-migration.mjs';
import {storageObservation} from '../src/storage-observation.mjs';
import {readDecisionDetail} from '../src/decision-detail.mjs';
import {createWallServer} from '../src/wall.mjs';
import {decisionsData} from '../src/dashboard/settings.mjs';
import {buildKanban, isMergeRequest} from '../src/dashboard-kanban.mjs';
import {repoOfDecision, answeredMergesToday, sidebarRepos} from '../src/dashboard/repo-view.mjs';
import {frontStrip} from '../src/dashboard/front.mjs';
import {prHeadOf, mergeLineInfo} from '../src/dashboard/autopilot-view.mjs';
import {summarizeAutopilot} from '../src/autopilot-summary.mjs';
import {openDecisionContext} from '../src/watch-waits.mjs';
import {runProceedNotices} from '../src/watch-proceed-notice.mjs';
import {renderDecisions} from '../src/decision-wall.mjs';
import {renderDashboardStatus} from '../src/dashboard-status.mjs';
import {renderDashboardHome} from '../src/dashboard-home.mjs';
import {workFollowup} from '../src/work-followup.mjs';
import {decisionsByCard} from '../src/explain-input.mjs';
import {bundleRow, bodyRow, partialRow, fullRow, submission, bundleHome, at} from './helpers/decision-bundle.mjs';

const url = new URL('http://127.0.0.1/api/dashboard/decisions');
function mixedHome() {
  const {home, row} = bundleHome();
  new CardStore(home).create({repo: 'repo', id: 'card-a', repoPath: home, body: '# 시험'});
  const store = new DecisionStore(home, {notify: () => {}});
  const single = store.request('repo/card-a', {question: '단일 결정을 읽을까요?', options: ['예', '아니오'],
    recommendation: '예', reason: '확인 경로 없음: 시험', work: '없음'}, 'test-슈퍼감독');
  return {home, row, single, store};
}

test('같은 홈의 단일 결정은 묶음이 있어도 CLI list/show와 목록 API에서 그대로다', () => {
  const {home, row, single, store} = mixedHome();
  const list = decisionCommand(['list'], {}, {home, by: '사람'});
  assert.equal(list.length, 2);
  assert.deepEqual(decisionCommand(['show', single.id], {}, {home, by: '사람'}), single);
  const cli = spawnSync(process.execPath, ['src/cli.mjs', 'decision', 'show', single.id],
    {env: {...process.env, KADAN_HOME: home}, encoding: 'utf8'});
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), single);
  const api = decisionsData({decisions: store.list()}, url, {});
  assert.equal(api.items.length, 2);
  assert.equal(api.items.find(d => d.id === row.id).bundle, true);
  assert.equal(api.items.find(d => d.id === single.id).recommendation, single.recommendation);
  assert.deepEqual([...decisionsByCard(list).keys()], ['repo/card-a']);
});

test('상세의 목록과 본문·답 읽기는 DB 읽기 트랜잭션 하나다', () => {
  const {home, row} = bundleHome();
  const before = storageObservation(home);
  readDecisionDetail(home, row.id);
  const after = storageObservation(home);
  assert.equal(after.read.count - before.read.count, 1);
  assert.equal(after.write.count, before.write.count);
});

test('단일과 묶음의 모든 고정 상태가 한 홈에 공존해 CLI·목록 API·칸반·저장 검증을 통과한다', () => {
  const {home, store, single} = mixedHome();
  const bundles = [];
  for (const work of [undefined, 'repo/work-a']) for (const phase of ['new', 'partial', 'full', 'cancel']) {
    const first = bundleRow(work ? {work} : {}), partial = partialRow(first);
    const history = [first], detail = [bodyRow(first)];
    if (phase !== 'new') {history.push(partial); detail.push(submission());}
    if (phase === 'full') {
      history.push(fullRow(first));
      detail.push(submission(3, {A2: {choice: null, note: '자료 필요'}}));
    }
    if (phase === 'cancel') history.push({...partial, revision: 3, status: 'cancelled', cancelReason: '취소'});
    transaction(home, () => {
      for (const row of history) appendStream(home, 'decisions/events.jsonl', row);
      for (const row of detail) appendStream(home, `decisions/${first.id}/detail.jsonl`, row);
    });
    bundles.push(history.at(-1));
  }
  const all = store.list();
  const cli = spawnSync(process.execPath, ['src/cli.mjs', 'decision', 'list'],
    {env: {...process.env, KADAN_HOME: home}, encoding: 'utf8'});
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), all);
  assert.deepEqual(store.get(single.id), single);
  const open = decisionsData({decisions: all}, url, {});
  const past = decisionsData({decisions: all}, new URL(url + '?past=1'), {});
  assert.deepEqual(new Set([...open.items, ...past.items].map(d => d.id)), new Set(all.map(d => d.id)));
  assert.equal(JSON.stringify([open, past]).includes('audit@example.invalid'), false);
  const board = buildKanban({decisions: all, rows: [], group: 'project'});
  const ids = new Set(board.boards.flatMap(b => b.lines.flatMap(l => l.cards.flatMap(c => c.decisionIds))));
  for (const d of bundles) {
    assert.equal(repoOfDecision(d), 'repo');
    assert.equal(ids.has(d.id), d.status === 'open');
    assert.equal(readDecisionDetail(home, d.id).status, d.status);
  }
  assert.equal(verifyStorage(home).integrity, 'ok');
});

test('묶음은 repo로 분류되고 업무 없는 두 결정도 별도 칸반 줄에 보이며 PR로 오해하지 않는다', () => {
  const a = bundleRow({question: 'https://github.com/example/repo/pull/123 head: aabbccdd 정책'});
  const b = bundleRow({repo: 'other'});
  const data = buildKanban({rows: [], decisions: [a, b], group: 'project'});
  assert.deepEqual(data.boards.map(board => board.label), ['other', 'repo']);
  const cards = data.boards.flatMap(board => board.lines.flatMap(line => line.cards));
  assert.deepEqual(new Set(cards.map(card => card.key)), new Set([`decision:${a.id}`, `decision:${b.id}`]));
  assert.equal(cards.find(card => card.key === `decision:${a.id}`).title, a.question);
  assert.equal(repoOfDecision(a), 'repo');
  assert.equal(isMergeRequest(a), false);
  assert.equal(prHeadOf(a), null);
  assert.deepEqual(mergeLineInfo({}, a, {byCard: new Map(), byKey: new Map()}).prs, []);
  const strip = frontStrip({decisions: [a], stoppedRows: []});
  assert.equal(strip.decisions[0].itemCount, 2);
  assert.equal(strip.decisions[0].answeredCount, 0);
  assert.equal(strip.repos[0].repo, 'repo');
  assert.equal(sidebarRepos({rows: [], decisions: [a], supervisors: null})[0].merges, 0);
  assert.deepEqual(answeredMergesToday([{...fullRow(a), at}], 'repo', Date.parse(at)), []);
});

test('부분 답은 요약의 해결 건수에 들지 않고 전부 답했을 때 한 건만 센다', () => {
  const first = bundleRow({reason: 'https://github.com/example/repo/pull/123'});
  const summarize = decisionEvents => summarizeAutopilot({start: {t: at, text: '시험'},
    phase: 'off', endedAt: Date.parse(at) + 1000, entries: [], decisionEvents, readBody: () => ''});
  assert.equal(summarize([first, partialRow(first)]).counts.answered, 0);
  const full = fullRow(first);
  const result = summarize([first, partialRow(first), full, full]);
  assert.equal(result.counts.answered, 1);
  assert.equal(result.counts.mergeAnswered, 0);
});

test('감시 AI는 묶음의 답 수와 미답 key를 보고 진행자격 안내는 보내지 않는다', () => {
  const row = partialRow(bundleRow({work: 'repo/work-a'}));
  const [context] = openDecisionContext([row], row.requestedBy);
  assert.equal(context.progress, '답 1/2');
  assert.deepEqual(context.unansweredKeys, ['A2']);
  assert.equal(Object.hasOwn(context, 'recommendation'), false);
  let sent = 0;
  runProceedNotices({proceedable: [row], ap: {startedAt: at}, parents: new Map([[row.requestedBy, '@user']]),
    liveSessions: new Set([`kadan-${row.requestedBy}`]), entries: [], state: {},
    send: () => sent++, record: () => {}, clock: '00:00'});
  assert.equal(sent, 0);
  const follow = workFollowup({key: row.work, status: 'open', executions: []}, [], {decisions: [row]});
  assert.match(JSON.stringify(follow), /결정/);
});

test('옛 결정 벽·현황은 질문·답 수·링크만 보이고 묶음 답 양식·가짜 추천을 만들지 않는다', () => {
  const row = partialRow(bundleRow());
  const html = renderDecisions([row], null, 'token');
  assert.match(html, /항목 2개 · 답 1개/);
  assert.doesNotMatch(html, /action="\/decisions\/answer"|선택지 없이 메모|추천 이유|카드 null/);
  const status = renderDashboardStatus({center: null, works: [], decisions: [row]});
  assert.match(status, /항목 2개 · 답 1개/);
  assert.doesNotMatch(status, /추천 undefined/);
  const home = renderDashboardHome({center: {boards: [], cards: []}, decisions: [row]});
  assert.match(home, /항목 2개 · 답 1개/);
  assert.doesNotMatch(home, /추천:/);
});

test('실제 루프백 목록 API·웹 단일 답 거절과 서버 종료', async t => {
  const first = bundleRow(), {home} = bundleHome({row: first,
    history: [first, partialRow(first)], detail: [bodyRow(first), submission()]});
  const server = createWallServer(() => ({center: null, entries: [], tree: [], ledgerLines: 0,
    collectedAt: new Date()}), {home, notify: () => {throw new Error('묶음 통지 금지');}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  try {
    const response = await fetch(base + '/api/dashboard/decisions');
    assert.equal(response.status, 200);
    const api = await response.json();
    assert.equal(api.items[0].bundle, true);
    assert.equal(JSON.stringify(api).includes('audit@example.invalid'), false);
    const {token} = await (await fetch(base + '/api/dashboard/session')).json();
    const post = await fetch(base + '/decisions/answer', {method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded', origin: base},
      body: new URLSearchParams({token, id: first.id, revision: '2', text: '전체 승인'})});
    assert.equal(post.status, 409);
    assert.match(await post.text(), /항목별 답/);
    assert.equal(readStream(home, 'decisions/events.jsonl').length, 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (process.platform === 'darwin') {
      const check = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {encoding: 'utf8'});
      assert.equal(check.stdout.trim(), '', check.stdout);
    }
    t.diagnostic(`server PID=${process.pid} port=${port} 127.0.0.1 stopped; lsof empty`);
  }
});
