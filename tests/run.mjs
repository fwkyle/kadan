// npm test의 실행기: 공통 격리 환경을 만들고 node --test를 띄운다. 시험 프로세스와 그 자식 프로세스가 이 환경을 물려받는다.
// 이유: 시험이 만든 자식 프로세스가 운영 tmux 소켓·창 설정을 물려받아 운영 창에 입력이 들어갔다(2026-10-16).
// --import 대신 환경만 넘긴다: --import는 시험 프로세스의 실행 인자를 바꿔 프로세스 신원 비교 시험을 깬다.
// 실행별 임시 폴더(TMPDIR)·tmux 소켓 폴더(TMUX_TMPDIR)를 따로 만들고 끝나면 이 실행기가 직접 지운다.
// 이유: 시험 129개 파일이 os.tmpdir() 아래 홈을 만들고 지우지 않아 $TMPDIR에 19GB가 쌓였다(2026-10-16).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {isDefaultHome} from '../src/live-floor-guard.mjs';

const env = {...process.env};
env.KADAN_SOCKET = `kadan-test-${process.pid}-${Date.now().toString(36)}`;
env.KADAN_WINDOW = 'none';
env.KADAN_NOTIFY = 'off';
if (isDefaultHome(env.KADAN_HOME)) delete env.KADAN_HOME; // 운영 홈 값은 지운다
for (const name of ['KADAN_ROLE', 'KADAN_ROTTIE_BIN', 'KADAN_LITE_SOCKET', 'KADAN_LITE_HOME',
  'KADAN_ALLOW_LIVE_FLOOR', 'KADAN_ALLOW_FAKE_ROTTIE']) {
  delete env[name];
}
// 실행별 폴더: 이 실행기가 만든 절대경로 하나만 지운다. 다시 만들 수 있는 캐시라 삭제 예외에 해당한다.
// 짧은 /tmp 아래에 둔다: 유닉스 소켓 경로 한도(약 104자)가 있어, 기본 $TMPDIR(약 50자) 아래에 한 겹 더 만들면
// herdr 시험의 소켓 경로가 넘쳐 멈췄다(2026-10-16). tmux 소켓은 그 안의 tmux 폴더에 둔다.
const runTmp = fs.realpathSync(fs.mkdtempSync('/tmp/kadan-run-'));
const tmuxTmp = path.join(runTmp, 'tmux');
fs.mkdirSync(tmuxTmp);
env.TMPDIR = runTmp;
env.TMUX_TMPDIR = tmuxTmp;

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  // 자기 소켓의 tmux 서버만 끈다. 운영(-L kadan)은 건드리지 않는다.
  spawnSync('tmux', ['-L', env.KADAN_SOCKET, 'kill-server'], {env, stdio: 'ignore'});
  fs.rmSync(runTmp, {recursive: true, force: true}); // tmux 소켓 폴더도 이 안에 있다
}

const dir = new URL('./', import.meta.url);
const files = process.argv.length > 2 ? process.argv.slice(2)
  : fs.readdirSync(dir).filter(f => f.endsWith('.test.mjs')).sort().map(f => `tests/${f}`);
// spawnSync는 신호 처리기를 막으므로 비동기로 띄운다.
const child = spawn(process.execPath, ['--test', ...files], {env, stdio: 'inherit'});
let interrupted = null; // 중단 신호를 받으면 시험 쪽 종료 코드와 상관없이 128+신호 번호로 끝낸다
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.on(signal, () => {
    interrupted = code;
    child.kill(signal);
    setTimeout(() => { cleanup(); process.exit(code); }, 10_000).unref();
  });
}
child.on('error', err => { console.error(err.message); cleanup(); process.exit(1); });
child.on('exit', (status, signal) => {
  cleanup();
  process.exit(interrupted ?? status ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1));
});
process.on('exit', cleanup);
