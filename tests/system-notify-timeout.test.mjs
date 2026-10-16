import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {systemNotify, systemTimeoutMs} from '../src/user-notify.mjs';

// 시험 전용 환경변수 값 검증: 어떤 값이 와도 던지지 않고 기본 3초 또는 허용 범위 안의 값만 쓴다. 실제 알림은 띄우지 않는다.
const NAME = 'KADAN_TEST_SYSTEM_NOTIFY_TIMEOUT_MS';
const CASES = [[undefined, 3000], ['', 3000], ['abc', 3000], ['0', 3000], ['999', 3000], ['-1', 3000], ['1.5', 3000],
  ['Infinity', 3000], ['1e100', 3000], ['120001', 3000], ['99999999999999999999', 3000], [' 5000', 3000],
  ['1000', 1000], ['30000', 30000], ['120000', 120000]];

test('systemTimeoutMs: 정수 1000~120000만 받고 나머지는 기본 3000', () => {
  for (const [value, want] of CASES) {
    const env = value === undefined ? {} : {[NAME]: value};
    assert.equal(systemTimeoutMs(env), want, String(value));
  }
});

test('systemNotify: 어떤 환경변수 값이어도 던지지 않고 spawn에 허용 범위 timeout을 넘기며 결과를 그대로 돌려준다', () => {
  const saved = process.env[NAME];
  try {
    for (const [value, want] of CASES) {
      if (value === undefined) delete process.env[NAME]; else process.env[NAME] = value;
      let passed;
      // 실제 osascript 대신, 같은 옵션(timeout 포함)을 그대로 받는 무해한 node 자식을 띄운다 — spawnSync가 범위 밖 timeout이면 여기서 던진다.
      const ok = systemNotify('mock', (_c, _a, o) => { passed = o.timeout; return spawnSync(process.execPath, ['-e', ''], o); });
      assert.equal(ok, null, `${value}: 성공 결과`);
      assert.equal(passed, want, `${value}: 전달된 timeout`);
      const failed = systemNotify('mock', (_c, _a, o) => spawnSync(process.execPath, ['-e', 'process.exit(3)'], o));
      assert.equal(failed, '시스템 알림 실패(종료 코드 3)', `${value}: 실패 결과`);
    }
  } finally {
    if (saved === undefined) delete process.env[NAME]; else process.env[NAME] = saved;
  }
});
