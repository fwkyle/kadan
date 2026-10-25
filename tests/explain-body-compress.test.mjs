import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeCardBody} from '../src/dashboard-card-body.mjs';
import {explainBody, explainBodyFromSummary, compressExplainBody} from '../src/explain-input.mjs';

test('설명 입력 발췌는 압축해 들고 푼 값이 원래 발췌와 정확히 같다(잘린 서로게이트 쌍 포함)', () => {
  const bodies = ['', '일반 본문', 'a'.repeat(3999) + '🙂끝', '본문 '.repeat(3000), 'Bearer ' + 'x'.repeat(40) + '\0\n' + '한글 🙂 '.repeat(2000), '\ud83d' + '짧은 끝'];
  for (const body of bodies) {
    const summary = summarizeCardBody({key: 'demo/card', revision: 1, title: '제목'}, body);
    assert.equal(summary.explainBody, undefined, '평문 발췌는 들지 않는다');
    assert.ok(summary.explainZ instanceof Uint8Array);
    assert.equal(explainBodyFromSummary(summary), explainBody(body));
    // 같은 파일의 다음 revision은 압축본을 그대로 이어 쓴다
    const next = summarizeCardBody({key: 'demo/card', revision: 2, title: '제목'}, body, {title: '제목', summary});
    assert.equal(next.explainZ, summary.explainZ);
  }
  assert.equal(explainBodyFromSummary({explainBody: '옛 요약'}), '옛 요약');
  assert.equal(explainBodyFromSummary(undefined), undefined);
  assert.equal(explainBodyFromSummary({explainZ: compressExplainBody('')}), '');
});
