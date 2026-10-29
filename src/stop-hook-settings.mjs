// claude 역할에 Stop 훅을 넣는 설정 파일과 시작 명령 주입 (2026-10-18 [kyle] 승인).
// claude 2.1.302에는 설정 경로를 주는 환경 변수가 없다(MANAGED·REMOTE는 대화형에서 훅이 안 돌았다, 실측) — `--settings <파일>`을 쓴다.
// 설정 파일은 $KADAN_HOME 안에 하나만 둔다(역할 공용, 훅이 환경의 KADAN_ROLE로 역할을 안다). 사용자 전역 설정 파일은 고치지 않는다.
// 파일이 있을 때만 붙인다 — `kadan stop-hook claude-settings`로 만들기 전에는 지금과 똑같이 동작한다.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {commandWords, launchIdentityOf} from './ai-identity.mjs';
import {ledgerHome} from './ledger.mjs';

export const SETTINGS_FLAG = '--settings';
export const SETTINGS_SUFFIX = path.join('stop-hook', 'claude-settings.json');
// 프로필(실행 모델 설정)로 띄우는 역할 전용 설정 파일. Stop 훅에 더해 화면 점검 MCP(ui-inspector)를 막는다(2026-10-29 [kyle] ㄱㄱㄱ).
// `--cmd`로 직접 띄운 명령은 위 공용 파일을 그대로 쓴다 — ui-inspector가 필요한 역할(디자인·화면 검증)의 빠져나갈 길이다.
// 막는 방법: 설정 키 deniedMcpServers는 "모든 설정 출처에서 합쳐진다"고 실행 파일(2.1.312)에 적혀 있고, 격리 세션 실측으로
// ui-inspector만 빠지고 http MCP·플러그인 MCP는 남음을 확인했다(docs/stop-hook.md). 새 깃발·MCP 설정 파일이 필요 없다.
export const PROFILE_SETTINGS_SUFFIX = path.join('stop-hook', 'claude-settings-profile.json');
export const DENIED_MCP_SERVERS = [{serverName: 'ui-inspector'}];
// 이 저장소의 훅 감싸개. 설치한 체크아웃의 절대 경로가 설정 파일에 들어간다(main 체크아웃에서 만든다).
export const HOOK_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'stop-hook.sh');

// 훅 명령·--settings 값에 쓰는 셸 인용. 두 생성기(claude 설정·codex 명령)와 commandWords가 같은 규칙을 본다.
// 작은따옴표가 없으면 '…', 있으면 "…"(commandWords가 읽는 꼴). 큰따옴표 안에서 셸이 해석하는 $ ` \\ 가 있거나
// "와 '가 모두 있으면 안전하게 인용할 수 없어 null이다 — 호출자가 조용히 넘기지 말고 알려야 한다.
export function shellQuote(value) {
  const text = String(value);
  if (/[\n\r]/.test(text)) return null;
  if (!text.includes("'")) return `'${text}'`;
  return /[$`\\"]/.test(text) ? null : `"${text}"`;
}

export function hookCommand(script = HOOK_SCRIPT) {
  const quoted = shellQuote(script);
  if (!quoted) throw new Error(`훅 감싸개 경로를 안전하게 인용할 수 없다: ${script}`);
  return `/bin/sh ${quoted}`;
}

export const claudeSettingsPath = home => path.join(home, SETTINGS_SUFFIX);
export const claudeProfileSettingsPath = home => path.join(home, PROFILE_SETTINGS_SUFFIX);

export function claudeSettingsBody(script = HOOK_SCRIPT, {profile = false} = {}) {
  const hooks = {Stop: [{hooks: [{type: 'command', command: hookCommand(script), timeout: 10}]}]};
  return `${JSON.stringify(profile ? {hooks, deniedMcpServers: DENIED_MCP_SERVERS} : {hooks}, null, 2)}\n`;
}

function writeIfChanged(file, body) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === body) return {path: file, changed: false};
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, body, {mode: 0o600});
  return {path: file, changed: true};
}

// 같은 내용이면 다시 쓰지 않는다. 돌려주는 값: {path, changed, profile: {path, changed}}.
export function writeClaudeSettings(home = ledgerHome(), script = HOOK_SCRIPT) {
  const result = writeIfChanged(claudeSettingsPath(home), claudeSettingsBody(script));
  const profile = writeIfChanged(claudeProfileSettingsPath(home), claudeSettingsBody(script, {profile: true}));
  return {...result, profile};
}

const isOurSettingsValue = value => typeof value === 'string'
  && (value.endsWith(SETTINGS_SUFFIX) || value.endsWith(PROFILE_SETTINGS_SUFFIX));

// 카단이 붙인 `--settings <우리 파일>`(또는 `--settings=<우리 파일>`)만 걷어낸 낱말 목록. 사람이 준 다른 --settings는 둔다.
export function wordsWithoutStopHook(words) {
  const kept = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] === SETTINGS_FLAG && isOurSettingsValue(words[i + 1])) { i += 1; continue; }
    if (words[i].startsWith(`${SETTINGS_FLAG}=`) && isOurSettingsValue(words[i].slice(SETTINGS_FLAG.length + 1))) continue;
    kept.push(words[i]);
  }
  return kept;
}

// 실행 파일 낱말 바로 뒤의 글자 위치. 따옴표 낱말도 commandWords와 같은 규칙으로 센다.
function afterExecutable(cmd, head) {
  for (let i = 1; i <= cmd.length; i++) {
    if (i < cmd.length && !/\s/.test(cmd[i])) continue;
    if (!/\s/.test(cmd[i - 1])) {
      const words = commandWords(cmd.slice(0, i));
      if (words && words.length === head + 1) return i;
    }
  }
  return -1;
}

// claude 실행 명령이고, 설정 파일이 있고, 이미 --settings가 없으면 실행 파일 바로 뒤에 `--settings <파일>`을 끼운다.
// 끝에 붙이지 않는 이유: 끝에는 위치 인자(프롬프트)가 올 수 있다. 판단할 수 없는 명령은 그대로 둔다.
// warn(메시지): 설정 파일이 있는데도 훅을 붙이지 못할 때 부른다(조용히 빠지지 않게). 기본은 알리지 않는다.
// profile: 프로필(실행 모델 설정) 출신 명령이면 true — 프로필 전용 파일이 있을 때 그것을 쓰고, 없으면 공용 파일로 돌아간다.
export function withStopHook(cmd, home = ledgerHome(), warn = () => {}, {profile = false} = {}) {
  if (typeof cmd !== 'string' || launchIdentityOf(cmd).harness !== 'claude') return cmd;
  const words = commandWords(cmd);
  if (!words?.length) return cmd;
  const plain = claudeSettingsPath(home), profileFile = claudeProfileSettingsPath(home);
  const file = profile && fs.existsSync(profileFile) ? profileFile : plain;
  if (!fs.existsSync(file)) return cmd;
  if (words.some(word => word === SETTINGS_FLAG || word.startsWith(`${SETTINGS_FLAG}=`))) return cmd;
  let head = 0;
  while (head < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[head])) head += 1;
  const skip = reason => { warn(`경고: Stop 훅을 붙이지 못했다(${reason}) — 이 역할은 화면 판정으로만 완료를 읽는다`); return cmd; };
  const at = afterExecutable(cmd, head);
  if (at < 0) return skip('실행 파일 위치를 찾지 못함');
  const quoted = shellQuote(file);
  if (!quoted) return skip(`설정 파일 경로를 안전하게 인용할 수 없음: ${file}`);
  const next = `${cmd.slice(0, at)} ${SETTINGS_FLAG} ${quoted}${cmd.slice(at)}`;
  const expected = [...words.slice(0, head + 1), SETTINGS_FLAG, file, ...words.slice(head + 1)];
  const got = commandWords(next);
  return got && got.length === expected.length && got.every((word, i) => word === expected[i]) ? next : skip('명령을 다시 읽을 수 없음');
}
