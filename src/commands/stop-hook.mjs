// kadan stop-hook claude-settings | status — Stop 훅 빠른 길의 준비와 확인(docs/stop-hook.md).
// claude-settings는 $KADAN_HOME 안에 설정 파일 하나만 만든다. codex 전역 파일과 사용자 전역 설정은 고치지 않는다.
import fs from 'node:fs';
import { ledgerHome } from '../ledger.mjs';
import { die } from '../cli-basics.mjs';
import { claudeSettingsPath, writeClaudeSettings, HOOK_SCRIPT } from '../stop-hook-settings.mjs';
import { codexStopHookTrust, codexHome, codexHookCommand } from '../stop-hook-codex-trust.mjs';
import { readSpool, spoolPath } from '../stop-hook-spool.mjs';

const USAGE = 'kadan stop-hook claude-settings | status — claude 역할용 Stop 훅 설정 파일을 만들거나(이 체크아웃 기준), 준비 상태를 읽기만 한다';

export function cmdStopHook(argv, flags, { home = ledgerHome(), print = console.log } = {}) {
  const [action] = argv;
  if (argv.length !== 1 || !['claude-settings', 'status'].includes(action)) die(USAGE, 2);
  if (action === 'claude-settings') {
    const result = writeClaudeSettings(home);
    return print(`${result.changed ? '만들었다' : '이미 같은 내용이다'}: ${result.path}\n` +
      '이 파일이 있으면 kadan이 새로 띄우는 claude 역할 명령에 --settings <파일>을 끼운다. 이미 떠 있는 역할은 다음 start·restart부터다.');
  }
  const file = claudeSettingsPath(home), trust = codexStopHookTrust();
  const rows = readSpool(home), last = rows.at(-1);
  print([
    `claude 설정 파일: ${fs.existsSync(file) ? '있음' : '없음(kadan stop-hook claude-settings로 만든다)'} (${file})`,
    `codex 훅(${codexHome()}/hooks.json): ${trust.state}${trust.key ? ` — ${trust.key}` : ''}`,
    `codex에 넣을 명령: ${codexHookCommand()}`,
    `훅 증거 파일: ${spoolPath(home)} — 최근 줄 ${rows.length}개${last ? `, 마지막 ${last.at} ${last.role} ${last.harness}` : ''}`,
    `훅 감싸개: ${HOOK_SCRIPT}`,
  ].join('\n'));
}
