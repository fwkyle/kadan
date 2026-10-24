import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {OUTPUT_PART_BYTES, prepareOutputLog} from '../src/output-log.mjs';

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "output ' $() ` parts-"));
const run = (log, input) => spawnSync('/bin/sh', ['-c', log.command], {input, encoding: null});
function read(log) {
  const manifest = JSON.parse(fs.readFileSync(log.manifestPath, 'utf8'));
  const directory = path.dirname(log.manifestPath);
  const files = fs.readdirSync(directory).filter(name => /^part-[a-z]{6}$/.test(name)).sort();
  const parts = files.map(name => fs.readFileSync(path.join(directory, name)));
  const bytes = Buffer.concat(parts);
  return {manifest, parts, files, directory,
    bytes: manifest.encoding === 'gzip' ? gunzipSync(bytes) : bytes};
}

test('압축·원문 모두 크기 경계와 바이너리를 보존하고 이름 순서로 복원한다', () => {
  const input = randomBytes(OUTPUT_PART_BYTES + 97);
  for (const compressed of [true, false]) {
    const log = prepareOutputLog('kadan-output-proof', home(), {compressed});
    assert.equal(run(log, input).status, 0);
    const result = read(log);
    assert.equal(result.manifest.partBytes, OUTPUT_PART_BYTES);
    assert.ok(result.parts.length >= 2);
    assert.ok(result.parts.every(part => part.length <= OUTPUT_PART_BYTES));
    assert.deepEqual(result.bytes, input);
    for (const name of [...result.files, 'manifest.json']) {
      assert.equal(fs.statSync(path.join(result.directory, name)).mode & 0o077, 0);
    }
  }
});

test('분할 도구가 없으면 해당 세대에 원문을 보존하고 상한 없음이 표시된다', () => {
  const input = Buffer.from('unchanged evidence\0\xff\n', 'latin1');
  for (const compressed of [true, false]) {
    const log = prepareOutputLog('kadan-output-proof', home(), {compressed, split: false});
    assert.equal(run(log, input).status, 0);
    const result = read(log);
    assert.equal(result.manifest.partBytes, null);
    assert.deepEqual(result.bytes, input);
  }
});

test('빈 출력도 닫힌 뒤 복원되며 쓰기 실패를 정상 종료로 숨기지 않는다', () => {
  for (const compressed of [true, false]) {
    const log = prepareOutputLog('kadan-output-proof', home(), {compressed});
    assert.equal(run(log, Buffer.alloc(0)).status, 0);
    assert.equal(read(log).bytes.length, 0);
  }
  const log = prepareOutputLog('kadan-output-proof', home());
  fs.mkdirSync(path.join(path.dirname(log.manifestPath), 'part-aaaaaa'));
  assert.notEqual(run(log, Buffer.from('must fail')).status, 0);
});

test('출력 세대는 재사용하지 않고 폴더 밖 세션 주소를 거절한다', () => {
  const root = home();
  const first = prepareOutputLog('kadan-output-proof', root);
  const second = prepareOutputLog('kadan-output-proof', root);
  assert.notEqual(first.manifestPath, second.manifestPath);
  for (const name of ['', '.', '..', '../outside', 'nested/session', 'bad\0name']) {
    assert.throws(() => prepareOutputLog(name, root), /세션 주소/);
  }
});
