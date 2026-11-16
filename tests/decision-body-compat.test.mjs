import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {CardStore} from '../src/card-store.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {DecisionStore, decisionCommand} from '../src/decisions.mjs';
import {appendLedger} from '../src/ledger.mjs';

const root = process.env.KADAN_BODY_BASELINE_ROOT;
test('기준 커밋은 body/replyTo와 끝난 업무 chat 줄을 읽고 답하며 기존 출력은 동일하다',
  {skip: !root && '고정 기준 체크아웃은 로컬 호환 검증에서만 지정'}, async t => {
    const sha = () => spawnSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).stdout.trim();
    assert.equal(sha(), '0ba14c1a87351c2ba7367ebb25d3a89ba62be2b8');
    const before = spawnSync('git', ['status', '--porcelain'], {cwd: root, encoding: 'utf8'}).stdout;
    assert.equal(before, '');
    const old = await import(pathToFileURL(path.join(root, 'src/decisions.mjs')).href);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-body-compat-'));
    new CardStore(home).create({repo: 'repo', id: 'a', repoPath: home, body: '# 試験'});
    const works = new WorkStore(home);
    works.create({key: 'repo/done', title: '완료 업무', goal: '목표', scope: '범위',
      acceptance: '조건', owner: 'compat-감독', repoPath: home});
    works.change('repo/done', 'complete', {result: '완료 근거'}, {revision: 1, by: '사람', note: '완료'});
    const role = 'compat-원감독', by = 'compat-슈퍼감독';
    appendLedger({kind: 'stop', role, session: `kadan-${role}`}, home);
    const file = path.join(home, 'question.md'); fs.writeFileSync(file, '\uFEFFA1 질문\r\nB3 예외\r\n');
    const store = new DecisionStore(home, {notify: () => {}}), sent = [];
    const previous = new old.DecisionStore(home, {notify: (...args) => sent.push(args)});
    const common = {question: '카드의 원문 질문', options: ['예', '아니오'], recommendation: '예',
      reason: '확인 경로 없음: 시험', work: '없음', bodyFile: file, replyTo: role};
    const card = store.request('repo/a', common, by);
    const chat = store.request(null, {...common, question: '끝난 업무의 원문 질문',
      chat: true, work: 'repo/done'}, by);
    const cli = spawnSync(process.execPath, [path.join(root, 'src/cli.mjs'), 'decision', 'list'],
      {cwd: root, env: {...process.env, KADAN_HOME: home, KADAN_ROLE: '사람'}, encoding: 'utf8'});
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout), store.list());
    for (const d of [card, chat]) {
      assert.deepEqual(previous.get(d.id), d);
      assert.deepEqual(previous.list({dashboard: true}).find(row => row.id === d.id), d);
      const answered = previous.answer(d.id, {revision: 1, text: '기존 답', choice: '예'}, '사람');
      assert.equal(answered.status, 'answered');
      assert.deepEqual(answered.body, d.body);
      assert.equal(answered.replyTo, role);
      assert.equal(answered.replyDelivery, undefined, '옛 코드는 추가 통지를 하지 않아 먼저 재시작해야 한다');
    }
    assert.equal(sent.length, 2);
    const plain = store.request('repo/a', {...common, question: '옛 질문', bodyFile: undefined, replyTo: undefined}, by);
    const ctx = {home, by: '사람'};
    assert.deepEqual(decisionCommand(['show', plain.id], {}, ctx), old.decisionCommand(['show', plain.id], {}, ctx));
    store.answer(plain.id, {revision: 1, text: '변경 없는 답', choice: '예'}, '사람');
    assert.deepEqual(decisionCommand(['show', plain.id], {}, ctx), old.decisionCommand(['show', plain.id], {}, ctx));
    assert.deepEqual(decisionCommand(['list'], {}, ctx), old.decisionCommand(['list'], {}, ctx));
    assert.equal(sha(), '0ba14c1a87351c2ba7367ebb25d3a89ba62be2b8');
    assert.equal(spawnSync('git', ['status', '--porcelain'], {cwd: root, encoding: 'utf8'}).stdout, before);
    t.diagnostic(`baseline=${root} sha=${sha()} unchanged; old replyTo ignored as documented`);
  });
