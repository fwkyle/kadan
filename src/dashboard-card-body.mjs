// Why: 목록은 본문 지문·짧은 발췌만 보관하고 상세에서 선택한 원문을 읽는다.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {cardPurpose} from './dashboard-flow.mjs';
import {explainBody} from './explain-input.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

export function summarizeCardBody(card, body) {
  const purpose = cardPurpose({body});
  // 긴 원문의 slice가 원문 문자열을 계속 붙잡지 않도록 작은 값만 복사한다.
  return JSON.parse(JSON.stringify({
    digest:hash(body),
    sourceHash:hash(JSON.stringify([card.revision, body])),
    contentHash:hash(JSON.stringify([card.title, body])),
    explainBody:explainBody(body),
    purpose:{...purpose, text:purpose.text.slice(0, 220)},
  }));
}

export function hydrateCardBody(card) {
  if (!card?.bodySummary) return card;
  const {bodySummary, ...value} = card;
  const body = fs.readFileSync(card.path, 'utf8');
  if (hash(body) !== bodySummary.digest) {
    throw Object.assign(new Error('수집 뒤 카드 본문이 바뀌었습니다'), {code:'KADAN_BODY_CHANGED'});
  }
  return {...value, body};
}
