// 가짜 agy 대화창 화면 — 모델·네트워크·사용자 설정 없음. 시험이 준 계획 파일(FAKE_AGY_PLAN)대로 화면을 그리고 받은 키를 모두 적는다.
// 화면 모양은 agy 1.5.10 대화창 조사(2026-11-18)를 따랐다: 폴더 신뢰 창(경로 한 줄·`> Yes, I trust this folder`·`enter Confirm`),
// 가로줄 두 개 사이의 입력칸(`>`), 바닥글(`? for shortcuts` / `esc to cancel` / 글이 들면 왼쪽이 빈다), 일하는 표시(`⣟  Generating...`),
// 답은 두 칸 들여 화면에 쓰고 그 뒤에 출처 묶음이 붙을 수 있다. 계정·경로·출처 이름은 모두 가짜다.
// 계획: {log, default: {...}, models: {<모델>: {...}}}. 칸은 아래 DEFAULTS를 본다.
import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  // trust-once: 작업 폴더가 가짜 신뢰 목록에 없을 때만 신뢰 창 | composer | trust-other(다른 경로) | trust-two(경로 두 줄)
  // | trust-no(No가 선택됨) | menu(모르는 선택 화면) | exit(바로 죽음)
  startup: 'trust-once',
  banner: false,              // 첫 기동 배너 + 입력칸 안내 글(흐리지 않게 그린다: 글이 든 것처럼 보이는 빈 칸)
  afterTrust: 'composer',     // stay: Enter를 받아도 신뢰 창이 그대로 남는다
  afterPaste: null,           // 'menu': 붙여넣기를 받은 직후 선택 화면으로 바뀐다
  // ok | long(lines줄) | sources(답 뒤 출처 묶음) | marker-only | marker-twice | marker-quoted(본문에 표지 인용 + 끝 표지)
  // | marker-inline(표지가 단독 줄이 아님) | text-after(표지 뒤 본문) | none(표지 없음) | instant(일하는 표시 없이 끝)
  // | working-forever | exit | clear(스크롤 기록을 지운 뒤 답)
  answer: 'ok',
  lines: 80,
  workMs: 1200,
  wrap: 100,                  // 입력칸·되찍은 질문 줄을 이 글자 수에서 감는다(앱이 스스로 넣는 줄바꿈)
};

const arg = name => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : null; };
const model = arg('--model') ?? 'unknown';
const plan = JSON.parse(fs.readFileSync(process.env.FAKE_AGY_PLAN, 'utf8'));
const cfg = () => {
  const now = JSON.parse(fs.readFileSync(process.env.FAKE_AGY_PLAN, 'utf8'));
  return {...DEFAULTS, ...now.default, ...now.models?.[model]};
};
const logDir = plan.log;
const note = (file, value) => fs.appendFileSync(path.join(logDir, `${model}.${file}`), JSON.stringify(value) + '\n');
fs.writeFileSync(path.join(logDir, `${model}.env.json`), JSON.stringify({
  KADAN_ROLE: process.env.KADAN_ROLE ?? null, TMUX: process.env.TMUX ?? null, TMUX_PANE: process.env.TMUX_PANE ?? null,
  KADAN_HOME: process.env.KADAN_HOME ?? null, argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid}));
if (cfg().startup === 'exit') { process.stdout.write('Error: fake agy could not start\r\n'); process.exit(1); }

const cols = process.stdout.columns || 150;
const RULE = '─'.repeat(cols);
const RIGHT = `auto · kadan-noexec (Fake Model · medium)  /agents`;
const footer = left => left + ' '.repeat(Math.max(2, cols - left.length - RIGHT.length - 1)) + RIGHT;
const PLACEHOLDER = 'Auto mode: edits & safe commands auto-approved (shift+tab to cycle)';
const BANNER = ['', '      ▄▀▀▄        Fake Antigravity CLI 0.0.0', '     ▀▀▀▀▀▀       fake-account (Fake Plan)',
  '    ▀▀▀▀▀▀▀▀      Fake Model (Medium)', '   ▄▀▀    ▀▀▄     ~/fake/senior-agy', '  ▄▀▀      ▀▀▄', ''];
const INTRO = [' ┃ Introducing Fake Model', ' ┃ A fake daily driver for tests!', ' ┃ esc to dismiss'];
const trustedFile = path.join(logDir, 'trusted.json');
const trusted = () => { try { return JSON.parse(fs.readFileSync(trustedFile, 'utf8')); } catch { return []; } };
const trustScreen = shown => ['Accessing workspace:', '', ...shown, '', 'Do you trust the contents of this project?', '',
  'Fake Antigravity CLI requires permission to read, edit, and execute files here.', '',
  ...(cfg().startup === 'trust-no' ? ['  Yes, I trust this folder', '> No, exit'] : ['> Yes, I trust this folder', '  No, exit']),
  '', '  ↑/↓ Navigate · enter Confirm', ' '.repeat(Math.max(2, cols - 40)) + 'auto · Fake Model · medium'];
const MENU = ['', '  A new version of Fake Antigravity CLI is available.', '', '> Update now', '  Skip', '',
  '  ↑/↓ Navigate · enter Confirm'];
const wrapped = (head, text) => {
  const width = cfg().wrap;
  const parts = [];
  for (let at = 0; at < text.length; at += width) parts.push(text.slice(at, at + width));
  return (parts.length ? parts : ['']).map((part, index) => (index ? '  ' : head) + part);
};

let text = '', overlay = null, working = false, bottom = 0, pasting = false, introShown = false, mode = 'start';

function area() {
  if (overlay) return overlay;
  if (working) return ['⣟  Generating...', RULE, '>', RULE, footer('esc to cancel')];
  const intro = cfg().banner && !introShown ? INTRO : [];
  if (text) return [...intro, RULE, ...wrapped('> ', text), RULE, footer('')];
  return [...intro, RULE, cfg().banner && !introShown ? `> ${PLACEHOLDER}` : '>', RULE, footer('? for shortcuts')];
}
// 아래 영역(입력칸·바닥글)만 지우고 위에 새 줄을 찍은 뒤 다시 그린다. 찍힌 줄은 스크롤 기록으로 올라간다.
function render(lines = []) {
  let out = bottom ? `\x1b[${bottom}A\r\x1b[J` : '';
  for (const line of lines) out += line + '\r\n';
  const now = area();
  out += now.join('\r\n') + '\r\n';
  bottom = now.length;
  process.stdout.write(out);
}
function openComposer() {
  overlay = null; mode = 'composer'; bottom = 0;
  process.stdout.write('\x1b[2J\x1b[H');
  render(BANNER);
}

function askFile(line) { return /: (\/\S+)$/u.exec(line)?.[1] ?? null; }
function markerFrom(line) {
  try {
    const parts = /끝 표지 조각: "([^"]+)" "([^"]+)" "([^"]+)"/u.exec(fs.readFileSync(askFile(line), 'utf8'));
    return parts ? parts.slice(1).join('') : 'NO-MARKER-FOUND';
  } catch { return 'ASK-FILE-UNREADABLE'; }
}

function answer(line) {
  const c = cfg();
  const marker = markerFrom(line);
  const body = ['  결론: 가짜 답이다', '  근거: 질문 파일을 읽었다'];
  const thought = ['', '▸ Thought for 1s, 12 tokens', ''];
  const shapes = {
    ok: [...body, '', `  ${marker}`, ''],
    long: [...Array.from({length: c.lines}, (_, index) => `  LINE-${String(index + 1).padStart(3, '0')}`), `  ${marker}`, ''],
    sources: [...body, '', `  ${marker}`, '', '  Sources:', '    ▸ source.invalid', '    ▸ source.invalid', '', '  (ctrl+o to expand)', ''],
    'marker-only': [`  ${marker}`, ''],
    'marker-twice': ['  결론: 첫 답', `  ${marker}`, '  결론: 둘째 답', `  ${marker}`, ''],
    'marker-quoted': [`  결론: 끝 표지는 ${marker} 이다`, '  근거: 본문에 표지를 인용했다', '', `  ${marker}`, ''],
    'marker-inline': ['  결론: 가짜 답이다', `  끝 ${marker}`, ''],
    'text-after': [...body, '', `  ${marker}`, '', '  덧붙임: 표지 뒤에 본문이 더 있다', ''],
    none: [...body, ''],
  };
  if (c.answer === 'exit') process.exit(1);
  if (c.answer === 'instant') { render([...thought, ...shapes.ok]); return; }
  if (c.answer === 'working-forever') return;
  setTimeout(() => {
    working = false;
    if (c.answer === 'clear') { process.stdout.write('\x1b[2J\x1b[H\x1b[3J'); bottom = 0; render([...thought, ...shapes.ok]); return; }
    render([...thought, ...(shapes[c.answer] ?? shapes.ok)]);
  }, c.workMs);
}

function submit() {
  const line = text; text = ''; introShown = true;
  note('submitted', line);
  // 되찍은 질문 줄과 일하는 표시를 한 번에 그린다(그 사이에 빈 입력칸이 보이지 않게).
  working = cfg().answer !== 'instant';
  render([RULE, ...wrapped('> ', line)]);
  answer(line);
}

process.stdout.write('\x1b[?2004h');
{
  const c = cfg();
  const cwd = process.cwd();
  const needTrust = c.startup === 'trust-once' ? !trusted().includes(cwd) : c.startup.startsWith('trust');
  if (c.startup === 'menu') { mode = 'overlay'; overlay = MENU; render(); }
  else if (needTrust) {
    mode = 'trust';
    overlay = trustScreen(c.startup === 'trust-other' ? ['/fake/other/project'] : c.startup === 'trust-two' ? [cwd, '/fake/other/project'] : [cwd]);
    render();
  } else openComposer();
}
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => {
  note('keys', data);
  let rest = data;
  while (rest.length) {
    if (rest.startsWith('\x1b[200~')) { pasting = true; rest = rest.slice(6); continue; }
    if (rest.startsWith('\x1b[201~')) {
      pasting = false; rest = rest.slice(6);
      if (cfg().afterPaste === 'menu' && mode === 'composer') { mode = 'overlay'; overlay = [RULE, ...wrapped('> ', text), RULE, ...MENU.slice(3)]; }
      render();
      continue;
    }
    const char = rest[0]; rest = rest.slice(1);
    if (char === '\r' && !pasting) {
      if (mode === 'trust') {
        note('trust-enter', overlay.find(row => row.startsWith('>')));
        if (overlay.some(row => row === '> No, exit')) process.exit(0);
        if (cfg().afterTrust === 'stay') continue;
        fs.writeFileSync(trustedFile, JSON.stringify([...new Set([...trusted(), process.cwd()])]));
        openComposer();
        continue;
      }
      if (mode === 'overlay') { note('overlay-enter', true); render(['Updating fake agy...']); continue; }
      submit();
    } else if (char === '\x1b') note('esc', true);
    else if (char >= ' ' && mode === 'composer') text += char;
  }
  if (!pasting && mode === 'composer') render();
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGHUP', () => process.exit(0));
