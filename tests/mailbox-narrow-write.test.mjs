// Why: 우편함 명령의 읽기를 좁혔다(src/ledger.mjs 좁은 읽기). 쓰기 잠금 안의 읽기(우편 저장 직전 재계산·최종 답장 재확인·차례 반환)도
// 함께 좁아지므로, 같은 명령 순서에서 원장에 붙는 줄이 좁히기 전과 바이트까지 같은지 확인한다.
// 방법: 고정 명령 순서(tests/helpers/mailbox-write-scenario-child.mjs)를 가짜 시계·가짜 우편 ID로 두 번 돌린다.
//  한 번은 코드 그대로(좁은 읽기), 한 번은 좁은 읽기 두 함수만 전체 읽기로 바꿔 끼워서. 두 실행의 차이는 읽기뿐이다.
// MAILBOX_WRITE_ROOT로 다른 저장소(예: 좁히기 전 커밋)를 돌릴 수 있고, MAILBOX_WRITE_OUT에 붙은 줄을 남길 수 있다(전후 비교 근거용).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.MAILBOX_WRITE_ROOT ?? path.resolve(here, '..');
const child = path.join(here, 'helpers/mailbox-write-scenario-child.mjs');

function run(mode, outFile) {
  const out = spawnSync(process.execPath, [child, root, mode, ...(outFile ? [outFile] : [])], {encoding: 'utf8', timeout: 120_000});
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout.trim().split('\n').at(-1));
}

test('같은 명령 순서에서 원장에 붙는 줄이 좁은 읽기와 전체 읽기에서 바이트까지 같다', () => {
  const narrow = run('narrow', process.env.MAILBOX_WRITE_OUT), full = run('full');
  // 명령 순서가 겨냥한 쓰기 길을 실제로 지났는지: 거절되어야 할 단계만 실패하고 나머지는 성공한다.
  const failed = narrow.steps.filter(item => item.error).map(item => item.name);
  assert.deepEqual(failed, ['mail 최종 답장 반복(거절)', 'mail 취소된 질문에 최종 답(거절)', 'mail 인계 뒤 최종 답 반복(거절)',
    'mail 최종 답(전달 중 경쟁)'], JSON.stringify(narrow.steps.filter(item => item.error)));
  assert.deepEqual(full.steps, narrow.steps, '단계별 성공·실패와 오류 문구가 같다');
  for (const kind of ['send', 'dispatch', 'done', 'mail-read', 'mail-cancel', 'start', 'stop', 'handover']) {
    assert.ok(narrow.kinds[kind] > 0, `${kind} 줄이 붙었다`);
  }
  assert.equal(narrow.kinds['mail-read'], 3, '읽음 3건(반복 ack는 줄을 더하지 않는다)');
  assert.equal(narrow.kinds['(종류 없음)'], 3, '업무 줄 3건(등록·차례 넘김·차례 반환)');
  if (narrow.dump) {
    assert.match(narrow.dump, /"replyFinalRejected":true/, '전달 중 경쟁에서 밀린 최종 답');
    assert.match(narrow.dump, /우편으로 owner에게 차례 반환/, '차례 반환');
    assert.match(narrow.dump, /"systemGenerated":"task-completion"/, '자동 결과 우편');
    assert.equal(narrow.dump, full.dump, '붙은 줄이 바이트까지 같다');
  }
  assert.equal(narrow.rows, full.rows);
  assert.equal(narrow.sha256, full.sha256, '붙은 줄 전체의 지문이 같다');
  assert.equal(full.replaced, process.env.MAILBOX_WRITE_ROOT ? full.replaced : 2, '전체 읽기 실행은 좁은 읽기 두 함수를 바꿔 끼웠다');
});
