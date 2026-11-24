// kadan agy accounts 본체 — 떠 있는 agy 프로세스마다 어디서 어떤 계정으로 돌고 있는지 보이고,
// 지금 새로 띄우면 어느 계정이 뜰지(저장소를 마지막으로 덮은 계정)를 추정해 보인다. 읽기만 한다(agy를 띄우지 않는다).
// 모든 바깥 조회(ps·lsof·tmux·로티·로그·화면)는 deps로 받는다 — 시험은 가짜 deps로 닫기·안 닫기까지 확인한다.
// 계정은 이 모듈 안에서만 전체 글자로 다루고, 출력에는 앞 몇 글자만 낸다.
import path from 'node:path';
import {agyQuotaLine} from './watch-stop-phrases.mjs';

const WORKING_HINT = 'esc to cancel';
const IDLE_HINT = '? for shortcuts';
export const LOG_PATH = /antigravity-cli\/log\/(cli-\d{8}_\d{6}\.log)$/u;
const START_PAIR_MS = 2000;
const RECENT_LOG_MS = 48 * 3600_000;
const OVERDUE_MS = 10 * 60_000;

// 화면 아래쪽에서 상태를 읽는다: 한도로 멈춤 > 작업 중 > 대기 > 모름. 화면을 못 읽으면 모름.
export function screenStatus(screen) {
  if (typeof screen !== 'string' || !screen.trim()) return '모름';
  const lines = screen.split('\n').map(line => line.replace(/\s+$/u, '')).filter(Boolean).slice(-20);
  // 한도 판정은 감시기와 같은 규칙을 쓴다(입력 상자 바로 위의 `⚠ Individual quota reached. … Resets in …` 한 줄만).
  if (agyQuotaLine(screen)) return '한도로 멈춤';
  const footer = lines.at(-1) ?? '';
  if (footer.includes(WORKING_HINT)) return '작업 중';
  if (footer.includes(IDLE_HINT)) return '대기';
  return '모름';
}

// 목표 글자는 계정 글자 안에 들어 있으면 맞는 것이다(대소문자 무시).
const matches = (account, target) => account != null && account.toLowerCase().includes(target.toLowerCase());

// 보여 줄 앞 글자: 관측한 계정들이 서로 구분될 때까지만 늘린다(3글자부터 시작, 최대 아이디 전체).
export function makeMasker(accounts) {
  const list = [...new Set(accounts.filter(Boolean))];
  const local = account => account.split('@')[0];
  let width = 3;
  const max = Math.max(3, ...list.map(account => local(account).length));
  while (width < max && new Set(list.map(account => local(account).slice(0, width))).size < list.length) width++;
  return account => account == null ? '모름' : `${local(account).slice(0, width)}…`;
}

const pad2 = n => String(n).padStart(2, '0');
export function fmtTime(ms, nowMs) {
  const d = new Date(ms), n = new Date(nowMs);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return d.toDateString() === n.toDateString() ? hm : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
}

// 프로세스의 조상 사슬(자기 포함). 순환·너무 긴 사슬은 끊는다.
function lineage(pid, byPid) {
  const out = [];
  const seen = new Set();
  let cur = byPid.get(pid);
  while (cur && !seen.has(cur.pid) && out.length < 64) {
    seen.add(cur.pid);
    out.push(cur.pid);
    cur = byPid.get(cur.ppid);
  }
  return out;
}

// 프로세스 ↔ 로그 짝짓기: lsof가 보여 준 로그가 정확히 하나면 그것(방법 lsof). 아니면 시작 시각(파일 이름의 시각)으로 짝짓되,
// 후보가 정확히 하나이고 그 로그를 다른 프로세스가 쓰지 않을 때만 인정한다(방법 시각). 그 밖은 모름(추측하지 않는다).
export function pairLogs(agy, {openLogs, logs}) {
  const namesOf = pid => [...new Set((openLogs.get(pid) ?? []).map(file => LOG_PATH.exec(file)?.[1]).filter(Boolean))];
  const claimed = new Map(); // 로그 이름 → lsof로 그 로그를 연 프로세스들
  for (const proc of agy) for (const name of namesOf(proc.pid)) claimed.set(name, [...(claimed.get(name) ?? []), proc.pid]);
  const result = new Map();
  for (const proc of agy) {
    const names = namesOf(proc.pid);
    if (names.length === 1 && claimed.get(names[0]).length === 1) { result.set(proc.pid, {name: names[0], by: 'lsof'}); continue; }
    if (names.length === 1) { result.set(proc.pid, {name: null, by: null, why: '같은 로그를 여럿이 열고 있음'}); continue; }
    if (names.length > 1) { result.set(proc.pid, {name: null, by: null, why: '로그가 둘 이상 열려 있음'}); continue; }
    const near = logs.filter(log => Math.abs(log.startMs - proc.startMs) <= START_PAIR_MS && !claimed.has(log.name));
    const rivals = agy.filter(other => other.pid !== proc.pid && !namesOf(other.pid).length && Math.abs(other.startMs - proc.startMs) <= START_PAIR_MS);
    if (near.length === 1 && !rivals.length) result.set(proc.pid, {name: near[0].name, by: '시각'});
    else result.set(proc.pid, {name: null, by: null, why: near.length > 1 || rivals.length ? '같은 시각 후보가 여럿' : '짝이 되는 로그를 못 찾음'});
  }
  return result;
}

// 어디서 도는가: 조상 사슬로 정한다. 카단 역할 세션 > 시니어 창 > 로티 탭 > 그 밖.
function classify(chain, {rolePanes, seniorPanes, rottieTabs}) {
  const role = rolePanes.find(pane => chain.includes(String(pane.panePid)));
  if (role) return {kind: 'role', session: role.session, label: `카단 역할 ${role.session}`};
  const senior = seniorPanes.find(pane => chain.includes(String(pane.panePid)));
  if (senior) return {kind: 'senior', session: senior.session, label: `시니어 창 ${senior.session}`};
  const tab = rottieTabs.find(item => chain.includes(String(item.pid)));
  if (tab) return {kind: 'rottie', label: `로티 탭 ${[tab.title, tab.cwd].filter(Boolean).join(' ') || '(이름 없음)'}`};
  return {kind: 'other', label: '그 밖'};
}

// 한 번 훑는다. 반환: {rows, overwrite, next, logsReadable}
//  rows[]   — {pid, startMs, where, account(전체 글자|null), status, pairedBy, logName, expiryMs}
//  overwrite — 저장소를 마지막으로 덮은 사건 {atMs, kind, account} | null (끝난 프로세스의 로그도 센다)
//  next     — 다음 덮어쓰기 예정 {atMs, pid, account} | null (살아 있는 프로세스의 토큰 만료 시각 중 가장 이른 것)
export function collectAgy(deps) {
  const nowMs = deps.now();
  const procs = deps.listProcesses();
  const byPid = new Map(procs.map(proc => [proc.pid, proc]));
  const agy = procs.filter(proc => path.basename(proc.comm) === 'agy').sort((a, b) => a.startMs - b.startMs);
  let files = [];
  let logsReadable = true;
  try { files = deps.listLogs(); } catch { logsReadable = false; }
  const logs = files.map(file => ({...file, name: path.basename(file.file), startMs: Number(file.startMs)}));
  const read = new Map();
  const info = name => {
    if (!read.has(name)) {
      const file = logs.find(log => log.name === name)?.file;
      let value = null;
      try { value = file ? deps.readLog(file) : null; } catch { value = null; }
      read.set(name, value);
    }
    return read.get(name);
  };
  const openLogs = agy.length ? deps.openLogs(agy.map(proc => proc.pid)) : new Map();
  const pairs = pairLogs(agy, {openLogs, logs});
  const rolePanes = agy.length ? deps.rolePanes() : [];
  const seniorPanes = agy.length ? deps.seniorPanes() : [];
  const rottieTabs = agy.length ? deps.rottieTabs() : [];
  const rows = agy.map(proc => {
    const where = classify(lineage(proc.pid, byPid), {rolePanes, seniorPanes, rottieTabs});
    const pair = pairs.get(proc.pid);
    const log = pair?.name ? info(pair.name) : null;
    return {pid: proc.pid, startMs: proc.startMs, where, account: log?.account ?? null, logName: pair?.name ?? null,
      pairedBy: pair?.by ?? null, pairWhy: pair?.why ?? null, expiryMs: log?.expiryMs ?? null,
      status: where.kind === 'role' ? screenStatus(deps.readScreen(where.session)) : '모름'};
  });
  // 저장소를 마지막으로 덮은 사건: 최근 로그(끝난 프로세스의 것 포함)의 마지막 덮어쓰기 중 가장 늦은 것.
  let overwrite = null;
  for (const log of logs.filter(item => nowMs - item.mtimeMs <= RECENT_LOG_MS)) {
    const value = info(log.name)?.lastWrite;
    if (value?.atMs != null && value.account != null && (!overwrite || value.atMs > overwrite.atMs)) overwrite = {atMs: value.atMs, kind: value.kind, account: value.account};
  }
  // 다음 덮어쓰기: 살아 있는 프로세스가 쥔 토큰의 만료 시각(갱신은 만료보다 0.5~4분 뒤에 찍혔다). 한참 지난 것은 건너뛴다.
  const due = rows.filter(row => row.expiryMs != null && row.expiryMs >= nowMs - OVERDUE_MS).sort((a, b) => a.expiryMs - b.expiryMs)[0];
  const next = due ? {atMs: due.expiryMs, pid: due.pid, account: due.account} : null;
  return {rows, overwrite, next, logsReadable, nowMs};
}

// 목표 글자가 관측된 계정(살아 있는 프로세스의 계정)과 정확히 하나만 맞는지. 반환: {ok, account?|why, count}
export function resolveTarget(target, rows) {
  const observed = [...new Set(rows.map(row => row.account).filter(Boolean))];
  const hit = observed.filter(account => matches(account, target));
  if (hit.length === 1) return {ok: true, account: hit[0], observed};
  return {ok: false, count: hit.length, observed};
}

// 화면에 낼 글. target이 있으면 같음/다름을 붙인다.
export function formatReport(report, {target = null, close = null} = {}) {
  const {rows, overwrite, next, logsReadable, nowMs} = report;
  const mask = makeMasker([...rows.map(row => row.account), overwrite?.account, next?.account]);
  const tag = account => !target || account == null ? '' : matches(account, target) ? ' (목표와 같음)' : ' (목표와 다름)';
  const lines = [];
  if (!rows.length) lines.push('떠 있는 agy 없음');
  else {
    lines.push(`떠 있는 agy ${rows.length}개`);
    lines.push(['PID', '시작', '어디', '계정', '상태', '로그 짝'].join('\t'));
    for (const row of rows) {
      lines.push([row.pid, fmtTime(row.startMs, nowMs), row.where.label, `${mask(row.account)}${tag(row.account)}`, row.status,
        row.pairedBy ?? `모름(${row.pairWhy ?? '이유 모름'})`].join('\t'));
    }
  }
  if (overwrite) {
    lines.push(`지금 새로 띄우면 뜰 계정(추정): ${mask(overwrite.account)}${tag(overwrite.account)} — 저장소를 마지막으로 덮은 것: ` +
      `${fmtTime(overwrite.atMs, nowMs)} ${overwrite.kind === 'refreshed' ? '토큰 갱신' : '브라우저 로그인'}`);
  } else lines.push(`지금 새로 띄우면 뜰 계정(추정): 모름${logsReadable ? ' — 최근 로그에 덮어쓴 기록이 없음' : ' — 로그 폴더를 읽지 못함'}`);
  if (next) lines.push(`다음 갱신: 약 ${fmtTime(next.atMs, nowMs)} (PID ${next.pid}, 계정 ${mask(next.account)}${tag(next.account)})`);
  else if (rows.length) lines.push('다음 갱신: 모름(토큰 만료 시각을 읽은 프로세스가 없음)');
  if (target) {
    // 시니어 아닌 창은 닫지 않는다 — 계정이 목표와 다르면 그 창에서 직접 /login 하도록 안내만 한다.
    for (const row of rows.filter(item => item.where.kind !== 'senior' && item.account != null && !matches(item.account, target))) {
      lines.push(`PID ${row.pid} (${row.where.label}): 목표와 다른 계정 — 닫지 않는다. 그 창에서 /login`);
    }
  }
  if (close) lines.push(...close);
  return lines.join('\n');
}

// 시니어 창 닫기 계획과 실행. 목표가 관측 계정 정확히 하나일 때만 부른다(부르기 전에 resolveTarget으로 거른다).
// 목표와 다른 계정의 시니어 창 중, 끝난 호출이고 기록 대조가 맞는 것(state: kept)만 killOwn으로 닫는다.
// 진행 중(running)·기록 없음·대조 실패·계정 모름인 창은 건드리지 않고 이유를 낸다.
//  seniorStates: Map(세션 이름 → {state, why, dir}), kill(dir) → {killed, why}
export function closeSeniors(rows, {target, seniorStates, kill}) {
  const lines = [];
  for (const row of rows.filter(item => item.where.kind === 'senior')) {
    const name = row.where.session;
    if (row.account == null) { lines.push(`둠  ${name} (PID ${row.pid}) — 계정 모름`); continue; }
    if (matches(row.account, target)) continue;
    const state = seniorStates.get(name);
    if (!state) { lines.push(`둠  ${name} (PID ${row.pid}) — 세션 상태를 읽지 못함`); continue; }
    if (state.state !== 'kept') { lines.push(`둠  ${name} (PID ${row.pid}) — ${state.why === 'running' ? '진행 중인 호출' : `끝난 호출로 확인되지 않음(${state.why})`}`); continue; }
    const result = kill(state.dir);
    lines.push(result.killed ? `끔  ${name} (PID ${row.pid})` : `둠  ${name} (PID ${row.pid}) — 끄지 못함(${result.why})`);
  }
  return lines.length ? lines : ['닫을 시니어 창 없음'];
}

