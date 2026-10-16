// 디코 다리(`kadan discord watch`)가 오류로 멈출 때 마지막 이유 한 줄을 $KADAN_HOME에 남긴다(2026-10-16).
// 감시 경보가 이 이유를 본문에 붙인다. 비밀값은 scrubSecrets로 가린다. 쓰기·읽기 실패는 조용히 넘긴다(보조 정보).
import fs from 'node:fs';
import path from 'node:path';
import {scrubSecrets} from './user-notify.mjs';

export const BRIDGE_EXIT_FILE = 'discord-bridge-exit.json';

export function writeBridgeExit(home, error, secrets = []) {
  try {
    const record = {at: new Date().toISOString(), kind: error?.kind ?? null, status: error?.status ?? null, code: error?.code ?? null,
      message: scrubSecrets(error?.message, secrets).slice(0, 300)};
    fs.mkdirSync(home, {recursive: true, mode: 0o700});
    const file = path.join(home, BRIDGE_EXIT_FILE), tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record) + '\n', {mode: 0o600});
    fs.renameSync(tmp, file);
  } catch { /* 보조 기록이다 */ }
}

export function readBridgeExit(home) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(home, BRIDGE_EXIT_FILE), 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}
