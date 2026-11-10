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

// start 기록의 outputLog가 "그 세션을 만들 때 새로 생긴 세대 폴더"의 manifest 경로인가.
// prepareOutputLog가 만드는 꼴(…/<만든 시각>-<UUID>/manifest.json)만 참이다. UUID가 들어가므로 세대마다 다른 값이다.
// 세대별 폴더 방식 이전의 기록은 세션 이름으로만 정해지는 고정 경로(…/out/<세션>.log.gz)라 같은 이름의 두 세대가 같은 값을 가진다 — 거짓이다.
const GENERATION_DIR = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isGenerationOutputLog(value) {
  return typeof value === 'string' && path.basename(value) === 'manifest.json' && GENERATION_DIR.test(path.basename(path.dirname(value)));
}
