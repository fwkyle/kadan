import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createDatabase, appendStream, transaction} from '../../src/storage.mjs';

export const at = '2026-11-16T00:00:00.000Z';
export function bundleRow(over = {}) {
  return {id: randomUUID(), revision: 1, bundle: true, card: null, repo: 'repo',
    to: '@user', requestedBy: 'test-슈퍼감독', replyTo: 'test-감독',
    question: '두 정책을 어떻게 정할까요?', reason: '확인 경로 없음: 시험', options: [],
    itemKeys: ['A1', 'A2'], answered: {}, status: 'open', at, ...over};
}
export const bodyRow = d => ({type: 'body', id: d.id, at, summary: '원문 요약',
  items: d.itemKeys.map(key => ({key, title: `정책 ${key}`, asIs: '현행',
    options: [{key: 'keep', label: '유지', detail: '유지합니다'},
      {key: 'change', label: '변경', detail: '바꿉니다'}],
    recommended: 'keep', reason: '안전', impact: '없음', verification: '확인 경로 없음: 시험'}))});
export const partialRow = d => ({...d, revision: 2, answered: {A1: 'keep'}});
export const fullRow = d => ({...d, revision: 3, answered: {A1: 'keep', A2: '@memo'},
  status: 'answered', answer: {text: '항목별 답 2/2', at, by: '사람'}});
export const submission = (revision = 2, answers = {A1: {choice: 'keep', note: ''}}) =>
  ({type: 'answers', revision, answers, at, by: '사람', remote: {email: 'audit@example.invalid', ip: '192.0.2.1'}});

export function bundleHome({history, detail, row = bundleRow()} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-bundle-'));
  createDatabase(home);
  history ??= [row];
  detail ??= [bodyRow(history[0])];
  transaction(home, () => {
    for (const value of history) appendStream(home, 'decisions/events.jsonl', value);
    for (const value of detail) appendStream(home, `decisions/${row.id}/detail.jsonl`, value);
  });
  return {home, row: history.at(-1)};
}
