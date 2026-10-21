import { workEntries, currentResponsibility } from "./handover-state.mjs";
import { isDescendant } from "./hierarchy.mjs";
import { boardFromRole, supervisorForBoard } from "./board.mjs";
import { peerResponsibilities } from "./peer-mail.mjs";
import { ownerGenerations, isPreviousOwner } from "./owner-generation.mjs";

function startedAtMs(state) {
  const at = Date.parse(state?.startedAt);
  return Number.isFinite(at) ? at : 0;
}

// 감독 멈춤은 두 단계다(2026-10-05 [kyle] 결정): idleMs 동안 멈추면 본인에게(1단), 그 두 배가 되면 상위에게(2단).
// 두 단계는 다른 id라 1단은 2단이 뜨면 조용히 닫히고, 상위는 2단에서 처음 받는다. 움직이면 둘 다 닫힌다.
function idleAlert(baseId, role, session, openCards, idleFor, idleMs) {
  const stage = idleFor >= idleMs * 2 ? 2 : 1;
  return { id: stage === 2 ? `${baseId}:상위` : baseId, kind: "놀고 있음", level: "AMBER", role, session,
    openCards, idleMinutes: Math.floor(idleFor / 60_000), stage };
}

// 답을 기다리는 일은 묻는 쪽의 할 일이 아니다(2026-10-05 [kyle]). waits: [{ids, answerer}] — ids는 그 일의 실행 ID·카드 주소·
// 소속 워크(work:<키>), answerer는 답할 역할(사용자 결정이면 @user). 감독 role에게서 빼는 조건: 답할 쪽이 role 자신이나
// role 아래가 아니다. 즉 사용자 결정은 모두에게서 빠지고, 감독→슈퍼감독 질문은 묻는 감독에게서만 빠진다(답할 슈퍼감독에게는 할 일).
export function waitingExcluder(waits, parents) {
  const byId = new Map(), mails = new Map();
  for (const w of waits ?? []) for (const id of w.ids ?? []) {
    byId.set(id, [...(byId.get(id) ?? []), w.answerer]);
    if (w.mailId) mails.set(id, [...(mails.get(id) ?? []), { mailId: w.mailId, asker: w.asker, answerer: w.answerer }]);
  }
  const excluded = (taskId, role) => (byId.get(taskId) ?? []).some(a => a !== role && !(parents.has(a) && isDescendant(a, role, parents)));
  excluded.userWait = taskId => (byId.get(taskId) ?? []).includes("@user");
  excluded.answers = (taskId, role) => (byId.get(taskId) ?? []).includes(role);
  // role이 답할 질문 우편(우편 ID·질문자). 답 대기가 우편이 아닌 것(사용자 결정 등)이면 비어 있다.
  excluded.questions = (taskId, role) => (mails.get(taskId) ?? []).filter(m => m.answerer === role);
  return excluded;
}

// 실행이 다 끝났거나 아직 없는 열린 워크는 책임 감독의 할 일이다(2026-10-05 [kyle]: "매번 내가 말해 줘야 다음 걸 한다").
// 진행 중 실행 = 카드가 assigned·hold인 것. draft·ready는 아직 발령 전이라 할 일로 본다.
// 할 일은 지금 차례(turnOwner)인 역할의 것이다(2026-10-16 [kyle]). 차례가 관계표에 없으면 책임 감독(owner)에게 둔다.
// owner만 보면 하위 감독 차례인 업무가 상위의 할 일로 세어지고 정작 차례인 쪽에는 가지 않았다.
export function idleWorkEntries(works, cards, parents) {
  const byKey = new Map((cards ?? []).map(c => [c.key, c]));
  return (works ?? []).filter(w => w?.status === "open" && parents.has(currentResponsibility(w, parents, cards).role)
      && !(w.executions ?? []).some(x => ["assigned", "hold"].includes(byKey.get(x.key)?.status)))
    // 세대 판정 시각도 귀속한 역할에 맞춘다(currentResponsibility: 관찰 범위와 같은 함수).
    .map(w => { const { role, since } = currentResponsibility(w, parents, cards);
      return { kind: "send", role, taskId: `work:${w.key}`, t: w.at, ownedAt: since }; });
}

export function assessSupervisorIdle(
  entries,
  roleStates,
  now,
  idleMs,
  ledgerError = null,
  parents = new Map(),
  { works = [], cards = [], waits = [], peerEntries = entries } = {}
) {
  const excluded = waitingExcluder(waits, parents);
  if (ledgerError) {
    return [
      {
        id: "ledger:unreadable",
        kind: "모름",
        level: "AMBER",
        ledgerError: ledgerError.message,
      },
    ];
  }

  entries = workEntries(entries);
  // 명시한 역할은 이름 기반의 옛 판정과 중복하지 않는다.
  const mappedBoards = new Set([...parents.keys()].map(boardFromRole).filter(Boolean));
  const mappedTasks = new Set(entries.filter(entry => parents.has(entry?.role) && entry.taskId).map(entry => entry.taskId));
  const legacyEntries = entries.filter(entry => !parents.has(entry?.role) &&
    !(entry?.kind === "plan" && (mappedBoards.has(entry.board) || mappedTasks.has(entry.taskId))));
  const completed = new Set();
  for (const entry of legacyEntries) {
    const board = boardFromRole(entry?.role);
    if (entry?.kind === "done" && board && entry.taskId) {
      completed.add(`${board}\0${entry.taskId}`);
    }
  }

  const openByBoard = new Map();
  for (const entry of legacyEntries) {
    const board = entry?.kind === "plan" ? entry.board : boardFromRole(entry?.role);
    const at = Date.parse(entry?.t);
    if (!board || !Number.isFinite(at)) continue;
    if (
      (entry.kind === "plan" || entry.kind === "send") &&
      entry.taskId &&
      !completed.has(`${board}\0${entry.taskId}`)
    ) {
      const cards = openByBoard.get(board) ?? new Map();
      const previous = cards.get(entry.taskId);
      cards.set(entry.taskId, previous == null ? at : Math.min(previous, at));
      openByBoard.set(board, cards);
    }
  }

  const alerts = [];
  const liveSessions = [...roleStates.entries()]
    .filter(([, state]) => state?.alive)
    .sort((left, right) => startedAtMs(right[1]) - startedAtMs(left[1]))
    .map(([session]) => session);
  for (const [board, allCards] of openByBoard) {
    const role = supervisorForBoard(board, liveSessions) ?? `${board}-감독`;
    const cards = new Map([...allCards].filter(([taskId]) => !excluded(taskId, role)));
    if (!cards.size) continue;
    const session = `kadan-${role}`;
    const state = roleStates.get(session);
    if (state?.deathActive) continue;
    if (!state?.alive || state.digest == null) {
      alerts.push({
        id: `idle:screen:${board}`,
        kind: "모름",
        level: "AMBER",
        role,
        session,
        openCards: cards.size,
        screenError: state?.screenError ?? "화면 없음",
      });
      continue;
    }
    const openedAt = Math.min(...cards.values());
    const idleFor = Math.min(now - openedAt, state.unchangedMs ?? 0);
    if (idleFor < idleMs) continue;
    alerts.push(idleAlert(`idle:${board}`, role, session, cards.size, idleFor, idleMs));
  }
  const requests = peerResponsibilities(peerEntries, parents, works, cards);
  const waiting = (id, role) => excluded(id, role)
    || requests.find(r => r.taskId === id)?.linkedWorkIds.some(key => excluded(key, role));
  // 묻힌 일의 연결 id(요청 우편이 이은 워크)까지 같은 판정을 쓴다.
  const linked = (id, check) => check(id) || Boolean(requests.find(r => r.taskId === id)?.linkedWorkIds.some(check));
  waiting.userWait = id => linked(id, excluded.userWait);
  waiting.answers = (id, role) => linked(id, key => excluded.answers(key, role));
  waiting.questions = (id, role) => [id, ...(requests.find(r => r.taskId === id)?.linkedWorkIds ?? [])]
    .flatMap(key => excluded.questions(key, role));
  // 이전 세대 소속의 책임은 할 일에서 뺀다(owner-generation.mjs). 답 대기 요청(peerRequest)은 우편 세대 규칙을 따른다.
  const generations = ownerGenerations(peerEntries);
  const current = entry => entry.peerRequest || entry.kind !== "send" || !parents.has(entry.role)
    || !isPreviousOwner(generations, entry.role, Object.hasOwn(entry, "ownedAt") ? entry.ownedAt : entry.t);
  // 발령 이력이 있는가는 세대 필터 전 원본 기준이다. 이전 세대 발령을 뺐다고 그 plan을 미발령 할 일로 되살리지 않는다.
  const all = [...entries, ...idleWorkEntries(works, cards, parents), ...requests];
  alerts.push(...assessHierarchyIdle(
    all.filter(current),
    roleStates, now, idleMs, parents, waiting,
    new Set(all.filter(e => e.kind === "send" && parents.has(e.role) && e.taskId).map(e => e.taskId)),
  ));
  return alerts;
}

// 1단: 감독 본인에게. 예전 --wake(30분 타이머에 고정 점검 목록)를 대신한다 — 근거(할 일 수·멈춘 시간)가 있는
// 문구만 보내고, 멈추지 않았으면 아무것도 보내지 않는다. 15분 더 멈추면 2단으로 상위에게 간다고 미리 알린다.
export function buildIdleNudge(alert) {
  return `놀고 있음 ${alert.session} (${idleCountsText(alert)}, ${alert.idleMinutes}분간 화면 변화 없음) — 판을 확인하고 다음 행동을 정하라. 이대로 ${alert.idleMinutes}분 더 멈추면 상위에게 알린다.${idleOwnText(alert) && ` ${idleOwnText(alert)}`}`;
}

// 센 항목을 세 가지로 가른다: 본인 차례 / 하위 역할 차례 / 사용자 답 대기. 앞의 하나만 재촉의 근거이고 나머지는 참고다.
export function idleCountsText(alert) {
  const parts = [`본인 차례 ${alert.openCards}건`];
  for (const [role, n] of Object.entries(alert.lower ?? {})) parts.push(`하위 ${role} 차례 ${n}건`);
  if (alert.userWait) parts.push(`사용자 답 대기 ${alert.userWait}건`);
  return parts.join(" / ");
}

const ITEM_CAP = 20;

// 본인 차례인 이유: 답할 질문(우편이 걸림) > 미발령 계획 > 내 차례. 판정(mine)은 바꾸지 않고 이유만 붙인다.
// 질문은 전체 우편 ID와 질문자를 짝으로 남긴다(닫는 답장은 우편마다 그 질문자에게 가야 한다).
function ownReason(entry, role, answers, questions) {
  const id = entry.taskId;
  if (entry.peerRequest) {
    return { id, reason: "답할 질문", questions: [{ mailId: entry.mailId, asker: entry.asker ?? null }] };
  }
  if (answers(id, role)) {
    const asked = questions(id, role).slice(0, 3);
    return { id, reason: "답할 질문", ...(asked.length ? { questions: asked.map(m => ({ mailId: m.mailId, asker: m.asker ?? null })) } : {}) };
  }
  return { id, reason: entry.kind === "plan" ? "미발령 계획" : "내 차례" };
}

const BODY_ITEMS = 5;

// 알림 본문에 붙일 본인 차례 항목과 이유(최대 5개, 넘으면 `외 N건`). 원장에 이유가 없는 옛 기록이면 빈 글자다.
// 질문마다 `전체 우편ID ← 질문자`와 그 질문자에게 가는 닫는 명령을 적는다.
export function idleOwnText(alert) {
  const why = alert.idleItems?.ownWhy;
  if (!why?.length) return "";
  const shown = why.slice(0, BODY_ITEMS);
  const names = shown.map(w => `${w.id} (${w.reason}${w.questions?.length ? ` ${w.questions.map(q => `${q.mailId} ← ${q.asker ?? "질문자 미상"}`).join(", ")}` : ""})`);
  const rest = (alert.openCards ?? why.length) - shown.length;
  const closes = shown.flatMap(w => w.questions ?? [])
    .map(q => `kadan send ${q.asker ?? "<질문자>"} --reply-to ${q.mailId} --reply-final '답'`);
  const hint = closes.length ? ` 답했으면 질문마다 닫는다: ${closes.join(" ; ")}` : "";
  return `본인 차례: ${names.join(", ")}${rest > 0 ? ` 외 ${rest}건` : ""}.${hint}`;
}

export function assessHierarchyIdle(entries, states, now, idleMs, parents, excluded = () => false, assignedTaskIds = null) {
  const userWaiting = excluded.userWait ?? (() => false), answers = excluded.answers ?? (() => false);
  const questions = excluded.questions ?? (() => []);
  const pending = new Map();
  for (const entry of entries) {
    if (!parents.has(entry?.role) || !entry.taskId) continue;
    const key = `${entry.role}\0${entry.taskId}`;
    if (entry.kind === "send") pending.set(key, entry);
    if (entry.kind === "done") pending.delete(key);
  }
  const supervisors = new Set([...parents.values()].filter(role => parents.has(role)));
  for (const entry of entries) if (entry.peerRequest) supervisors.add(entry.role);
  // 아직 미발령인 plan은 같은 판의 직속 감독 한 명에게만 귀속한다.
  const assigned = assignedTaskIds ?? new Set(entries.filter(entry => parents.has(entry?.role) && entry.taskId && entry.kind === "send").map(entry => entry.taskId));
  for (const entry of entries) {
    if (entry?.kind !== "plan" || assigned.has(entry.taskId)) continue;
    const candidates = [...supervisors].filter(role => boardFromRole(role) === entry.board);
    const owners = candidates.filter(role => !candidates.some(other => other !== role && isDescendant(other, role, parents)));
    if (owners.length === 1) pending.set(`plan\0${entry.board}\0${entry.taskId}`, { ...entry, role: owners[0] });
  }
  // 그 일을 책임지는 감독: 감독 역할이 받은 일은 그 감독, 작업자가 받은 일은 작업자의 직속 상위.
  const dutyOf = entry => supervisors.has(entry.role) ? entry.role : parents.get(entry.role);
  const alerts = [];
  for (const role of supervisors) {
    const below = [...pending.values()].filter(entry => isDescendant(entry.role, role, parents));
    const open = below.filter(entry => !excluded(entry.taskId, role));
    // 재촉의 근거는 본인 차례 일뿐이다(2026-10-16 [kyle]). 하위 감독 차례 일은 그 감독의 1단 → 2단(상위) 경로로 올라온다.
    // 내가 답할 차례인 질문이 걸린 일도 본인 차례다(감독 → 슈퍼감독 질문은 답할 슈퍼감독의 할 일).
    const mine = entry => dutyOf(entry) === role || answers(entry.taskId, role);
    const cards = open.filter(mine);
    if (!cards.length) continue;
    const lower = {};
    for (const entry of open) if (!mine(entry)) lower[dutyOf(entry)] = (lower[dutyOf(entry)] ?? 0) + 1;
    const waitIds = [...new Set(below.filter(entry => userWaiting(entry.taskId)).map(entry => entry.taskId))];
    const items = {
      own: cards.map(entry => entry.taskId).slice(0, ITEM_CAP),
      lower: open.filter(entry => !mine(entry)).map(entry => entry.taskId).slice(0, ITEM_CAP),
      userWait: waitIds.slice(0, ITEM_CAP),
      // 본인 차례인 이유(own과 같은 순서·같은 20개 상한). 글자는 키·고정 낱말·ID뿐이다.
      ownWhy: cards.slice(0, ITEM_CAP).map(entry => ownReason(entry, role, answers, questions)),
    };
    const extra = { lower, userWait: waitIds.length, idleItems: items };
    const session = `kadan-${role}`;
    const state = states.get(session);
    if (state?.deathActive) continue;
    if (!state?.alive || state.digest == null) {
      alerts.push({ id: `idle:hierarchy:screen:${role}`, kind: "모름", level: "AMBER",
        role, session, openCards: cards.length, screenError: state?.screenError ?? "화면 없음" });
      continue;
    }
    // 하위 담당자가 실제로 진행하면 상위의 조용한 대기는 이상이 아니다.
    const active = [state, ...cards.flatMap(entry => [entry.role, ...(entry.activityRoles ?? [])]
      .map(role => states.get(`kadan-${role}`)))]
      .filter(item => item?.alive && item.digest != null);
    const openedAt = Math.min(...cards.map(entry => Date.parse(entry.t)).filter(Number.isFinite));
    const idleFor = Math.min(now - openedAt, ...active.map(item => item.unchangedMs ?? 0));
    if (idleFor < idleMs) continue;
    alerts.push({ ...idleAlert(`idle:hierarchy:${role}`, role, session, cards.length, idleFor, idleMs), ...extra });
  }
  return alerts;
}
