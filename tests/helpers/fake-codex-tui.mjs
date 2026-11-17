// 가짜 codex 대화형 화면 — 모델·네트워크 없음. 시험이 준 계획 파일(FAKE_CODEX_PLAN)대로 화면을 그리고, 받은 키를 모두 적는다.
// 화면 모양은 codex 0.166 `--no-alt-screen` 실제 화면을 따랐다: 빈 입력칸 `› Ask Codex to do anything`(흐린 글) + 빈 줄 + 상태 줄,
// 일하는 표시 `• Working (3s • esc to interrupt)`는 입력칸 위, `/mcp` 출력은 화면에 한 번 찍히고 입력칸으로 돌아온다.
// 계획: {log, default: {...}, models: {<모델>: {...}}}. 칸은 아래 DEFAULTS를 본다. MCP 이름은 모두 가짜다.
import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  startup: 'composer',        // composer | update(업데이트 선택 창) | choice(번호 선택 창) | exit(바로 죽음)
  mcp: [['codex_worktrees', 'connected', 3], ['fixture-a', 'connected', 1]],
  mcpTail: true,              // false면 끝줄 없이 잘린 출력
  mcpRaw: null,               // 서버 줄 대신 찍을 줄들(모르는 모양 시험)
  afterPaste: null,           // 'update': 붙여넣기를 받은 직후 업데이트 선택 창으로 바뀐다
  afterPasteOn: 'ask',        // mcp | ask — 어느 붙여넣기에서 바뀌는가
  answer: 'ok',               // ok | marker-only | marker-twice | none | partial | working-forever | instant | limit | capacity
                              // | limit-in-answer | exit | big | symlink
  workMs: 1200,
};

const arg = name => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : null; };
const model = arg('--model') ?? 'unknown';
const plan = JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_PLAN, 'utf8'));
const cfg = () => {
  const now = JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_PLAN, 'utf8'));
  return {...DEFAULTS, ...now.default, ...now.models?.[model]};
};
const logDir = plan.log;
const note = (file, value) => fs.appendFileSync(path.join(logDir, `${model}.${file}`), JSON.stringify(value) + '\n');
fs.writeFileSync(path.join(logDir, `${model}.env.json`), JSON.stringify({
  KADAN_ROLE: process.env.KADAN_ROLE ?? null, TMUX: process.env.TMUX ?? null, TMUX_PANE: process.env.TMUX_PANE ?? null,
  KADAN_HOME: process.env.KADAN_HOME ?? null, argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid}));
if (cfg().startup === 'exit') { process.stdout.write('Error: invalid transport\r\n'); process.exit(1); }

const STATUS = `  ${model} low · ~/fake/out`;
const UPDATE = ['', '  Update available · 0.0.1 → 0.0.2', '  Release notes: https://example.invalid/releases', '',
  '› 1. Update now (runs `npm install -g fake-codex`)', '  2. Skip', '  3. Skip until next version', '', '  enter continue · esc skip'];
const CHOICE = ['', '  Update Model Permissions', '', '› 1. Ask for approval  Read and edit workspace files', '  2. Full Access',
  '  3. Read Only', '', '  enter select · esc back'];
let text = '', overlay = null, workingSince = null, bottom = 0, pasting = false;

function area() {
  if (overlay) return overlay;
  const composer = text ? `› ${text}` : '› \x1b[2mAsk Codex to do anything\x1b[0m';
  const work = workingSince == null ? [] : ['', `• Working (${Math.floor((Date.now() - workingSince) / 1000)}s • esc to interrupt)`, ''];
  return [...work, '', composer, '', STATUS];
}
// 줄 끝에 붙는 화면처럼 아래 영역(입력칸·상태 줄)만 지우고 새 줄을 찍은 뒤 다시 그린다.
function render(lines = []) {
  let out = bottom ? `\x1b[${bottom}A\r\x1b[J` : '';
  for (const line of lines) out += line + '\r\n';
  const now = area();
  out += now.join('\r\n') + '\r\n';
  bottom = now.length;
  process.stdout.write(out);
}

function markerFromInput() {
  const input = fs.readFileSync(path.resolve('..', 'input.txt'), 'utf8');
  const parts = /끝 표지 조각: "([^"]+)" "([^"]+)" "([^"]+)"/u.exec(input);
  return parts ? parts.slice(1).join('') : 'NO-MARKER-FOUND';
}

function finish(lines) { workingSince = null; render(lines); }
function answer() {
  const c = cfg();
  const marker = markerFromInput();
  const write = body => fs.writeFileSync('result.txt', body);
  const good = `결론: 가짜 답이다\n근거: input.txt를 읽었다\n${marker}\n`;
  if (c.answer === 'exit') process.exit(1);
  if (c.answer === 'instant') { write(good); render(['• 끝', '']); return; }
  if (c.answer === 'limit' || c.answer === 'capacity') {
    const line = c.answer === 'limit' ? "■ You've hit your usage limit. Upgrade or try again later."
      : '■ Selected model is at capacity. Please try a different model.';
    workingSince = Date.now(); render();
    setTimeout(() => finish([line, '']), c.workMs);
    return;
  }
  workingSince = Date.now(); render();
  const tick = setInterval(() => { if (workingSince != null) render(); }, 200);
  if (c.answer === 'working-forever') { write(good); return; }
  setTimeout(() => {
    clearInterval(tick);
    if (c.answer === 'ok') write(good);
    else if (c.answer === 'marker-only') write(`${marker}\n`);
    else if (c.answer === 'marker-twice') write(`결론: 첫 답\n${marker}\n결론: 둘째 답\n${marker}\n`);
    else if (c.answer === 'partial') write('결론: 아직 쓰는 중\n근거: ');
    else if (c.answer === 'limit-in-answer') write(`결론: usage limit 과 429 낱말은 답의 일부다\n근거: rate limit 문서\n${marker}\r\n\r\n`);
    else if (c.answer === 'big') write('가'.repeat(100_000) + `\n${marker}\n`);
    else if (c.answer === 'symlink') { fs.writeFileSync('real.txt', good); fs.symlinkSync('real.txt', 'result.txt'); }
    const said = c.answer === 'limit-in-answer' ? ["• 답에 usage limit 과 429 Too Many Requests 낱말이 있다", ''] : ['• 끝', ''];
    finish(said);
  }, c.workMs);
}

function submit() {
  const line = text; text = '';
  note('submitted', line);
  if (line === '/mcp') {
    const c = cfg();
    const rows = c.mcpRaw ?? c.mcp.map(([name, state, tools]) => `  • ${name}: ${state} (${tools} tool${tools === 1 ? '' : 's'})`);
    render(['/mcp', '', '🔌  MCP Tools', '', ...rows, '', ...(c.mcpTail ? ['  Use /mcp verbose for tools and resources.', ''] : [])]);
    return;
  }
  render([`› ${line}`, '']);
  answer();
}

process.stdout.write('\x1b[?2004h');
render(['', `  >_ OpenAI Codex (v0.0.0-fake)`, `     ~/fake/out`, '']);
{
  const c = cfg();
  if (c.startup === 'update') { render(['› Ask Codex to do anything', '']); overlay = UPDATE; render(); }
  if (c.startup === 'choice') { overlay = CHOICE; render(); }
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
      const c = cfg();
      const kind = text === '/mcp' ? 'mcp' : 'ask';
      if (c.afterPaste === 'update' && c.afterPasteOn === kind) { render(['› Ask Codex to do anything', '']); overlay = UPDATE; }
      render();
      continue;
    }
    const char = rest[0]; rest = rest.slice(1);
    if (char === '\r' && !pasting) {
      if (overlay) { note('overlay-enter', true); render(['Updating fake codex...', '']); continue; }
      submit();
    } else if (char === '\x1b') note('esc', true);
    else if (char >= ' ') text += char;
  }
  if (!pasting && !overlay) render();
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGHUP', () => process.exit(0));
