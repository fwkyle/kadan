import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WorkStore} from '../src/work-store.mjs';
import {CardStore} from '../src/card-store.mjs';
import {createDatabase, writeStorageMarker, appendStream} from '../src/storage.mjs';
import {operationsFlowSummaries} from '../src/operations-flow.mjs';
import {createDashboardStoreReader} from '../src/dashboard-store-reader.mjs';

// 자동 왕복 종결 뒤 담당 감독의 첫 갱신 시각은 종결 시각·현재 담당에 따라 달라 사실로 들 수 없다.
// 읽기 snapshot 안에서 그 업무 이력만 흘려 읽은 값이, 이력을 든 옛 경로와 같은지 본다.
test('종결 뒤 첫 갱신 시간은 이력을 든 업무와 사실만 든 업무에서 같다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-supervisor-followup-'));
  createDatabase(home);writeStorageMarker(home, 'sqlite');
  const works = new WorkStore(home), cards = new CardStore(home), key = 'test/work';
  works.create({key, title: '후속', goal: '목표', scope: '범위', acceptance: '조건', owner: '감독', repoPath: home});
  works.change(key, 'execute', {title: 'review', body: '본문', phase: 'review', round: 1},
    {revision: works.get(key).revision, by: '감독', note: '실행'});
  const link = works.get(key).executions.at(-1);
  cards.update(link.key, {status: 'assigned', role: 'review', scope: '시험', board: 'test', rallyId: 'work', rallyTitle: '시험', rallyRound: '1', rallyStep: 'review'}, {revision: cards.get(link.key).revision, by: '감독', note: '배정'});
  const terminal = new Date(Date.now() - 60_000).toISOString();
  appendStream(home, `automatic-review/${key}/events.jsonl`,
    {key, revision: 1, links: works.get(key).executions, current: {key: link.key}, status: 'exception', at: terminal, notification: {status: 'sent'}});
  // 종결 전 갱신(후보 아님), 다른 사람의 갱신(후보 아님), 종결 뒤 담당 감독의 갱신(정답)
  const change = (by, note) => works.change(key, 'update', {progress: note}, {revision: works.get(key).revision, by, note});
  change('감독', '종결 전');
  const before = works.get(key).history.length;
  change('다른사람', '종결 뒤 남의 갱신');
  change('감독', '종결 뒤 감독 갱신');
  assert.ok(works.get(key).history.length > before);

  const withHistory = operationsFlowSummaries(home, [works.get(key)]).get(key).timing;
  const lean = createDashboardStoreReader(home, 'works', {facts: true}).read();
  assert.equal(lean[0].history, undefined);
  const leanTiming = operationsFlowSummaries(home, lean).get(key).timing;
  // elapsedMs는 호출 시각에 따라 달라 비교에서 뺀다. 나머지와 종결 뒤 첫 갱신 시간은 같아야 한다.
  assert.deepEqual({...leanTiming, elapsedMs: 0}, {...withHistory, elapsedMs: 0});
  // 이 시험이 의미가 있으려면 값이 실제로 계산돼야 한다(종결 시각 → 감독의 종결 뒤 첫 갱신)
  assert.ok(withHistory.supervisorFollowupMs > 0 && withHistory.supervisorFollowupMs < 120_000, String(withHistory.supervisorFollowupMs));
});
