import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {CardStore} from '../src/card-store.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {DecisionStore} from '../src/decisions.mjs';
import {appendLedger, readMailLedger, readMailBody} from '../src/ledger.mjs';
import {Mailbox} from '../src/mailbox.mjs';

test('11/16 사례: done 업무 원문 등록 → show → 사람 메모 → 슈퍼 통지·꺼진 원 감독 보관',
  {skip: spawnSync('tmux', ['-L', `body-version-${process.pid}`, '-V']).status !== 0}, t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-body-roundtrip-'));
    const superRole = 'body-qa-슈퍼감독', original = 'body-qa-원감독';
    new CardStore(home).create({repo: 'qa', id: 'a', repoPath: home, body: '# 시험'});
    const works = new WorkStore(home);
    works.create({key: 'qa/done', title: '끝난 업무', goal: '목표', scope: '범위', acceptance: '조건',
      owner: original, repoPath: home});
    works.change('qa/done', 'complete', {result: '완료 근거'}, {revision: 1, by: '사람', note: '완료'});
    appendLedger({kind: 'stop', role: original, session: `kadan-${original}`}, home);
    const file = path.join(home, 'original.md');
    const text = '\uFEFFA1 첫 정책\r\nB3 두 번째 정책: 1번 현행 / 2번 변경\r\n';
    fs.writeFileSync(file, text);
    const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
    const env = {...process.env, KADAN_HOME: home, KADAN_SOCKET: path.basename(home),
      KADAN_WINDOW: 'none', KADAN_FLOOR: 'tmux', KADAN_NOTIFY: 'off'};
    const run = (args, by = '사람') => {
      const result = spawnSync(process.execPath, [cli, ...args],
        {env: {...env, KADAN_ROLE: by}, encoding: 'utf8'});
      assert.equal(result.status, 0, result.stderr + result.stdout);
      return result.stdout;
    };
    try {
      run(['start', superRole, '--cmd', 'stty -echo; exec cat']);
      const d = JSON.parse(run(['decision', 'request', '--chat', '--work', 'qa/done',
        '--question', '여러 정책을 어떻게 정할까요?', '--body-file', file, '--reply-to', original,
        '--option', '전부 추천대로', '--option', '메모대로', '--option', '보류', '--recommend', '전부 추천대로'], superRole));
      assert.equal(JSON.parse(run(['decision', 'list']))[0].id, d.id);
      assert.equal(JSON.parse(run(['decision', 'show', d.id])).bodyText, text);
      const saved = JSON.parse(run(['decision', 'answer', d.id, '--revision', '1',
        '--choice', '전부 추천대로', '--text', '전부 추천대로, B3만 2번']));
      assert.deepEqual(saved.delivery, {status: 'sent', role: superRole});
      assert.deepEqual(saved.replyDelivery, {status: 'stored', role: original});
      const mail = readMailLedger(home).filter(e => e.kind === 'send');
      assert.equal(mail.length, 2);
      const bodies = mail.map(e => ({role: e.role, transport: e.transport,
        body: readMailBody(e.digest, home)}));
      for (const row of bodies) assert.match(row.body, /전부 추천대로, B3만 2번/);
      assert.match(bodies.find(row => row.role === original).body, /원 질문: 여러 정책을 어떻게 정할까요\?/);
      assert.equal(new Mailbox(home, original).list({all: true}).length, 1);
      assert.match(run(['read', superRole, '--lines', '40']), /결정 답변/);
      run(['decision', 'answer', d.id, '--revision', '1', '--choice', '전부 추천대로', '--text', '전부 추천대로, B3만 2번']);
      assert.equal(readMailLedger(home).filter(e => e.kind === 'send').length, 2);
      if (process.env.KADAN_BODY_EVIDENCE_DIR) fs.writeFileSync(
        path.join(process.env.KADAN_BODY_EVIDENCE_DIR, 'roundtrip-bodies.json'),
        JSON.stringify({decision: saved, bodies}, null, 2) + '\n');
    } finally {
      run(['stop', superRole]);
      t.diagnostic(`isolated tmux socket=${env.KADAN_SOCKET}; test role stopped`);
    }
  });
