import test from 'node:test';
import assert from 'node:assert/strict';
import {LIMIT_PATTERN} from '../src/senior.mjs';
import {SCREEN_LIMIT_PATTERN, composerHolds, composerReady, gateVerdict, limitScreen, markerOf, markerParts, parseAllowList,
  readAnswerText, readComposer, readMcpBlock} from '../src/senior-screen.mjs';

// 시니어 대화형 화면 판정(순수 함수). 화면 모양은 codex 0.166 `--no-alt-screen` 실제 화면의 줄 배치를 따랐다(이름·경로는 가짜).
const STATUS = '  GPT-Fake low · ~/fake/advice/ask/1-codex/out  ⚠ 2 warnings · f2 to view';
const BANNER = ['', '  >_ OpenAI Codex (v0.0.0)', '     ~/fake/advice/ask/1-codex/out', ''];
const screen = (...lines) => lines.flat().join('\n') + '\n\n\n';
const IDLE = screen(BANNER, '› Ask Codex to do anything', '', STATUS);
const IDLE_NO_GHOST = screen(BANNER, '›', '', STATUS);
// 업데이트 선택 창: 옛 빈 입력칸이 위에 남아 있고, 기본 선택이 전역 업데이트다(2026-11-17 Enter가 들어가 업데이트가 시작됐다).
const UPDATE = screen(BANNER, '', '› Ask Codex to do anything', '', '', '', '  Update available · 0.0.1 → 0.0.2',
  '  Release notes: https://example.invalid/releases', '', '› 1. Update now (runs `npm install -g fake-codex`)', '  2. Skip',
  '  3. Skip until next version', '', '  enter continue · esc skip');
const PERMISSIONS = screen(BANNER, '  Update Model Permissions', '', '› 1. Ask for approval  Read and edit workspace files', '  2. Approve for me',
  '  3. Full Access', '', '  enter select · esc back');
const WARNINGS = screen(BANNER, '› Ask Codex to do anything', '', '  Warnings · 1 of 1 · Startup', '', '  Running without the shared background server',
  '', '  k keep & next · esc dismiss & close · ⌃o copy · ←/→ warning');
const WORKING = screen(BANNER, '› ../input.txt 를 끝까지 읽고 거기 적힌 대로 수행하라.', '', '', '• Working (6s • esc to interrupt)', '', '',
  '› Ask Codex to do anything', '', STATUS);
// 슬래시 명령을 넣으면 명령 목록이 입력칸 위에 뜬다(입력칸은 여전히 마지막 `›` 줄이다).
const SLASH = screen(BANNER, '', '› /mcp           list configured MCP tools', '', '› /mcp', '', STATUS);
const MCP = (rows, {tail = true} = {}) => screen(BANNER, '/mcp', '', '🔌  MCP Tools', '', rows, '',
  tail ? ['  Use /mcp verbose for tools and resources.', ''] : [], '', '› Ask Codex to do anything', '', STATUS);

test('빈 입력칸 판정(붙여넣기 직전): 빈 입력칸이 화면 끝에 있을 때만 통과하고 선택 창·일하는 표시·글이 든 입력칸은 거절한다', () => {
  assert.deepEqual(composerReady(IDLE), {ok: true});
  assert.deepEqual(composerReady(IDLE_NO_GHOST), {ok: true});
  assert.equal(composerReady(UPDATE).ok, false, '옛 빈 입력칸이 위에 남아 있어도 업데이트 선택 창은 거절한다');
  assert.equal(composerReady(PERMISSIONS).ok, false);
  assert.equal(composerReady(WARNINGS).ok, false);
  assert.deepEqual(composerReady(WORKING), {ok: false, why: 'working'});
  assert.deepEqual(composerReady(SLASH), {ok: false, why: 'composer-has-text'});
  assert.deepEqual(composerReady(''), {ok: false, why: 'no-composer'});
  assert.deepEqual(composerReady(screen(BANNER, 'Updating fake codex...')), {ok: false, why: 'no-composer'});
  // 입력칸 아래에 번호 선택지·키 안내·다른 기호 줄이 있으면 빈 입력칸으로 보지 않는다.
  for (const below of ['  1. Yes', '  enter continue · esc skip', '› 2. No', 'plain text at column 0', '• Working (1s • esc to interrupt)']) {
    assert.equal(composerReady(screen(BANNER, '› Ask Codex to do anything', '', below)).ok, false, below);
  }
  assert.equal(composerReady(screen(BANNER, '› Ask Codex to do anything', '', STATUS, '  second footer', '  third footer')).ok, false);
});

test('자기 한 줄 판정(Enter 직전): 입력칸의 글이 방금 붙인 줄과 같을 때만 통과한다(감긴 줄·공백 차이는 같은 것으로 본다)', () => {
  const line = '../input.txt 를 끝까지 읽고 거기 적힌 대로 수행하라.';
  const held = screen(BANNER, `› ${line}`, '', STATUS);
  assert.deepEqual(composerHolds(held, line), {ok: true});
  assert.deepEqual(composerHolds(SLASH, '/mcp'), {ok: true}, '슬래시 명령 목록이 위에 떠 있어도 입력칸의 글이 자기 줄이면 통과');
  assert.deepEqual(composerHolds(screen(BANNER, '› ../input.txt 를 끝까지 읽고', '  거기 적힌 대로 수행하라.', '', STATUS), line), {ok: true});
  assert.equal(composerHolds(IDLE, line).ok, false, '빈 입력칸은 자기 줄이 아니다');
  assert.equal(composerHolds(held, '/mcp').ok, false);
  assert.equal(composerHolds(UPDATE, line).ok, false);
  assert.equal(composerHolds(UPDATE, '1. Update now (runs `npm install -g fake-codex`) 2. Skip 3. Skip until next version').ok, false,
    '선택 창의 글과 우연히 같아도 아래에 키 안내가 있으면 거절한다');
  assert.equal(composerHolds(screen(BANNER, `› ${line} 사람이 덧붙인 글`, '', STATUS), line).ok, false);
  assert.equal(composerHolds(held, '').ok, false);
  assert.deepEqual(readComposer(held).text, line);
});

test('/mcp 구간: 메아리·머리줄·끝줄이 다 있고 입력칸으로 돌아왔을 때만 연결된 이름 전부로 읽는다', () => {
  const full = MCP(['  • codex_worktrees: connected (3 tools)', '  • fixture-a: connected (1 tool)', '  • fixture-off: disabled (0 tools)']);
  assert.deepEqual(readMcpBlock(full), {ok: true, connected: ['codex_worktrees', 'fixture-a'], disabled: ['fixture-off']});
  assert.deepEqual(readMcpBlock(MCP(['  • codex_worktrees: connected (3 tools)'], {tail: false})), {ok: false, why: 'mcp-incomplete'});
  assert.deepEqual(readMcpBlock(MCP(['  • fixture-a: starting'])), {ok: false, why: 'mcp-pending', pending: 'fixture-a'});
  assert.deepEqual(readMcpBlock(MCP(['  • fixture-a: connected (1 tool)', '  뭔가 다른 줄'])), {ok: false, why: 'mcp-unreadable'});
  assert.deepEqual(readMcpBlock(IDLE), {ok: false, why: 'mcp-not-shown'});
  assert.deepEqual(readMcpBlock(SLASH), {ok: false, why: 'mcp-not-shown'}, '입력칸에 든 /mcp는 출력이 아니다');
  // 끝줄 뒤가 입력칸이 아니면(다른 창이 떠 있으면) 완전한 구간으로 보지 않는다.
  const noComposer = screen(BANNER, '/mcp', '', '🔌  MCP Tools', '', '  • fixture-a: connected (1 tool)', '', '  Use /mcp verbose for tools and resources.');
  assert.deepEqual(readMcpBlock(noComposer), {ok: false, why: 'mcp-incomplete'});
  // 마지막 /mcp 출력만 본다(스크롤 기록의 옛 출력은 근거가 아니다).
  const twice = full.trimEnd() + '\n' + MCP(['  • fixture-b: connected (2 tools)']);
  assert.deepEqual(readMcpBlock(twice).connected, ['fixture-b']);
});

test('허용 목록: 연결된 이름이 모두 목록 안일 때만 통과한다. 파일이 없으면(null) 거절한다', () => {
  const allow = parseAllowList('# 주석\ncodex_worktrees\n\n  fixture-a  \nfixture-b\n');
  assert.deepEqual([...allow], ['codex_worktrees', 'fixture-a', 'fixture-b']);
  assert.deepEqual(gateVerdict(['codex_worktrees', 'fixture-a'], allow), {ok: true});
  assert.deepEqual(gateVerdict([], allow), {ok: true});
  assert.deepEqual(gateVerdict(['codex_worktrees', 'fixture-x'], allow), {ok: false, why: 'not-allowed', outside: ['fixture-x']});
  assert.deepEqual(gateVerdict(['codex_worktrees'], null), {ok: false, why: 'allow-missing', outside: ['codex_worktrees']});
  assert.deepEqual(gateVerdict(['codex_worktrees'], parseAllowList('')), {ok: false, why: 'not-allowed', outside: ['codex_worktrees']});
});

test('답 파일: 마지막 줄이 표지이고 표지가 한 번이며 표지 뗀 답이 비어 있지 않을 때만 답이다. 줄끝은 정규화한다', () => {
  const marker = markerOf('0a1b2c3d');
  assert.equal(marker, 'KADAN-SENIOR-END-0a1b2c3d');
  assert.deepEqual(markerParts('0a1b2c3d'), ['KADAN-SENIOR', '-END-', '0a1b2c3d']);
  assert.deepEqual(readAnswerText(`결론: 답\n근거: 줄\n${marker}\n`, marker), {ok: true, answer: '결론: 답\n근거: 줄'});
  assert.deepEqual(readAnswerText(`결론: 답\r\n근거: 줄\r\n\r\n${marker}\r\n\r\n`, marker), {ok: true, answer: '결론: 답\n근거: 줄'});
  assert.deepEqual(readAnswerText(`${marker}\n`, marker), {ok: false, why: 'marker-only'});
  assert.deepEqual(readAnswerText(`  \n\n${marker}`, marker), {ok: false, why: 'marker-only'});
  assert.deepEqual(readAnswerText(`답\n${marker}\n답 2\n${marker}\n`, marker), {ok: false, why: 'marker-repeated'});
  assert.deepEqual(readAnswerText(`답 안에 ${marker} 가 있다\n${marker}\n`, marker), {ok: false, why: 'marker-repeated'});
  assert.deepEqual(readAnswerText('결론: 아직 쓰는 중\n', marker), {ok: false, why: 'no-marker'});
  assert.deepEqual(readAnswerText(`답\n${marker}\n뒤에 더 씀\n`, marker), {ok: false, why: 'no-marker'});
  assert.deepEqual(readAnswerText(`답\n${markerOf('ffffffff')}\n`, marker), {ok: false, why: 'no-marker'}, '다른 호출의 표지는 표지가 아니다');
  assert.deepEqual(readAnswerText('', marker), {ok: false, why: 'no-marker'});
});

test('한도 화면: 입력칸 바로 위 오류 덩어리의 한도 낱말만 한도다. 답 본문의 낱말·일하는 화면은 한도가 아니다', () => {
  assert.equal(SCREEN_LIMIT_PATTERN.source, `${LIMIT_PATTERN.source}|at capacity`);
  const errorScreen = line => screen(BANNER, '› 질문', '', line, '', '› Ask Codex to do anything', '', STATUS);
  assert.equal(limitScreen(errorScreen("■ You've hit your usage limit. Upgrade or try again later."), 0), true);
  assert.equal(limitScreen(errorScreen('■ Selected model is at capacity. Please try a different model.'), 0), true);
  assert.equal(limitScreen(errorScreen('■ exceeded retry limit, last status: 429 Too Many Requests'), 0), true);
  assert.equal(limitScreen(errorScreen('■ Stream disconnected before completion'), 0), false, '한도 낱말이 없는 오류는 한도가 아니다');
  assert.equal(limitScreen(errorScreen('• 답에 usage limit 과 429 Too Many Requests 낱말이 있다'), 0), false);
  assert.equal(limitScreen(IDLE, 0), false);
  assert.equal(limitScreen(WORKING, 0), false);
});
