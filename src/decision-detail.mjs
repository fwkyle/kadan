// 단건 상세는 목록과 결정별 기록을 같은 읽기 스냅샷에서 대조한다.
// 전달만 추가돼도 다시 읽는다. 목록 revision으로 상세를 재사용하지 않는다.
import {createHash} from 'node:crypto';
import {storageSnapshot, readStream} from './storage.mjs';
import {latestDecisions, withoutAuditFields} from './decisions.mjs';
import {ITEM_KEY, record, unansweredKeys} from './decision-bundle.mjs';

const corrupt = () => { throw new Error('결정 상세 이력 손상'); };
const ensure = condition => { if (!condition) corrupt(); };
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const keysEqual = (a, b) => a.length === b.length && a.every((key, i) => key === b[i]);
const equalAnswers = (a, b) => Object.keys(a).length === Object.keys(b).length
  && Object.keys(a).every(key => Object.hasOwn(b, key) && a[key] === b[key]);
const recipients = d => [...new Set([d.replyTo, d.requestedBy])];

function validateBody(body, d) {
  ensure(body.id === d.id && typeof body.at === 'string'
    && Buffer.byteLength(JSON.stringify(body)) <= 256 * 1024);
  ensure(Array.isArray(body.items) && body.items.length === d.itemKeys.length
    && keysEqual(body.items.map(item => item?.key), d.itemKeys));
  for (const item of body.items) {
    ensure(record(item) && text(item.title, 120) && typeof item.asIs === 'string'
      && typeof item.reason === 'string' && typeof item.impact === 'string'
      && text(item.verification, Infinity));
    ensure(Array.isArray(item.options) && item.options.length >= 2 && item.options.length <= 4);
    const choices = item.options.map(option => option?.key);
    ensure(new Set(choices).size === choices.length && choices.every(key =>
      typeof key === 'string' && ITEM_KEY.test(key)) && choices.includes(item.recommended));
    for (const option of item.options) ensure(record(option)
      && text(option.label, 200) && typeof option.detail === 'string');
  }
  if (body.summary !== undefined) ensure(typeof body.summary === 'string');
  if (body.source !== undefined) {
    ensure(record(body.source));
    if (Object.hasOwn(body.source, 'text')) {
      ensure(typeof body.source.text === 'string' && Buffer.byteLength(body.source.text) <= 128 * 1024);
      ensure(body.source.sha256 === createHash('sha256').update(body.source.text, 'utf8').digest('hex'));
    }
  }
}

function submissionsOf(history, body) {
  const submissions = new Map();
  const fixed = ['id', 'bundle', 'card', 'repo', 'work', 'context', 'to', 'requestedBy',
    'replyTo', 'question', 'reason', 'options', 'itemKeys', 'at'];
  for (let index = 0; index < history.length; index++) {
    const row = history[index], old = history[index - 1];
    ensure(row.bundle === true);
    if (!old) {
      ensure(row.status === 'open' && Object.keys(row.answered).length === 0);
      continue;
    }
    ensure(old.status === 'open' && fixed.every(key => JSON.stringify(row[key]) === JSON.stringify(old[key])));
    ensure(Object.keys(old.answered).every(key => row.answered[key] === old.answered[key]));
    const added = Object.keys(row.answered).filter(key => !Object.hasOwn(old.answered, key));
    if (row.status === 'cancelled') {
      ensure(added.length === 0);
      continue;
    }
    ensure(added.length > 0);
    for (const key of added) {
      const choice = row.answered[key], item = body.items.find(item => item.key === key);
      ensure(choice === '@memo' || item.options.some(option => option.key === choice));
    }
    submissions.set(row.revision, {row, added});
  }
  return submissions;
}

export function foldDecisionDetail(history, rows) {
  const d = history.at(-1);
  ensure(d?.bundle === true && rows.every(row => record(row)
    && ['body', 'answers', 'delivery'].includes(row.type)));
  const bodies = rows.filter(row => row.type === 'body');
  ensure(bodies.length === 1 && rows[0] === bodies[0]);
  const body = bodies[0];
  validateBody(body, d);
  const expected = submissionsOf(history, body), answers = new Map(), deliveries = new Map();
  const accumulated = {};
  for (const row of rows.slice(1)) {
    ensure(Number.isInteger(row.revision) && expected.has(row.revision) && typeof row.at === 'string');
    if (row.type === 'answers') {
      const {added, row: listed} = expected.get(row.revision);
      ensure(!answers.has(row.revision) && record(row.answers)
        && text(row.by, Infinity) && Object.keys(row.answers).length === added.length);
      // 제출 순서가 뒤집혔거나, 같은 항목의 답이 다시 나오면 손상이다.
      ensure(answers.size === 0 || row.revision > Math.max(...answers.keys()));
      for (const [key, value] of Object.entries(row.answers)) {
        ensure(added.includes(key) && !Object.hasOwn(accumulated, key) && record(value)
          && Object.keys(value).every(field => ['choice', 'note'].includes(field))
          && (value.choice === null || (typeof value.choice === 'string' && ITEM_KEY.test(value.choice)))
          && typeof value.note === 'string' && value.note.length <= 500);
        const choice = value.choice === null ? '@memo' : value.choice;
        ensure(choice === listed.answered[key] && (choice !== '@memo' || value.note.trim().length > 0));
        accumulated[key] = choice;
      }
      answers.set(row.revision, row);
    } else {
      ensure(answers.has(row.revision) && recipients(d).includes(row.to)
        && ['sent', 'stored', 'failed', 'unknown'].includes(row.status));
      const key = `${row.revision}:${row.to}`;
      ensure(!deliveries.has(key));
      deliveries.set(key, row);
    }
  }
  ensure(answers.size === expected.size && equalAnswers(accumulated, d.answered));
  if (d.status === 'answered') {
    const last = [...answers.values()].at(-1);
    ensure(d.answer.at === last.at && d.answer.by === last.by);
  }
  // 감사 필드는 저장 기록에만 둔다. 답은 상세 모양을 허용한 두 필드로 다시 만든다.
  const safeAnswers = [...answers.values()].map(({remote, ...submission}) => ({
    type: submission.type, revision: submission.revision, at: submission.at, by: submission.by,
    answers: Object.fromEntries(Object.entries(submission.answers).map(([key, value]) =>
      [key, {choice: value.choice, note: value.note}])),
  }));
  const delivery = safeAnswers.flatMap(submission => recipients(d).map(to => {
    const found = deliveries.get(`${submission.revision}:${to}`);
    return found ? {type: 'delivery', revision: found.revision, to, status: found.status,
      at: found.at, ...(found.mailId ? {mailId: found.mailId} : {})}
      : {type: 'delivery', revision: submission.revision, to, status: 'unknown'};
  }));
  return {...withoutAuditFields(d), body, answers: safeAnswers, delivery, unansweredKeys: unansweredKeys(d)};
}

export function readDecisionDetail(home, id) {
  return storageSnapshot(home, () => {
    const rows = readStream(home, 'decisions/events.jsonl', {optional: true});
    const d = latestDecisions(rows).find(row => row.id === id);
    if (!d) throw new Error('결정 요청 없음');
    if (d.bundle !== true) throw new Error('여러 항목 결정만 상세 기록을 읽습니다');
    const history = rows.filter(row => row.id === id);
    const detail = readStream(home, `decisions/${id}/detail.jsonl`, {optional: true});
    return foldDecisionDetail(history, detail);
  });
}
