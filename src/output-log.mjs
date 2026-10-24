// Why: 새 세션의 출력을 별도 세대와 크기별 조각으로 보존한다. 기존 출력은 건드리지 않는다.
// 출력이 10배면 조각 수가 늘지만, gzip/split의 버퍼와 프로세스 수는 같다.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {shellQuote} from './mail-instructions.mjs';

export const OUTPUT_PART_BYTES = 8 * 1024 * 1024;

export function prepareOutputLog(session, home, {compressed = true, split = true} = {}) {
  if (typeof session !== 'string' || !session || session === '.' || session === '..' || session.includes('\0')
      || session !== path.basename(session)) throw new Error('출력 세션 주소 확인 필요');
  const createdAt = new Date().toISOString();
  const generation = `${createdAt.replace(/[:.]/g, '-')}-${randomUUID()}`;
  const directory = path.join(home, 'out', session, generation);
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const manifestPath = path.join(directory, 'manifest.json');
  const manifest = {
    format: 'kadan-output-v1', session, createdAt, encoding: compressed ? 'gzip' : 'raw',
    partPrefix: 'part-', suffixLength: 6, partBytes: split ? OUTPUT_PART_BYTES : null,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest) + '\n', {flag: 'wx', mode: 0o600});
  const prefix = path.join(directory, manifest.partPrefix);
  const sink = `split -b ${OUTPUT_PART_BYTES} -a ${manifest.suffixLength} - ${shellQuote(prefix)}`;
  // 조각은 압축 스트림의 일부다. 이름 순으로 모두 이은 뒤 gzip을 해제해야 한다.
  const writer = split ? (compressed ? `gzip -1c | ${sink}` : `exec ${sink}`)
    : `exec ${compressed ? 'gzip -1c' : 'cat'} > ${shellQuote(prefix + 'aaaaaa')}`;
  const program = `umask 077; ${writer}`;
  const shell = split && compressed ? '/bin/bash -o pipefail' : '/bin/sh';
  return {manifestPath, command: `exec ${shell} -c ${shellQuote(program)}`};
}
