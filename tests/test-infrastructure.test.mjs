import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('시험 실행기는 파일별 상한으로 실행한다', () => {
  const source = fs.readFileSync(new URL('./run.mjs', import.meta.url), 'utf8');
  assert.match(source, /runTestFile\(/);
  assert.match(source, /FILE_TIMEOUT_MS/);
});

test('시험 홈에는 고정 tmp 경로를 쓰지 않는다', () => {
  const violations = [];
  for (const name of fs.readdirSync(new URL('./', import.meta.url))) {
    if (!name.endsWith('.test.mjs')) continue;
    const source = fs.readFileSync(new URL(name, import.meta.url), 'utf8');
    source.split('\n').forEach((line, i) => {
      if (/(?:KADAN_(?:LITE_)?HOME|\bhome)\s*[:=]\s*['"`]\/tmp\//i.test(line)) {
        violations.push(`${name}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(violations, [], 'mkdtemp와 실행기의 TMPDIR를 사용한다');
});
