// npm test의 실행기: 공통 격리 환경을 만들고 node --test를 띄운다. 시험 프로세스와 그 자식 프로세스가 이 환경을 물려받는다.
// 이유: 시험이 만든 자식 프로세스가 운영 tmux 소켓·창 설정을 물려받아 운영 창에 입력이 들어갔다(2026-10-16).
// --import 대신 환경만 넘긴다: --import는 시험 프로세스의 실행 인자를 바꿔 프로세스 신원 비교 시험을 깬다.
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {isDefaultHome} from '../src/live-floor-guard.mjs';

const env = {...process.env};
env.KADAN_SOCKET = `kadan-test-${process.pid}-${Date.now().toString(36)}`;
env.KADAN_WINDOW = 'none';
env.KADAN_NOTIFY = 'off';
if (isDefaultHome(env.KADAN_HOME)) delete env.KADAN_HOME; // 운영 홈 값은 지운다
for (const name of ['KADAN_ROLE', 'KADAN_ROTTIE_BIN', 'KADAN_LITE_SOCKET', 'KADAN_LITE_HOME', 'KADAN_ALLOW_LIVE_FLOOR']) {
  delete env[name];
}
const dir = new URL('./', import.meta.url);
const files = process.argv.length > 2 ? process.argv.slice(2)
  : fs.readdirSync(dir).filter(f => f.endsWith('.test.mjs')).sort().map(f => `tests/${f}`);
const result = spawnSync(process.execPath, ['--test', ...files], {env, stdio: 'inherit'});
process.exit(result.status ?? 1);
