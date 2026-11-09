// Why: 복원 판단은 가짜 입출력으로 검증하고, 실제 실행은 기존 start·send CLI 경계로만 한다.
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readSystemLedger} from './ledger.mjs';
import {readWindowSetting} from './window-setting.mjs';
import {rottieConnectivity} from './floor-tmux.mjs';

export const restoreStartDigest = entry => createHash('sha256').update(JSON.stringify(entry)).digest('hex');
const cli = new URL('./cli.mjs', import.meta.url).pathname;

export function systemUptime({platform = process.platform, run = spawnSync, now = Date.now()} = {}) {
  if (platform !== 'darwin') return os.uptime();
  const result = run('sysctl', ['-n', 'kern.boottime'], {encoding: 'utf8', timeout: 5000});
  const seconds = result.status === 0 && String(result.stdout).match(/\bsec\s*=\s*(\d+)/)?.[1];
  return seconds ? now / 1000 - Number(seconds) : NaN;
}

export function restoreEnvironment({home, setting, connected, env = process.env}) {
  const clean = {...env, KADAN_HOME: home, KADAN_ROLE: 'autostart'};
  for (const key of ['TMUX', 'TMUX_PANE', 'KADAN_PANE_SOCKET', 'KADAN_WINDOW_FORCE',
    'KADAN_ROTTIE_BIN', 'KADAN_SERVER_RESTORE_ID', 'KADAN_SERVER_RESTORE_OF']) delete clean[key];
  const window = setting?.window ?? 'none';
  clean.KADAN_WINDOW = window === 'rottie' && connected ? 'rottie' : 'none';
  if (clean.KADAN_WINDOW === 'rottie') clean.KADAN_ROTTIE_BIN = setting.rottieBin;
  return clean;
}

export function launchServerRole({home, item, id, env = process.env, run = spawnSync,
  read = () => readSystemLedger(home), window = () => readWindowSetting(home),
  connect = bin => rottieConnectivity({bin,
    spawnFn: (executable, args, options) => spawnSync(executable, args, {...options, timeout: 5000})}).ok}) {
  const entries = read();
  const last = entries.findLast(e => e.kind === 'start' && e.session === item.session);
  const index = entries.indexOf(last);
  if (!last || restoreStartDigest(last) !== restoreStartDigest(item.start)
    || entries.slice(index + 1).some(e => (e.session === item.session || e.role === item.role)
      && e.kind === 'stop')) {
    throw new Error('복원 준비 뒤 역할 상태 변경');
  }
  // 준비 전에 있던 죽음 경보는 후보에서 제외했다. 새 감시기가 이번 손실을 다시 기록한 것은
  // 수동 종료가 아니다. 새 start·stop만 재확인하여 복원을 스스로 취소하지 않는다.
  const setting = window(); // 손상 설정은 숨김으로 추정하지 않는다.
  let connected = false;
  if (setting?.window === 'rottie') {
    try { connected = connect(setting.rottieBin); } catch { /* 연결 실패일 때만 숨김 허용 */ }
  }
  const childEnv = restoreEnvironment({home, setting, connected, env});
  childEnv.KADAN_SERVER_RESTORE_ID = id;
  childEnv.KADAN_SERVER_RESTORE_OF = restoreStartDigest(item.start);
  const hidden = childEnv.KADAN_WINDOW === 'none';
  const args = [cli, 'start', item.role, '--cmd', item.command, '--profile', item.profile,
    '--reason', 'server-restore', '--no-prompt', ...(hidden ? ['--hidden'] : [])];
  const result = run(process.execPath, args, {cwd: item.start.cwd, env: childEnv,
    encoding: 'utf8', timeout: 180_000, maxBuffer: 1024 * 1024});
  // 종료 0만으로 성공을 만들지 않는다. 기존 살아 있는 세션 재사용도 복원 성공이 아니다.
  const started = read().findLast(e => e.kind === 'start' && e.session === item.session);
  if (result.status !== 0 || result.error || !started || started.reused === true
    || started.serverRestoreId !== id || started.serverRestoreOf !== childEnv.KADAN_SERVER_RESTORE_OF
    || started.reason !== 'server-restore' || started.by !== 'autostart') {
    throw new Error('서버 복원 시작 기록 확인 실패');
  }
  return {hidden};
}

export function sendRestoreNotice({home, role, message, env = process.env, run = spawnSync}) {
  const childEnv = restoreEnvironment({home, setting: null, connected: false, env});
  const result = run(process.execPath, [cli, 'send', role, '--keep-turn', message], {
    env: childEnv, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || result.error) throw new Error('복원 안내 전달 실패');
}
