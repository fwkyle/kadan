// Why: Rottie가 다시 만든 복원 명령은 살아 있던 프로세스의 인자 가운데 일부만 옮겨 온다. 그 세대의 시작 기록에 있던
// 권한 옵션(claude)·프로필과 설정 값(codex)이 빠지면 역할이 다른 권한·설정으로 이어서 돌고, Stop 훅도 빠진다.
// 규칙은 보존뿐이다: 복원 명령에 없을 때만 원본 값을 그대로 잇는다. 원본에 없던 값은 붙이지 않고, 이미 있는 값은
// 바꾸지 않는다. 읽을 수 없거나 애매하면 잇지 않고 그 사실만 알린다. 이 모듈은 던지지 않는다.
import {commandWords} from './ai-identity.mjs';
import {quoteWord} from './codex-option-merge.mjs';
import {CLAUDE_VALUE_OPTIONS, CODEX_VALUE_OPTIONS, CODEX_FLAG_OPTIONS} from './conversation-ref.mjs';
import {PERMISSION_MODES} from './adopt-permissions.mjs';
import {withStopHook} from './stop-hook-settings.mjs';

// 실행기가 받는 옵션 표. 값을 꼭 받는 옵션은 대화 지정 해석기(conversation-ref.mjs)의 도움말 실측 표를 같이 쓴다.
// 표에 없는 옵션이 하나라도 있으면 그 명령은 읽지 못한 것으로 본다 — 모르는 옵션 뒤의 낱말이 값인지 옵션인지,
// 그 옵션이 권한·설정을 바꾸는지 알 수 없기 때문이다. 모르면 잇지 않는다.
//   claude 2.1.323 `claude --help`: 값 없는 옵션과 값이 선택인 옵션([값])을 옮겼다. 짧은 옵션에 값을 붙여 쓴 꼴은 읽지 않는다.
//   codex 0.166.0 `codex resume --help`: 짧은 옵션은 `-c 값`·`-c값`·`-c=값`을 모두 받는다(긴 옵션은 `--config 값`·`--config=값`).
//   -i/--image는 값을 여러 개 받아 표에 넣지 않는다. 짧은 옵션 묶음(`-xc`)도 읽지 않는다.
const OPTIONS = {
  claude: {
    value: CLAUDE_VALUE_OPTIONS,
    optional: new Set(['--resume', '-r', '--debug', '-d', '--cloud', '--from-pr', '--prompt-suggestions',
      '--remote-control', '--teleport', '--worktree', '-w']),
    flag: new Set(['--ax-screen-reader', '--bg', '--bare', '--brief', '--chrome', '-c', '--continue', '--desktop',
      '--disable-slash-commands', '--exclude-dynamic-system-prompt-sections', '--fork-session',
      '--forward-subagent-text', '--ide', '--include-hook-events', '--include-partial-messages', '--no-chrome',
      '--no-session-persistence', '-p', '--print', '--replay-user-messages', '--restricted', '--strict-mcp-config',
      '--safe-mode', '--tmux', '--verbose']),
    attached: false,
  },
  codex: {
    value: CODEX_VALUE_OPTIONS,
    optional: new Set(),
    flag: new Set([...CODEX_FLAG_OPTIONS, '--last', '--all', '--include-non-interactive', '--no-daemon']),
    attached: true,
  },
};

const PROFILE = {group: 'profile', key: 'profile', once: true, valid: v => /^[\w.-]+$/.test(v)};
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
  codex: {value: {'-p': PROFILE, '--profile': PROFILE, '-c': CONFIG, '--config': CONFIG}, flag: {}},
};
// codex 설정 값의 묶음은 키의 첫 마디다. 넓은 키(`a={…}`)와 좁은 키(`a.b=…`)가 같은 설정을 바꾸므로 한 묶음으로 본다.
// 승인·샌드박스는 키 이름이 여럿이라 앞머리로 묶는다.
function configGroup(key) {
  const top = key.split('.')[0];
  if (top === 'profile') return 'profile';
  if (top.startsWith('sandbox')) return 'c:sandbox';
  if (top.startsWith('approval')) return 'c:approval';
  return `c:${top}`;
}
// 같은 설정을 바꾸는 전용 옵션. 복원 명령에 이것이 있으면 그 묶음의 설정 값은 이미 있는 것이다.
const CODEX_TOUCHES = {
  '-s': ['c:sandbox'], '--sandbox': ['c:sandbox'], '--add-dir': ['c:sandbox'],
  '-a': ['c:approval'], '--ask-for-approval': ['c:approval'], '--approve-for-me': ['c:approval'],
  '--dangerously-bypass-approvals-and-sandbox': ['c:sandbox', 'c:approval'],
  '-m': ['c:model'], '--model': ['c:model'],
  '--oss': ['c:model_provider', 'c:oss_provider'], '--local-provider': ['c:model_provider', 'c:oss_provider'],
  '--enable': ['c:features'], '--disable': ['c:features'], '--search': ['c:web_search', 'c:tools'],
};
// 세션이 할 수 있는 일을 정하는 claude 옵션. 복원 명령에 이것이 있으면 권한 옵션을 더하지 않는다.
const CLAUDE_TOUCHES = Object.fromEntries(['--restricted', '--safe-mode', '--bare', '--allowedTools', '--allowed-tools',
  '--disallowedTools', '--disallowed-tools', '--tools', '--permission-prompts'].map(name => [name, ['permission']]));
const TOUCHES = {claude: CLAUDE_TOUCHES, codex: CODEX_TOUCHES};
const CHAIN_LIMIT = 16;

function harnessOf(words) {
  let head = 0;
  while (head < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[head])) head += 1;
  const name = words[head]?.split('/').pop()?.replace(/^kadan-/, '');
  return {harness: name, args: words.slice(head + 1)};
}

// 옵션 낱말 하나를 이름과 붙여 쓴 값으로 가른다. 읽지 못하는 꼴이면 null.
function splitOption(token, table) {
  if (token.startsWith('--')) {
    const eq = token.indexOf('=');
    return eq > 0 ? {name: token.slice(0, eq), inline: token.slice(eq + 1)} : {name: token};
  }
  if (token.length === 2) return {name: token};
  const name = token.slice(0, 2), rest = token.slice(2);
  if (!table.attached || !table.value.has(name)) return null;
  return {name, inline: rest.startsWith('=') ? rest.slice(1) : rest};
}

// 명령 하나에서 이어 줄 옵션을 읽는다.
// 반환: {ok, harness, items:[{group, key, value, words}], present(묶음 이름), dashed} 또는 {ok:false, reason}.
// 표에 없는 옵션·읽지 못하는 꼴·값이 빠진 옵션이 하나라도 있으면 ok:false다(ambiguous). 값을 꼭 받는 옵션의 값 자리와
// `--` 뒤(프롬프트)는 옵션으로 읽지 않는다. present에는 같은 설정을 바꾸는 전용 옵션(--sandbox 등)의 묶음도 든다.
export function readCarryOptions(command, expected) {
  const words = commandWords(command);
  if (!words?.length) return {ok: false, reason: 'unreadable'};
  const {harness, args} = harnessOf(words);
  const carry = CARRY[harness], table = OPTIONS[harness];
  if (!carry || !table || (expected && harness !== expected)) return {ok: false, reason: 'unreadable'};
  const bad = {ok: false, reason: 'ambiguous'};
  const items = [], present = new Set();
  let dashed = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--') { dashed = true; break; }
    if (!token.startsWith('-') || token === '-') continue;
    const option = splitOption(token, table);
    if (!option) return bad;
    const {name, inline} = option;
    const valueSpec = carry.value[name];
    if (valueSpec || table.value.has(name)) {
      // 값을 꼭 받는 옵션의 다음 낱말은 `-`로 시작해도 그 옵션의 값이다(프롬프트 글이 옵션으로 읽히지 않게).
      const value = inline ?? args[i + 1];
      if (typeof value !== 'string') return bad;
      if (inline === undefined) i += 1;
      for (const group of TOUCHES[harness][name] ?? []) present.add(group);
      if (!valueSpec) continue;
      if (!value || value.startsWith('-') || !valueSpec.valid(value)) return bad;
      const key = valueSpec.config ? value.split('=')[0] : null;
      // 이을 때는 띄어 쓴 꼴(`-c 값`)로 적는다. 값은 그대로이고, 카단의 다른 판독(서버 손실 복원·대화 지정)이
      // 붙여 쓴 짧은 옵션을 읽지 못하기 때문이다.
      const item = valueSpec.config ? {group: configGroup(key), key: `c:${key}`, value, words: [name, value]}
        : {group: valueSpec.group, key: valueSpec.key, value, words: [name, value]};
      // 한 번만 쓰는 옵션이 두 번 있거나(프로필), 권한 값이 서로 다르면 어느 쪽이 실제 값인지 정하지 않는다.
      const same = items.find(seen => seen.key === item.key);
      if (same && !valueSpec.config && (valueSpec.once || same.value !== item.value)) return bad;
      if (!same || valueSpec.config) items.push(item);
      present.add(item.group);
      continue;
    }
    if (table.optional.has(name)) {
      // 값이 선택인 옵션(--resume 등): 다음 낱말이 옵션 꼴이면 값이 아니라 옵션으로 읽는다.
      if (inline === undefined && args[i + 1] !== undefined && !args[i + 1].startsWith('-')) i += 1;
      continue;
    }
    if (inline !== undefined) return bad;
    const flagSpec = carry.flag[name];
    if (flagSpec) {
      if (!items.some(seen => seen.key === flagSpec.key)) items.push({...flagSpec, words: [token]});
      present.add(flagSpec.group);
      continue;
    }
    if (!table.flag.has(name)) return bad;
    for (const group of TOUCHES[harness][name] ?? []) present.add(group);
  }
  return {ok: true, harness, items, present, dashed};
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

// 양쪽 모두 `-p`/`--profile` 하나씩이고 이름이 같을 때만 같은 프로필이다(`-c profile=…`은 비교하지 않는다).
function sameProfile(nowItems, originItems) {
  const [a, ...restA] = nowItems.filter(item => item.group === 'profile');
  const [b, ...restB] = originItems.filter(item => item.group === 'profile');
  return Boolean(a && b) && !restA.length && !restB.length && a.key === 'profile' && b.key === 'profile'
    && a.value === b.value;
}

const REASONS = {
  'original-unreadable': '원본 시작 명령을 읽지 못함',
  'original-ambiguous': '원본 시작 명령의 옵션 자리가 애매함',
  'chain-unresolved': '복원으로 이어진 이전 시작 기록을 하나로 확인하지 못함',
  'command-ambiguous': '복원 명령의 옵션 자리가 애매함',
  'profile-differs': '복원 명령의 프로필이 원본과 다름',
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
    if (harness === 'claude' && now.ok && now.present.has('permission')) return {launch: hooked(command, home, warn), extra: {}};
    const origin = originalOptions(start, entries, harness);
    if (origin.ok && !origin.items.length) return {launch: hooked(command, home, warn), extra: {}};
    if (!origin.ok) return skip(origin.reason);
    if (!now.ok) return skip(`command-${now.reason}`);
    const missing = origin.items.filter(item => !now.present.has(item.group));
    if (!missing.length) return {launch: hooked(command, home, warn), extra: {}};
    // 복원 명령이 원본과 다른 프로필을 쓰면 그 프로필이 무엇을 정하는지 카단은 모른다. 옛 설정 값을 얹지 않는다.
    if (now.present.has('profile') && !sameProfile(now.items, origin.items)) return skip('profile-differs');
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
