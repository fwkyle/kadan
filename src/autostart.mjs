// 로그인할 때 비서·대시보드 켜기(2026-10-06 [kyle]), 그리고 기반 프로세스 되살리기(2026-10-16 [kyle] 결정 f66a5b60):
// macOS LaunchAgent가 로그인 때 한 번, 그 뒤 60초마다 `kadan up --hidden --auto`를 실행한다.
// 대상은 기반 프로세스 4개(비서·대시보드·디코 다리·감시기)뿐이다. 살아 있는 것은 그대로 두고(KeepAlive 없음), 죽은 것만 다시 띄운다.
// 작업자·검수자·감독 같은 AI 역할은 되살리지 않는다 — "감시기는 AI 역할을 자동 재시작하지 않는다"는 잠긴 규칙 3의 선은 그대로다.
// 사람이 kadan stop으로 끈 대상과 1시간에 3번 넘게 꺼진 대상은 건너뛴다(src/revive.mjs). 사람이 친 kadan up이 그 멈춤을 푼다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const AUTOSTART_LABEL = 'dev.kadan.up';
export const START_INTERVAL_S = 60;
// 로그인 직후 launchd에는 PATH가 거의 없다. node·tmux·실행기(claude·codex)를 찾을 수 있게 설치 때의 값을 적어 둔다.
const CARRIED_ENV = ['PATH', 'KADAN_HOME', 'KADAN_WINDOW', 'KADAN_FLOOR', 'KADAN_ROTTIE_BIN', 'KADAN_SOCKET'];

export function autostartPath(userHome = os.homedir()) {
  return path.join(userHome, 'Library', 'LaunchAgents', AUTOSTART_LABEL + '.plist');
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function autostartPlist({ node, cli, cwd, env: given, logPath }) {
  // 로그인 직후엔 로티가 아직 없다. 카단은 로티 창 설정에서 역할을 숨김으로 띄우는 것을 막고(KADAN_HIDDEN_FORBIDDEN),
  // "로티를 쓸 수 없을 때만 KADAN_WINDOW=none --hidden"을 허용한다. 로그인 시작이 바로 그 경우다.
  const env = { ...given, KADAN_WINDOW: 'none' };
  const vars = CARRIED_ENV.filter((k) => typeof env[k] === 'string' && env[k]).map((k) => `\t\t<key>${k}</key>\n\t\t<string>${xml(env[k])}</string>`);
  const args = [node, cli, 'up', '--hidden', '--auto'].map((a) => `\t\t<string>${xml(a)}</string>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${AUTOSTART_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
${args.join('\n')}
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${xml(cwd)}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
${vars.join('\n')}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>StartInterval</key>
\t<integer>${START_INTERVAL_S}</integer>
\t<key>StandardOutPath</key>
\t<string>${xml(logPath)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

const STALE_FIX = 'kadan autostart remove → kadan autostart install → launchctl 재적재 (status는 고치지 않는다)';
const unxml = (s) => s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

// 설치된 plist에 적힌 node·cli·KADAN_ROTTIE_BIN 경로를 읽기만 한다. 쓸 수 없는 것만 돌려준다.
// reason 없음 = 파일이 없다. node·Rottie는 실행 권한(X_OK), cli는 node가 읽는 스크립트라 읽기(R_OK)만 본다.
// node·cli 값을 못 읽으면(plist가 아님·ProgramArguments 없음·빈 값) 정상으로 넘기지 않고 NO_REQUIRED_ARG로 알린다. Rottie 키가 없는 것은 정상이다.
export const NO_REQUIRED_ARG = '필수 인수를 읽지 못함';
export const NO_EXEC = '실행 권한 없음';
export function staleAutostartPaths(plistText) {
  const args = [...(plistText.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unxml(m[1]));
  const rottie = plistText.match(/<key>KADAN_ROTTIE_BIN<\/key>\s*<string>([^<]*)<\/string>/)?.[1];
  const checks = [['node', args[0], fs.constants.X_OK, true], ['cli', args[1], fs.constants.R_OK, true],
    ['KADAN_ROTTIE_BIN', rottie === undefined ? undefined : unxml(rottie), fs.constants.X_OK, false]];
  const out = [];
  for (const [what, p, mode, required] of checks) {
    if (!p) { if (required) out.push({ what, path: '', reason: NO_REQUIRED_ARG }); continue; }
    if (!fs.existsSync(p)) { out.push({ what, path: p }); continue; }
    try { fs.accessSync(p, mode); } catch { out.push({ what, path: p, reason: mode === fs.constants.X_OK ? NO_EXEC : '읽기 권한 없음' }); }
  }
  return out;
}

// 경고 한 항목을 사람이 읽는 말로 바꾼다. 출력하는 쪽(quickstart.mjs)이 쓴다.
export const describeStale = (s) => s.reason === NO_REQUIRED_ARG ? `${s.what}: ${NO_REQUIRED_ARG}` : `${s.what}=${s.path} (${s.reason ?? '없음'})`;

// show: 만들 파일을 보여 주기만 한다. install: 없을 때만 쓴다(다른 내용이 있으면 remove 먼저). remove: 지우지 않고 .trash로 옮긴다.
export function autostartCommand(action, { home, cli, node = process.execPath, cwd = process.cwd(), env = process.env, userHome = os.homedir(), now = new Date() } = {}) {
  const file = autostartPath(userHome);
  const content = autostartPlist({ node, cli, cwd, env, logPath: path.join(home, 'autostart.log') });
  const exists = fs.existsSync(file);
  if (action === 'show') return { file, installed: exists, content };
  if (action === 'status') {
    if (!exists) return { file, installed: false, current: null };
    const installed = fs.readFileSync(file, 'utf8');
    const stale = staleAutostartPaths(installed);
    return { file, installed: true, current: installed === content, stale, ...(stale.length ? { fix: STALE_FIX } : {}) };
  }
  if (action === 'install') {
    if (exists) {
      if (fs.readFileSync(file, 'utf8') === content) return { file, installed: true, changed: false };
      throw new Error(`이미 다른 내용으로 설치돼 있다: ${file} — kadan autostart remove 뒤 다시 설치해라`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return { file, installed: true, changed: true, note: '다음 로그인부터 비서·대시보드가 숨김으로 켜지고, 60초마다 꺼진 기반 프로세스 4개를 다시 띄운다(launchctl 재적재 전에는 새 주기가 적용되지 않는다)' };
  }
  if (action === 'remove') {
    if (!exists) return { file, installed: false, changed: false };
    const trash = path.join(home, '.trash', 'autostart-' + now.toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(file, path.join(trash, path.basename(file)));
    return { file, installed: false, changed: true, movedTo: path.join(trash, path.basename(file)) };
  }
  throw new Error('사용법: kadan autostart show|status|install|remove');
}
