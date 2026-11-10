// Why: 끝난 역할 세션을 안심하고 끄려면, 끄기 직전에 그 역할이 연 대화 번호를 원장 stop 사건에 남겨야 한다
// (프로세스는 사라져도 대화는 디스크에 남는다). 찾는 방법은 `kadan restart`가 쓰는 것 하나다: 실행기 본체 사슬 +
// 설정 표의 conversation 방식. restart는 못 찾으면 끄지 않고, stop은 못 찾아도 끈다 — 그래서 여기서는 던지는 확정 함수
// (confirmPaneConversation)와, 던지지 않고 "찾음 | 못 찾음 + 정해진 이유 낱말"을 돌려주는 stop용 함수를 따로 둔다.
// 비용: 프로세스 조회 2~3번(ps·lsof)과 설정 파일 1번. 원장은 부르는 쪽이 이미 읽은 것을 받는다(추가 읽기 없음).
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {launchIdentityOf, matchesAiProcess} from './ai-identity.mjs';
import {executorChain, processTree, openFilesOf, processStartedAt} from './process-tree.mjs';
import {findConversation, checkConversationSpec} from './runner-table.mjs';
import {startDigest} from './secretary-resume.mjs';

// stop 사건의 conversationMissing에 적는 낱말. 여기 없는 값은 쓰지 않는다(오류 문장을 원장에 옮기지 않는다).
export const MISSING_REASONS = ['no-start', 'not-ai-runner', 'unsupported', 'non-tmux', 'pane-changed',
  'lookup-failed', 'timeout', 'no-executor', 'undetermined', 'session-gone', 'error'];
// 끄기가 조회 때문에 늦어지는 최대 시간. 평소 조회는 0.1~0.2초다. 부하로 ps·lsof가 늦으면 여기서 끊고 끈다.
export const STOP_LOOKUP_BUDGET_MS = 3000;

const pidOf = entry => entry?.panePid ?? entry?.rottiePid;
const reasoned = (message, reason) => Object.assign(new Error(message), {reason});

// 이 세션의 지금 세대를 실제로 띄운 start. 살아 있는 세션을 다시 연 start(같은 pane PID, 명령 없음, 부른 쪽 작업 폴더)는
// 건너뛰고 실행 명령이 있는 start까지 거슬러 간다. events는 이 세션의 사건(끄기 전까지)이다. 없으면 null.
export function launchStart(events) {
  const last = events.findLastIndex(e => e.kind === 'start');
  if (last < 0) return null;
  const pid = pidOf(events[last]);
  for (let i = last; i >= 0; i--) {
    const entry = events[i];
    if (entry.kind === 'stop') return null;
    if (entry.kind !== 'start') continue;
    if (i !== last && (pid == null || String(pidOf(entry)) !== String(pid))) return null;
    if (typeof entry.cmd === 'string' && entry.cmd.trim()) return entry;
  }
  return null;
}

// 살아 있는 세션을 다시 연 start(kadan start를 한 번 더 친 기록)에 적을 reuseOf: 그 세대를 띄운 start의 지문. 없으면 null.
// Why: 다시 연 start에는 명령·출력 기록 경로가 없어, 서로 다른 두 세대의 그런 기록이 역할·PID·작업 폴더·기록 시각까지 같으면
// 본문(=지문)이 같아진다. 그 세대를 띄운 start의 지문을 한 칸으로 품으면 세대가 다를 때 본문이 반드시 달라진다.
// 그 보장은 띄운 start의 본문이 유일할 때만 성립하므로, 출력 기록 경로(outputLog — 만들 때마다 새 UUID)가 있는 start일 때만 적는다.
// 띄운 start를 못 찾거나, 그 PID가 지금 pane PID와 다르거나, outputLog가 없으면 적지 않는다(감시기는 그런 기록으로 발령을 잇지 않는다).
// events는 부르는 쪽이 이미 읽은 원장이다(추가 읽기 없음).
export function reuseOfFor(events, session, livePid) {
  const own = events.filter(e => e.session === session);
  // 마지막 start 뒤에 stop이 적혀 있으면 원장상 꺼진 세대다. 살아 있는 pane이 그 세대인지 알 수 없으니 적지 않는다.
  if (own.slice(own.findLastIndex(e => e.kind === 'start') + 1).some(e => e.kind === 'stop')) return null;
  const start = launchStart(own);
  if (!start || livePid == null || String(pidOf(start)) !== String(livePid)) return null;
  if (typeof start.outputLog !== 'string' || !start.outputLog) return null;
  return startDigest(start);
}

// 지금 이 pane이 실제로 연 대화를 표의 방식으로 확정한다. 확정 못 하면 던진다(restart는 그 문장으로 거절한다).
// 실행기 본체 사슬(뿌리 1개 + 그 아래로 하나씩 이어지는 맞는 프로세스)이 연 파일만 후보다. 자식 도구나 같은 실행기의
// 하위 에이전트가 연 대화를 집지 않는다. pid-json은 뿌리 본체의 PID 파일만, open-file은 사슬 전체가 연 파일을 본다.
export function confirmPaneConversation({session, start, harness, model, spec, deps}) {
  const pane = deps.paneInfo(session);
  if (String(pane.panePid) !== String(start.panePid)) throw reasoned('tmux pane PID가 시작 기록과 다르다', 'pane-changed');
  const chain = executorChain(deps.processTree(start.panePid), args => matchesAiProcess(args, harness, model));
  if (!chain) throw reasoned(`${harness} 실행기 본체 프로세스를 하나의 사슬로 정할 수 없다(없거나 여러 개·갈림) — 대화 파일의 주인을 확인할 수 없어 거절한다`, 'no-executor');
  try {
    return findConversation(spec, {pids: [chain.root], openFiles: () => deps.openFiles(chain.pids),
      readJson: deps.readJson, processStartedAt: deps.processStartedAt,
      tmuxLocation: pane.location, homeDir: deps.homeDir, exists: deps.exists});
  } catch (error) {
    if (error && typeof error === 'object' && !error.reason) error.reason = 'undetermined';
    throw error;
  }
}

// 남은 시간만큼만 기다리는 프로세스 실행기. 상한을 넘기면 timedOut을 켜고 던진다.
// process-tree.mjs의 조회 함수들이 run을 받으므로 그 파일은 고치지 않는다.
export function budgetedRun(budgetMs, {run = spawnSync, now = Date.now} = {}) {
  const deadline = now() + budgetMs;
  const state = {timedOut: false};
  const expired = () => { state.timedOut = true; return reasoned('조회 시간 초과', 'timeout'); };
  const budgeted = (command, args, options = {}) => {
    const left = deadline - now();
    if (left <= 0) throw expired();
    const result = run(command, args, {...options, timeout: Math.max(1, Math.min(options.timeout ?? left, left))});
    if (result?.error?.code === 'ETIMEDOUT') throw expired();
    return result;
  };
  // left(): 남은 시간(ms). 다 썼으면 던진다. check(): 다 썼으면 던지기만 한다.
  const left = () => { const ms = deadline - now(); if (ms <= 0) throw expired(); return ms; };
  return {run: budgeted, state, left, check: () => { left(); }};
}

// stop이 쓰는 실제 조회 묶음. paneInfo는 tmux 바닥의 것을 부르는 쪽이 넘긴다.
// 조회의 모든 프로세스 호출(tmux·ps·lsof)이 같은 예산을 나눠 쓴다: 첫 단계인 tmux 호출도 남은 시간까지만 기다린다.
export function lookupDeps({paneInfo, budgetMs = STOP_LOOKUP_BUDGET_MS} = {}) {
  const budget = budgetedRun(budgetMs);
  return {
    budget,
    paneInfo: session => {
      const timeout = Math.max(1, Math.floor(budget.left()));
      try { return paneInfo(session, {timeout}); }
      // tmux가 예산을 다 쓰고 끊겼으면 "못 찾음(시간 초과)"로 읽히게 표시한다(paneInfo는 이유 없는 오류를 던진다).
      catch (error) { budget.check(); throw error; }
    },
    processTree: pid => processTree(pid, budget.run),
    openFiles: pids => openFilesOf(pids, budget.run),
    processStartedAt: pid => processStartedAt(pid, budget.run),
    readJson: file => JSON.parse(fs.readFileSync(file, 'utf8')),
  };
}

// stop 사건에 더할 칸. 절대 던지지 않는다 — 어떤 실패든 "못 찾음 + 이유 낱말"로 돌려주고 끄기는 진행한다.
// 찾음: {conversation, conversationStart}. 못 찾음: {conversationMissing, conversationStart?}.
// 기반 프로세스(비서·대시보드·디코·감시기): {conversationSkipped: 'infrastructure'} — 조회하지 않는다.
// conversationStart는 이 대화가 속한 세대(실행 명령이 있는 start)의 지문이다. reopen이 다른 세대의 번호로 열지 않게 대조한다.
export function stopConversationFields({session, entries, floorName, infrastructure = false, readSettings, deps}) {
  if (infrastructure) return {conversationSkipped: 'infrastructure'};
  let start = null;
  const missing = reason => ({conversationMissing: MISSING_REASONS.includes(reason) ? reason : 'error',
    ...(start ? {conversationStart: startDigest(start)} : {})});
  try {
    if (floorName !== 'tmux') return missing('non-tmux');
    start = launchStart(entries.filter(e => e.session === session));
    if (!start) return missing('no-start');
    const identity = launchIdentityOf(start.cmd);
    if (!identity.ok) return missing('not-ai-runner');
    let spec;
    try {
      spec = readSettings()?.runners?.[identity.harness]?.conversation;
      checkConversationSpec(spec);
    } catch { return missing('unsupported'); }
    const conversation = confirmPaneConversation({session, start, harness: identity.harness, model: identity.model, spec, deps});
    return {conversation, conversationStart: startDigest(start)};
  } catch (error) {
    if (deps?.budget?.state.timedOut || error?.reason === 'timeout') return missing('timeout');
    return missing(error?.reason ?? 'lookup-failed');
  }
}
