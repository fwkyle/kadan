// kadan night picks — 밤 일감 후보 읽기. 설계: docs/daily/research/2026-11-02_나이트-모드-단계화.md 6절.
// 읽기만 한다: TODO 파일·카드·원장에 쓰지 않는다. 형식만 보고(의미 판단은 슈퍼감독 몫) 흐린 항목을 이유와 함께 걸러 낸다.
import fs from 'node:fs';
import path from 'node:path';
import {CardStore} from './card-store.mjs';

const ITEM = /^- \[([ xX])\] \*\*(.+?)\*\*(.*)$/;
const TAG = /^\s*\[(밤 허용 후보|밤 허용)\]/;
// CommonMark 울타리: 여는 줄은 들여쓰기 3칸 이하, 백틱·물결 3개 이상(백틱 울타리의 안내 글에는 백틱이 없어야 한다).
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
// 닫는 줄: 같은 글자, 여는 줄보다 짧지 않은 길이, 뒤에는 공백만.
const closesFence = (line, open) => {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return Boolean(m) && m[1][0] === open[0] && m[1].length >= open.length;
};
const openFence = line => {
  const m = FENCE_OPEN.exec(line);
  return m && !(m[1][0] === '`' && m[2].includes('`')) ? m[1] : null;
};
const plain = text => text.replaceAll('*', '');

// 항목 하나의 형식 검사. 걸린 이유를 모두 모은다(없으면 일감).
function skipReasons(item) {
  const reasons = [];
  const body = plain([item.rest, ...item.sub].join('\n'));
  const sub = plain(item.sub.join('\n'));
  if (!/Why\s*:/.test(body)) reasons.push('Why: 없음');
  if (!/확인(?: 방법)?\s*:/.test(sub)) reasons.push('확인: 없음(끝났는지 보는 방법)');
  if (/나중에 검토|카드 아님/.test(item.section)) reasons.push(`구역 "${item.section}"은 일감 구역이 아님`);
  if (/확인할 것\s*:/.test(sub)) reasons.push('확인할 것: 열린 질문 있음');
  if (/시작 조건\s*:/.test(sub)) reasons.push('시작 조건 있음, 슈퍼감독이 확인');
  return reasons;
}

// TODO 글 하나를 읽어 열린(`- [ ]`) 태그 항목만 돌려준다. 코드 울타리 안의 줄은 예시라서 건너뛴다(닫히지 않으면 파일 끝까지).
export function parseTodoItems(text, file) {
  const lines = text.split('\n');
  const items = [];
  let section = '', current = null, fence = null;
  lines.forEach((line, index) => {
    if (fence) { if (closesFence(line, fence)) fence = null; return; }
    const opened = openFence(line);
    if (opened) { fence = opened; current = null; return; }
    if (/^## /.test(line)) { section = line.slice(3).trim(); current = null; return; }
    const m = ITEM.exec(line);
    if (m) {
      const tag = TAG.exec(m[3]);
      current = m[1] === ' ' && tag ? {file, line: index + 1, title: m[2].trim(), tag: tag[1], section, rest: m[3].slice(tag[0].length), sub: []} : null;
      if (current) items.push(current);
      return;
    }
    if (current && /^\s+\S/.test(line)) current.sub.push(line.trim());
    else if (line.trim() !== '') current = null;
  });
  return items;
}

// 미배정 ready 카드: 상태가 ready이고 배정(role)이 없는 것. 키·제목·저장소만 보인다.
function readyCards(home) {
  return new CardStore(home).listSummaries()
    .filter(c => c.status === 'ready' && !c.role)
    .map(c => ({key: c.key, title: c.title, repo: c.repo}));
}

export function collectPicks({todos, home, readFile = file => fs.readFileSync(file, 'utf8')}) {
  const result = {picks: [], skipped: [], candidates: [], readyCards: [], unreadable: []};
  for (const file of todos) {
    let text;
    try { text = readFile(file); } catch (error) { result.unreadable.push({file, reason: String(error.code ?? error.message).slice(0, 80)}); continue; }
    for (const item of parseTodoItems(text, file)) {
      const base = {file, line: item.line, title: item.title};
      if (item.tag === '밤 허용 후보') { result.candidates.push(base); continue; }
      const reasons = skipReasons(item);
      if (reasons.length) result.skipped.push({...base, reasons}); else result.picks.push(base);
    }
  }
  result.readyCards = readyCards(home);
  return result;
}

export function formatPicks(r) {
  const row = x => `  ${x.file}:${x.line} ${x.title}`;
  const section = (head, rows, empty = '  (없음)') => [head, ...(rows.length ? rows : [empty])];
  return [
    '읽기 전용, 쓰지 않음(TODO 파일·카드·원장). 크기·금지 목록·kyle 결정 선행 여부는 슈퍼감독이 판단합니다.',
    ...section(`(가) 밤 일감 후보 ${r.picks.length}건`, r.picks.map(row)),
    ...section(`(나) 흐려서 건너뜀 ${r.skipped.length}건`, r.skipped.map(x => `${row(x)} — ${x.reasons.join('; ')}`)),
    ...section(`(다) [밤 허용 후보] ${r.candidates.length}건 (아침에 kyle이 볼 것, 밤 일감 아님)`, r.candidates.map(row)),
    ...section(`(라) 미배정 ready 카드 ${r.readyCards.length}건`, r.readyCards.map(c => `  ${c.key} ${c.title} (${c.repo})`)),
    ...(r.unreadable.length ? section(`읽지 못함 ${r.unreadable.length}건`, r.unreadable.map(u => `  ${u.file} — ${u.reason}`)) : []),
  ].join('\n');
}

// 인자 검사 포함. `--todo`가 없거나 절대경로가 아니면 종료 코드 2.
export function picksCommand(flags, {home, deps = {}}) {
  const raw = flags.todo === undefined ? [] : Array.isArray(flags.todo) ? flags.todo : [flags.todo];
  const usage = 'kadan night picks --todo <절대경로> [--todo …] [--json]';
  if (!raw.length || raw.some(v => typeof v !== 'string' || !v)) throw Object.assign(new Error(`--todo가 필요합니다(TODO 파일 절대경로). ${usage}`), {exitCode: 2});
  const relative = raw.find(v => !path.isAbsolute(v));
  if (relative) throw Object.assign(new Error(`--todo는 절대경로여야 합니다: ${relative}. ${usage}`), {exitCode: 2});
  const result = collectPicks({todos: raw, home, readFile: deps.readFile});
  return flags.json === true ? result : formatPicks(result);
}
