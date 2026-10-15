import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFlags} from '../src/cli-basics.mjs';

const examples = [
  ['from-screen', ['worker', 'repo/card']],
  ['next-block', ['auto-configure', 'repo/work']],
  ['no-prompt', ['worker']],
  ['apply', ['prune']],
  ['manual', ['begin', 'worker']],
  ['force', ['worker']],
];
for (const [flag, args] of examples) {
  test(`--${flag}는 위치 인자 앞·사이·뒤에서 같은 불리언으로 읽힌다`, () => {
    for (let i = 0; i <= args.length; i++) {
      const argv = [...args.slice(0, i), `--${flag}`, ...args.slice(i)];
      assert.deepEqual(parseFlags(argv), {flags: {[flag]: true}, rest: args});
    }
  });
}

test('값을 받는 옵션·반복 값·다른 명령의 -- 뒤 인자는 기존 방식으로 보존한다', () => {
  assert.deepEqual(parseFlags(['--from-screen', 'worker', '--wait', '2', 'repo/card',
    '--note', 'first', '--note', 'second']), {
    flags: {'from-screen': true, wait: '2', note: ['first', 'second']}, rest: ['worker', 'repo/card'],
  });
  assert.deepEqual(parseFlags(['run', 'build', '--', 'node', '--apply', 'file']), {
    flags: {}, rest: ['run', 'build', '--', 'node', '--apply', 'file'],
  });
  assert.deepEqual(parseFlags(['--to-mail', 'secretary', '--once']), {
    flags: {'to-mail': 'secretary', once: true}, rest: [],
  });
});
