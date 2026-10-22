import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeCodexOptions, dedupeResumeCommand} from '../src/codex-option-merge.mjs';
import {commandWords} from '../src/ai-identity.mjs';

const transcript = ['--model', 'B', '-c', 'k=w', '-c', 'extra="x"'];

test('empty start fills options from the dialogue', () => {
  assert.deepEqual(mergeCodexOptions([], transcript), transcript);
});

test('start options win per key; dialogue only fills missing keys', () => {
  assert.deepEqual(mergeCodexOptions(['--model', 'A', '-c', 'k=v', '--yolo'], transcript),
    ['--model', 'A', '-c', 'k=v', '--yolo', '-c', 'extra="x"']);
});

test('--model=X, -m X and --config k=v share keys with the split forms', () => {
  assert.deepEqual(mergeCodexOptions(['--model=A'], ['-m', 'B', '--model', 'C']), ['--model=A']);
  assert.deepEqual(mergeCodexOptions(['--config', 'k=v'], ['-c', 'k=w']), ['--config', 'k=v']);
  assert.deepEqual(mergeCodexOptions(['--config=k=v'], ['-c', 'k=w']), ['--config=k=v']);
});

test('an already doubled start collapses to its first block', () => {
  const doubled = ['--model', 'FIRST', '-c', 'model_reasoning_effort', '-c', 'approval_policy',
    '--model', 'SECOND', '-c', 'model_reasoning_effort', '-c', 'approval_policy'];
  assert.deepEqual(mergeCodexOptions(doubled),
    ['--model', 'FIRST', '-c', 'model_reasoning_effort', '-c', 'approval_policy']);
});

test('words after -- stay untouched at the end', () => {
  assert.deepEqual(mergeCodexOptions(['--model', 'A', '--', 'hi', '--model', 'Z'], ['--model', 'B', '-c', 'k=w']),
    ['--model', 'A', '-c', 'k=w', '--', 'hi', '--model', 'Z']);
});

test('dedupeResumeCommand fixes resume commands and leaves others as they are', () => {
  const fixed = dedupeResumeCommand("'codex' 'resume' 'id1' '--model' 'A' '-c' 'k=v' '--model' 'B' '-c' 'k=w'");
  assert.deepEqual(commandWords(fixed), ['codex', 'resume', 'id1', '--model', 'A', '-c', 'k=v']);
  assert.equal(dedupeResumeCommand('codex --model A --model B'), 'codex --model A --model B');
  assert.equal(dedupeResumeCommand("codex 'unclosed"), "codex 'unclosed");
});
