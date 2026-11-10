// PR3: Autopilot 상태 띠와 머지 요청 줄 정보. 읽기 전용이다.
// 원장 전체를 다시 읽지 않는다: 대시보드가 이미 증분으로 읽은 snapshot.entries·snapshot.decisions·snapshot.center만 쓴다.
// GitHub를 부르지 않고 카드·온톨로지 파일을 직접 읽지 않는다.
import { autopilotState } from "../autopilot.mjs";
import { stage } from "../review-flow.mjs";
import { normalizeSha, sameCommit } from "../review-sha.mjs";
import { registeredCenterWorks } from "../center-wall.mjs";
import { prNumbers } from "../dashboard-kanban.mjs";

const date = (value) => Date.parse(value) || 0;

// 원장 뒤에서부터 마지막 autopilot 사건 하나를 찾는다(복사 없음, watchAutopilotExpiry와 같은 방식).
// autopilotState는 마지막 autopilot 사건만 보므로 그 하나만 넘겨도 결과가 같다.
function lastAutopilotEntry(entries) {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i]?.kind === "autopilot") return entries[i];
  return null;
}

// 스냅샷의 결정은 이벤트 줄이 아니라 '최신 상태'다. autopilotState가 보는 것은 "답한 이벤트의 answer.by·at"뿐이라
// 답한 결정(status answered)을 그대로 이벤트처럼 넘긴다. 다른 점 하나: 사람이 답한 뒤 취소된 결정은 최신 상태가 cancelled라
// 이벤트에 있던 '답함'이 사라진다(디코 자유 답을 요청자가 취소하는 드문 경우). 그때는 꺼짐 판정이 늦을 수 있다 — 표시 전용이라 관문은 아니다.
const asEvents = (decisions) => decisions.filter((d) => d?.status === "answered");

// Autopilot 상태 띠 재료. on: true/false, 모르면 null(원장·결정 기록을 못 읽음).
export function autopilotStrip(snapshot, now = Date.now()) {
  if (snapshot.ledgerLines === null || !Array.isArray(snapshot.entries)) return { on: null, reason: "원장을 읽지 못함" };
  if (snapshot.decisionError) return { on: null, reason: "결정 기록을 읽지 못함" };
  const last = lastAutopilotEntry(snapshot.entries);
  const state = autopilotState(last ? [last] : [], asEvents(snapshot.decisions ?? []), now);
  if (state.on) {
    const s = state.start;
    return { on: true, since: s.t ?? null, until: s.until ?? null, level: s.level ?? null, onlyRunning: s.onlyRunning === true };
  }
  // 꺼짐. 끝난 기록이 있으면 마지막 시작~끝을 함께 준다(끝 사건이 아직 없는 pending이면 끝 시각만).
  const ended = state.pending
    ? { since: state.start?.t ?? null, endedAt: new Date(state.pending.endedAt).toISOString(), phase: state.pending.phase }
    : last && last.phase !== "on"
      ? { since: last.startedAt ?? null, endedAt: last.endedAt ?? last.t ?? null, phase: last.phase }
      : null;
  return { on: false, last: ended };
}

// ---- 머지 요청 줄 ----
// 업무에 연결된 review 단계 실행 중 낡지 않은 pass·changes 판정(src/merge-check.mjs currentReviews와 같은 규칙).
// 같은 함수를 그대로 쓰면 카드 목록·원장을 다시 읽어야 해서(상주 경로 비용) 이미 만든 center.cards로 같은 계산을 한다.
// 같은 결과인지는 tests/dashboard-autopilot-view.test.mjs가 mergeCheck와 맞춰 본다.
export function reviewsOfWork(center, work) {
  const picks = [];
  (work?.executions ?? []).forEach((link, index) => {
    const card = (center?.cards ?? []).find((c) => c.key === link.key);
    if (!card || (link.phase !== "review" && card.rallyStep !== "review")) return;
    const s = stage(card);
    if (s.outcome === "pass" || s.outcome === "changes")
      picks.push({ key: card.key, at: s.resultAt, outcome: s.outcome, index, sha: normalizeSha(card.result?.reviewedSha) });
  });
  return picks.sort((a, b) => date(b.at) - date(a.at) || b.index - a.index);
}

// merge-check의 판정 부분(mergeCheck 본문과 같은 순서·같은 말).
export function judgeHead(reviews, headSha) {
  const passes = reviews.filter((r) => r.outcome === "pass");
  if (!passes.length) return "검수 pass 없음";
  if (!passes.some((r) => r.sha)) return "검수 SHA 없음";
  const same = reviews.filter((r) => r.sha && sameCommit(r.sha, headSha));
  if (!same.length) return "다름";
  if (same.some((x) => same.some((y) => !sameCommit(x.sha, y.sha)))) return "모호";
  return same[0].outcome === "pass" ? "같음" : "같은 커밋 검수 changes";
}

// 결정 글에 적힌 PR head: "head: <sha>"·"head SHA <sha>"·"headRefOid=<sha>" 꼴만. 7~40자리 16진이 아니면 모른다.
const HEAD_PATTERN = /\b(?:head(?:\s*sha|\s*커밋)?|headRefOid)\b[\s:=`'"(]*([0-9a-f]{7,40})\b/i;
export function prHeadOf(decision) {
  const text = `${decision?.question ?? ""}\n${decision?.reason ?? ""}`;
  return normalizeSha(HEAD_PATTERN.exec(text)?.[1]);
}
// 결정 글에 적힌 CI 줄: 'CI'가 든 첫 줄을 그대로(해석하지 않음). 기록 시각과 함께 보이고 현재 상태는 확인하지 않는다.
export function ciLineOf(decision) {
  const text = `${decision?.question ?? ""}\n${decision?.reason ?? ""}`;
  const line = text.split(/\r?\n/).find((l) => /\bCI\b/.test(l));
  return line ? line.trim().slice(0, 160) : null;
}

// 머지 요청 결정 하나의 줄 정보. work: 결정의 work, 없으면 결정이 걸린 카드를 연결한 업무.
// 연결 업무를 못 찾으면 검수 기록을 모른다고 한다(추측으로 통과를 붙이지 않는다).
export function mergeLineInfo(snapshot, decision, ctx = mergeContext(snapshot)) {
  const workKey = decision.work ?? ctx.byCard.get(decision.card) ?? null;
  const work = workKey ? ctx.byKey.get(String(workKey).replace(/^work:/, "")) : null;
  const head = prHeadOf(decision);
  const base = { prs: prNumbers(decision), head, ci: ciLineOf(decision), ciAt: decision.at ?? null };
  if (!work || !snapshot.center) return { ...base, work: workKey ?? null, reviewSha: null, review: "검수 기록 모름", match: null };
  const reviews = reviewsOfWork(snapshot.center, work);
  const pass = reviews.find((r) => r.outcome === "pass") ?? null;
  const reviewSha = pass?.sha ?? null;
  const review = !pass ? "검수 pass 없음" : reviewSha ? "pass" : "검수 SHA 없음";
  return { ...base, work: work.key, reviewSha, review, match: head ? judgeHead(reviews, head) : null };
}

// 한 응답 안에서 업무 찾기를 한 번만 만든다.
export function mergeContext(snapshot) {
  const works = (() => { try { return registeredCenterWorks(snapshot).works ?? []; } catch { return []; } })();
  const byKey = new Map(works.map((w) => [w.key, w]));
  const byCard = new Map();
  for (const w of works) for (const link of w.executions ?? []) if (!byCard.has(link.key)) byCard.set(link.key, w.key);
  return { byKey, byCard };
}
