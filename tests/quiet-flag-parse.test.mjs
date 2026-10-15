import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFlags} from '../src/cli-basics.mjs';

// --quiet은 명령마다 뜻이 다르다: wait는 조용함 기준 초(값), discord send는 켜고 끄기(불리언).
test('wait: --quiet은 값을 받는다(전역 불리언이 아니다) — kadan-go가 쓰는 형태', () => {
  const {flags, rest} = parseFlags(['dev', '--timeout', '3600', '--quiet', '600']);
  assert.equal(flags.quiet, '600');
  assert.deepEqual(rest, ['dev']);
  assert.equal(parseFlags(['dev', '--quiet', '3']).flags.quiet, '3');
});

test('discord send: --quiet은 불리언이고 본문 낱말의 순서를 바꾸지 않는다', () => {
  const opt = {booleans: ['quiet']};
  assert.deepEqual(parseFlags(['send', '--quiet', '본문1', '본문2'], opt), {flags: {quiet: true}, rest: ['send', '본문1', '본문2']});
  assert.deepEqual(parseFlags(['send', '본문1', '--quiet', '본문2'], opt), {flags: {quiet: true}, rest: ['send', '본문1', '본문2']});
  assert.deepEqual(parseFlags(['send', '본문', '--quiet'], opt), {flags: {quiet: true}, rest: ['send', '본문']});
  assert.deepEqual(parseFlags(['send', '--quiet', '--stdin'], opt), {flags: {quiet: true, stdin: true}, rest: ['send']});
});
