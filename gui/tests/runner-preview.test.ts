import test from 'node:test';
import assert from 'node:assert/strict';
import {seniorPreview} from '../src/runner-preview.ts';
import {seniorCommandLabel} from '../../src/senior.mjs';

// 화면의 시니어 '바뀔 명령'은 서버가 표에 보이는 명령 글(seniorCommandLabel)과 같아야 한다.
// 2026-11-20: 화면만 agy에도 senior.sh·max를 보여 서버와 어긋났다.
const codex = {runner: 'codex', model: 'gpt-x', effort: 'high'};
const agy = {runner: 'agy', model: 'gemini-x-high'};

test('재현: 옛 화면 글은 agy 시니어에 senior.sh와 max를 보였다', () => {
  const old = (c: {runner: string; model: string; effort?: string}) =>
    `KADAN_SENIOR_MODEL=${c.model} KADAN_SENIOR_EFFORT=${c.effort || 'max'} senior.sh (${c.runner} exec, 저장소 읽기 전용)`;
  assert.match(old(agy), /senior\.sh \(agy exec/);
  assert.notEqual(old(agy), seniorCommandLabel([agy]));
});

test('시니어 미리보기는 서버 명령 글과 같다: codex는 senior.sh, agy는 대화창', () => {
  for (const choice of [codex, {runner: 'codex', model: 'gpt-x'}, agy, {...agy, effort: 'high'}])
    assert.equal(seniorPreview({effort: '', ...choice}), seniorCommandLabel([choice]));
  assert.doesNotMatch(seniorPreview(agy), /senior\.sh|max|exec/);
  assert.match(seniorPreview(agy), /agy 대화창 · 모델 gemini-x-high/);
});
