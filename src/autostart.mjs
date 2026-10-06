// 로그인할 때 비서·대시보드 켜기(2026-10-06 [kyle]): macOS LaunchAgent가 로그인 때 `kadan up --hidden`을 한 번 실행한다.
// 죽었다고 되살리지 않는다(KeepAlive 없음) — "watch는 프로세스를 자동 재시작하지 않는다"는 잠긴 규칙과 같은 선이다.
// 비서가 죽으면 관계표(비서 → @user)에 따라 감시기가 사용자에게 알리고, 대시보드의 '켜기'로 다시 켠다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const AUTOSTART_LABEL = 'dev.kadan.up';
// 로그인 직후 launchd에는 PATH가 거의 없다. node·tmux·실행기(claude·codex)를 찾을 수 있게 설치 때의 값을 적어 둔다.
const CARRIED_ENV = ['PATH', 'KADAN_HOME', 'KADAN_WINDOW', 'KADAN_FLOOR', 'KADAN_ROTTIE_BIN', 'KADAN_SOCKET'];

export function autostartPath(userHome = os.homedir()) {
  return path.join(userHome, 'Library', 'LaunchAgents', AUTOSTART_LABEL + '.plist');
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function autostartPlist({ node, cli, cwd, env, logPath }) {
  const vars = CARRIED_ENV.filter((k) => typeof env[k] === 'string' && env[k]).map((k) => `\t\t<key>${k}</key>\n\t\t<string>${xml(env[k])}</string>`);
  const args = [node, cli, 'up', '--hidden'].map((a) => `\t\t<string>${xml(a)}</string>`);
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
\t<key>StandardOutPath</key>
\t<string>${xml(logPath)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

// show: 만들 파일을 보여 주기만 한다. install: 없을 때만 쓴다(다른 내용이 있으면 remove 먼저). remove: 지우지 않고 .trash로 옮긴다.
export function autostartCommand(action, { home, cli, node = process.execPath, cwd = process.cwd(), env = process.env, userHome = os.homedir(), now = new Date() } = {}) {
  const file = autostartPath(userHome);
  const content = autostartPlist({ node, cli, cwd, env, logPath: path.join(home, 'autostart.log') });
  const exists = fs.existsSync(file);
  if (action === 'show') return { file, installed: exists, content };
  if (action === 'status') return { file, installed: exists, current: exists ? fs.readFileSync(file, 'utf8') === content : null };
  if (action === 'install') {
    if (exists) {
      if (fs.readFileSync(file, 'utf8') === content) return { file, installed: true, changed: false };
      throw new Error(`이미 다른 내용으로 설치돼 있다: ${file} — kadan autostart remove 뒤 다시 설치해라`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return { file, installed: true, changed: true, note: '다음 로그인부터 비서·대시보드가 숨김으로 켜진다' };
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
