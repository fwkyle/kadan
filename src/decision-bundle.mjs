// 묶음 목록은 작은 전체 상태만 저장한다. 본문과 메모는 단건 상세에서만 읽는다.
import {isSupervisorActor} from './actors.mjs';

export const ITEM_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/;
// CardStore의 slug·WorkStore의 keyStream과 같은 이름 규칙이다.
const name = value => typeof value === 'string' && /^[\p{L}\p{N}_-]+$/u.test(value);
const workKey = value => typeof value === 'string' && value.split('/').length === 2
  && value.split('/').every(name);
export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = new Set(['id', 'revision', 'bundle', 'card', 'repo', 'work', 'context', 'to',
  'requestedBy', 'replyTo', 'question', 'reason', 'options', 'itemKeys', 'answered', 'status',
  'at', 'answer', 'cancelReason', 'cancelledAt', 'cancelledBy']);

export function assertBundleRow(row, old) {
  const valid = row.bundle === true && Object.keys(row).every(key => fields.has(key))
    && name(row.id) && row.card === null && name(row.repo)
    && row.to === '@user' && name(row.requestedBy) && isSupervisorActor(row.requestedBy)
    && name(row.replyTo) && typeof row.at === 'string' && Number.isFinite(Date.parse(row.at))
    && typeof row.question === 'string' && row.question.trim() && row.question.length <= 300
    && typeof row.reason === 'string' && row.reason.length <= 1000
    && Array.isArray(row.options) && row.options.length === 0
    && Array.isArray(row.itemKeys) && row.itemKeys.length >= 1 && row.itemKeys.length <= 20
    && row.itemKeys.every(key => typeof key === 'string' && ITEM_KEY.test(key))
    && new Set(row.itemKeys).size === row.itemKeys.length
    && record(row.answered) && Object.entries(row.answered).every(([key, choice]) =>
      row.itemKeys.includes(key) && typeof choice === 'string' && (choice === '@memo' || ITEM_KEY.test(choice)))
    && (!Object.hasOwn(row, 'work') || workKey(row.work))
    && (!Object.hasOwn(row, 'context') || (record(row.context)
      && Object.keys(row.context).every(key => key === 'work') && workKey(row.context.work)))
    && ['open', 'answered', 'cancelled'].includes(row.status)
    && Number.isInteger(row.revision) && row.revision === (old?.revision ?? 0) + 1
    && (old === undefined || old.bundle === true)
    && (row.status !== 'answered' || (Object.keys(row.answered).length === row.itemKeys.length
      && record(row.answer) && typeof row.answer.text === 'string' && row.answer.text.trim()
      && typeof row.answer.at === 'string' && Number.isFinite(Date.parse(row.answer.at))
      && typeof row.answer.by === 'string' && row.answer.by.trim()))
    && (row.status !== 'open' || Object.keys(row.answered).length < row.itemKeys.length)
    && (row.status === 'answered' || !Object.hasOwn(row, 'answer'))
    && (row.status !== 'cancelled' || (typeof row.cancelReason === 'string' && row.cancelReason.trim()))
    && ['cancelReason', 'cancelledAt', 'cancelledBy'].every(key =>
      !Object.hasOwn(row, key) || typeof row[key] === 'string')
    && Buffer.byteLength(JSON.stringify(row), 'utf8') <= 8192;
  if (!valid) throw new Error('결정 이력 손상');
}

export const bundleProgress = d => `항목 ${d.itemKeys.length}개 · 답 ${Object.keys(d.answered).length}개`;
export const unansweredKeys = d => d.itemKeys.filter(key => !Object.hasOwn(d.answered, key));
