// Why: Rottie가 다시 만든 복원 명령은 살아 있던 프로세스의 인자 가운데 일부만 옮겨 온다. 그 세대의 시작 기록에 있던
// 권한 옵션(claude)·프로필과 설정 값(codex)이 빠지면 역할이 다른 권한·설정으로 이어서 돌고, Stop 훅도 빠진다.
// 규칙은 보존뿐이다: 복원 명령에 없을 때만 원본 값을 그대로 잇는다. 원본에 없던 값은 붙이지 않고, 이미 있는 값은
// 바꾸지 않는다. 읽을 수 없거나 애매하면 잇지 않고 그 사실만 알린다. 이 모듈은 던지지 않는다.
import {commandWords} from './ai-identity.mjs';
import {quoteWord} from './codex-option-merge.mjs';
import {RESTORE_OPTIONS} from './server-restore-command.mjs';
import {PERMISSION_MODES} from './adopt-permissions.mjs';
import {withStopHook} from './stop-hook-settings.mjs';

const PROFILE = {group: 'profile', key: 'profile', valid: v => /^[\w.-]+$/.test(v)};
const CONFIG = {config: true, valid: v => /^[A-Za-z_][\w.-]*=/.test(v)};
// 이어 줄 옵션. 값 꼴은 여기서 다시 확인한다. 묶음(group)이 복원 명령에 이미 있으면 그 묶음은 건드리지 않는다.
const CARRY = {
  claude: {
    value: {
      '--permission-mode': {group: 'permission', key: 'permission-mode', valid: v => PERMISSION_MODES.includes(v)},
    },
    flag: {
      '--dangerously-skip-permissions': {group: 'permission', key: 'skip-permissions'},
      '--allow-dangerously-skip-permissions': {group: 'permission', key: 'allow-skip-permissions'},
    },
  },
  codex: {
    value: {
      '-p': PROFILE, '--profile': PROFILE,
      // 설정 값은 키(`k=v`의 k)마다 따로 본다: 복원 명령에 없는 키만 잇는다.
      '-c': CONFIG, '--config': CONFIG,
    },
    flag: {},
  },
};
// 값을 받지 않는다고 아는 옵션. 서버 복원의 허용 목록에 대화 지정 표시를 더한다(claude의 -c는 --continue다).
const PLAIN_FLAGS = {claude: ['--fork-session', '--continue', '-c'], codex: []};
const CHAIN_LIMIT = 16;

function harnessOf(words) {
  let head = 0;
  while (head < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[head])) head += 1;
  const name = words[head]?.split('/').pop()?.replace(/^kadan-/, '');
  return {harness: name, args: words.slice(head + 1)};
}

// 명령 하나에서 이어 줄 옵션을 읽는다. 반환: {ok, harness, items:[{group, key, words}]} 또는 {ok:false, reason}.
// 믿지 않는 경우는 하나다: 이어 줄 옵션 낱말이 "값을 받는지 모르는 옵션" 바로 뒤에 있으면 그 낱말이 옵션인지
// 앞 옵션의 값인지 알 수 없다. 값을 받는다고 아는 옵션의 값 자리와 `--` 뒤(프롬프트)는 처음부터 읽지 않는다.
export function readCarryOptions(command, expected) {
  const words = commandWords(command);
  if (!words?.length) return {ok: false, reason: 'unreadable'};
  const {harness, args} = harnessOf(words);
  const carry = CARRY[harness], known = RESTORE_OPTIONS[harness];
  if (!carry || !known || (expected && harness !== expected)) return {ok: false, reason: 'unreadable'};
  const plain = new Set([...known.flag, ...PLAIN_FLAGS[harness]]);
  const start = harness === 'codex' && args[0] === 'resume' ? (args[1]?.startsWith('-') ? 1 : 2) : 0;
  const items = new Map();
  let afterUnknown = false;
  for (let i = start; i < args.length; i++) {
    const token = args[i], unsure = afterUnknown;
    afterUnknown = false;
    if (token === '--') return {ok: true, harness, items: [...items.values()], dashed: true};
    if (!token.startsWith('-')) continue;
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    const name = eq > 0 ? token.slice(0, eq) : token;
    const valueSpec = carry.value[name], flagSpec = carry.flag[name];
    if (valueSpec || flagSpec) {
      if (unsure) return {ok: false, reason: 'ambiguous'};
      let spec = flagSpec, taken = [token];
      if (valueSpec) {
        const value = eq > 0 ? token.slice(eq + 1) : args[i + 1];
        if (typeof value !== 'string' || !value || value.startsWith('-') || !valueSpec.valid(value)) {
          return {ok: false, reason: 'ambiguous'};
        }
        if (eq < 0) { taken = [token, value]; i += 1; }
        spec = valueSpec.config
          ? {group: `c:${value.split('=')[0]}`, key: `c:${value.split('=')[0]}`} : valueSpec;
        spec = {...spec, value};
      } else if (eq > 0) return {ok: false, reason: 'ambiguous'};
      const seen = items.get(spec.key);
      // 같은 옵션이 다른 값으로 두 번 있으면 어느 쪽이 실제 값인지 정하지 않는다.
      if (seen && seen.value !== spec.value) return {ok: false, reason: 'ambiguous'};
      if (!seen) items.set(spec.key, {group: spec.group, key: spec.key, value: spec.value, words: taken});
      continue;
    }
    if (eq > 0 || plain.has(name)) continue;
    // 값을 꼭 받는 옵션의 다음 낱말은 `-`로 시작해도 그 옵션의 값이다(프롬프트 글이 옵션으로 읽히지 않게).
    if (known.value.has(name)) { i += 1; continue; }
    // --resume은 값 없이도 쓰인다. 다음 낱말이 옵션 꼴이면 값이 아니라 옵션으로 읽는다.
    if (harness === 'claude' && ['--resume', '-r'].includes(name)) {
      if (args[i + 1] !== undefined && !args[i + 1].startsWith('-')) i += 1;
      continue;
    }
    afterUnknown = true;
  }
  return {ok: true, harness, items: [...items.values()], dashed: false};
}

// 복원 대상 세대가 실제로 쓰던 값. 복원으로 이어진 세대(restoredFrom)는 같은 세대의 연속이므로,
// 앞선 복원이 잃은 값은 정확한 이전 탭의 시작 기록에서 찾는다. 가까운 세대의 값이 이긴다.
// 고리가 끊기거나 읽지 못하면 아무것도 잇지 않는다.
function originalOptions(start, entries, harness) {
  const found = new Map(), seen = new Set();
  let current = start;
  for (let depth = 0; current; depth++) {
    if (seen.has(current) || depth >= CHAIN_LIMIT) return {ok: false, reason: 'chain-unresolved'};
    seen.add(current);
    const read = readCarryOptions(current.cmd, harness);
    if (!read.ok) return {ok: false, reason: `original-${read.reason}`};
    // 이 세대에서 처음 보는 묶음만 받는다(더 가까운 세대가 이미 가진 묶음은 그대로 둔다).
    const fresh = new Set(read.items.map(item => item.group).filter(group => !found.has(group)));
    for (const group of fresh) found.set(group, read.items.filter(item => item.group === group));
    if (!current.restoredFrom) break;
    const previous = entries.filter(e => e.kind === 'start' && e.session === current.session
      && e.role === current.role && e.cwd === current.cwd && e.rottieTerminalId === current.restoredFrom);
    if (previous.length !== 1) return {ok: false, reason: 'chain-unresolved'};
    current = previous[0];
  }
  return {ok: true, items: [...found.values()].flat()};
}

const REASONS = {
  'original-unreadable': '원본 시작 명령을 읽지 못함',
  'original-ambiguous': '원본 시작 명령의 옵션 자리가 애매함',
  'chain-unresolved': '복원으로 이어진 이전 시작 기록을 하나로 확인하지 못함',
  'command-ambiguous': '복원 명령의 옵션 자리가 애매함',
  'command-dashed': '복원 명령에 `--` 뒤 입력이 있어 옵션 자리를 정하지 못함',
  'quote-failed': '이어 줄 값을 안전하게 인용하지 못함',
};

// 반환: {launch, extra}. launch는 세션을 만들고 start에 기록할 명령, extra는 start 기록에 더할 칸이다.
//   extra.optionCarry: 'added'(optionCarryKeys에 이은 옵션 이름) | 'skipped'(optionCarryReason에 정해진 이유 낱말)
// 이을 것이 없으면(원본에 없거나 복원 명령에 이미 있으면) extra는 비어 있다. 검사는 호출자가 원래 명령으로 한다.
export function recoveryLaunch({command, start, entries, home, warn = () => {}}) {
  const skip = reason => {
    warn(`경고: 복원 명령에 원본 세대의 옵션을 잇지 못했다(${REASONS[reason] ?? reason})`
      + ' — Rottie가 준 명령 그대로 연다');
    return {launch: hooked(command, home, warn), extra: {optionCarry: 'skipped', optionCarryReason: reason}};
  };
  try {
    const words = commandWords(command);
    const harness = words ? harnessOf(words).harness : undefined;
    // 카단이 권한·설정을 다루지 않는 실행기와 읽을 수 없는 명령은 그대로 둔다(실행기 대조는 호출자의 검사가 한다).
    if (!CARRY[harness]) return {launch: hooked(command, home, warn), extra: {}};
    const now = readCarryOptions(command, harness);
    // claude가 이을 것은 권한 한 묶음뿐이다. 복원 명령에 이미 있으면 원본을 읽을 필요도 없다.
    if (harness === 'claude' && now.ok && now.items.length) return {launch: hooked(command, home, warn), extra: {}};
    const origin = originalOptions(start, entries, harness);
    if (origin.ok && !origin.items.length) return {launch: hooked(command, home, warn), extra: {}};
    if (!origin.ok) return skip(origin.reason);
    if (!now.ok) return skip(`command-${now.reason}`);
    const present = new Set(now.items.map(item => item.group));
    const missing = origin.items.filter(item => !present.has(item.group));
    if (!missing.length) return {launch: hooked(command, home, warn), extra: {}};
    if (now.dashed) return skip('command-dashed');
    const added = missing.flatMap(item => item.words);
    const quoted = added.map(quoteWord);
    const next = quoted.some(word => word === null) ? null : `${command} ${quoted.join(' ')}`;
    const before = commandWords(command), after = next && commandWords(next);
    if (!after || after.length !== before.length + added.length
      || ![...before, ...added].every((word, i) => word === after[i])) return skip('quote-failed');
    return {launch: hooked(next, home, warn),
      extra: {optionCarry: 'added', optionCarryKeys: missing.map(item => item.key)}};
  } catch (error) {
    // 복원을 막지 않는다. 모르는 실패는 잇지 않은 것으로 남긴다.
    warn(`경고: 복원 명령의 옵션 잇기 실패(${error.message}) — Rottie가 준 명령 그대로 연다`);
    return {launch: command, extra: {optionCarry: 'skipped', optionCarryReason: 'internal'}};
  }
}

// Stop 훅 설정은 옛 낱말을 옮기지 않고 지금 홈의 경로로 다시 붙인다(start·restart·reopen과 같은 함수).
function hooked(command, home, warn) {
  try { return withStopHook(command, home, warn); }
  catch (error) { warn(`경고: Stop 훅을 붙이지 못했다(${error.message})`); return command; }
}
