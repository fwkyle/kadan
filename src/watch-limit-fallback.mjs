// 한도 경보에 붙이는 교대 명령 한 줄 (kadan/work-limit-fallback PR B).
// Why: 작업자·검수자가 실제 한도로 멈췄을 때 감독이 대체 후보가 있는지, 칠 명령이 무엇인지 경보에서 바로 받게 한다.
// 감시기는 세션을 끄거나 띄우지 않는다(잠긴 규칙 3) — 안내 문장만 만든다. 이 모듈은 읽기 함수를 갖지 않는다:
// 감시가 순회마다 이미 읽은 원장 항목(entries)과 설정(settings)을 받아서만 계산한다(새 원장 읽기 없음).
// 경보 중복 판정 키(alert.id)에는 넣지 않는다 — 호출부가 경보 객체의 별도 칸으로만 붙인다.
import { launchIdentityOf } from "./ai-identity.mjs";
import { HARD_ROLE, PROFILE_ROLES, launchForFallback, modelFamily } from "./runner-settings.mjs";
import { codexBasis, ocxStillLimited } from "./ocx-refresh.mjs";
import { phraseOfLine } from "./watch-stop-phrases.mjs";

const SLOT_PROFILES = new Set(["worker", "reviewer"]);
const MAX_REASON = 80;

// 명령에 그대로 붙여 넣는 글이라 따옴표·셸 기호·이메일 꼴을 지우고 짧게 줄인다.
const safeReason = (line) => String(line ?? "")
  .replace(/\S+@\S+/gu, "").replace(/["'`$\\\r\n]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, MAX_REASON);

// 지금 세션을 띄운 start 기록: 그 역할의 마지막 start 중 실제 실행 명령(cmd)이 있는 것. 살아 있는 세션을 재사용한
// start는 명령이 비어 있어(reuseOf) 기준이 못 된다(dispatch-runner-guard.mjs 머리말과 같은 이유).
const launchStart = (entries, role) => (entries ?? []).findLast(
  (e) => e?.kind === "start" && e.role === role && typeof e.cmd === "string" && e.cmd.trim());

const identityOf = (cmd) => { const got = launchIdentityOf(cmd); return got.ok && got.model ? got : null; };

// 반환: 경보 본문에 덧붙일 한 줄(문자열) 또는 null(붙이지 않음).
// alert: {kind, role, line}. ocx: 그 경보에서 받은 ocx 새로고침 결과(codex가 아니면 null).
export function limitFallbackLine({ alert, entries, settings, ocx }) {
  if (alert?.kind !== "한도" || !settings) return null;
  // 일시적 429(자동 재개 대상)는 재개 경로가 먼저다 — 교대 안내는 실제 사용 한도 줄과, 재개를 포기한 경보
  // (watch-rate-limit.mjs가 만드는 `rate-limit:` 경보: 명시 한도·재개 3회 소진·재개 전달 실패)에만 붙인다.
  if (phraseOfLine(alert.line)?.id !== "usage-limit" && !String(alert.id ?? "").startsWith("rate-limit:")) return null;
  const start = launchStart(entries, alert.role);
  const profile = start?.roleProfile;
  // 감독·슈퍼감독·비서 세션, 프로필 기록이 없는 옛 세션에는 붙이지 않는다.
  if (!SLOT_PROFILES.has(profile)) return null;
  // codex(openai 경유)는 사용량을 새로 받은 결과가 '아직 한도'일 때만 — 가짜 한도·확인 실패·대상 아님이면 붙이지 않는다.
  if (codexBasis(entries, alert.role).reason !== "not-codex" && !ocxStillLimited(ocx)) return null;
  const mine = identityOf(start.cmd);
  if (!mine) return null;
  const hard = profile === "worker" && start.difficulty === "hard";
  const slot = hard ? HARD_ROLE : PROFILE_ROLES[profile];
  const preset = settings.activePreset;
  const count = settings.presets?.[preset]?.fallback?.[slot]?.length ?? 0;
  const first = Number.isInteger(start.fallbackIndex) && start.fallbackIndex >= 1 ? start.fallbackIndex + 1 : 1;
  const reviewFor = profile === "reviewer" && start.reviewFor?.family ? start.reviewFor : null;
  const pick = (n) => {
    let candidate;
    try { candidate = launchForFallback(settings, hard ? HARD_ROLE : profile, n, preset); } catch { return null; }
    const got = identityOf(candidate.cmd);
    if (!got) return null;
    return { n, got, family: modelFamily(got.model, settings.families) };
  };
  const same = (got) => got.harness === mine.harness && got.model === mine.model;
  let found = null;
  if (reviewFor) {
    // 검수 대상 작업자와 같은 계열·계열을 모르는 후보, 지금 세션과 같은 모델은 건너뛰고 다음 후보를 본다.
    for (let n = first; n <= count && !found; n++) {
      const item = pick(n);
      if (item && !same(item.got) && item.family && item.family !== reviewFor.family) found = item;
    }
  } else if (first <= count) {
    // 그다음 번호 후보 하나만 본다. 지금 세션과 같은 실행기·모델이면 붙이지 않는다.
    const item = pick(first);
    if (item && !same(item.got)) found = item;
  }
  if (!found) return null;
  const command = `kadan start <새 이름> --profile ${profile}${hard ? " --difficulty hard" : ""}`
    + ` --fallback ${found.n} --reason "한도: ${safeReason(alert.line)}"`;
  const note = profile !== "reviewer" ? ""
    : reviewFor
      ? ` (검수 대상 ${reviewFor.role ?? "작업자"} ${reviewFor.model}(${reviewFor.family})와 다른 계열 ${found.family} 후보 · --for와는 함께 못 씀)`
      : " (검수 대상 작업자와 계열이 같아지지 않는지 확인 · --for와는 함께 못 씀)";
  return `대체 후보 ${found.n}번 있음 — 옛 세션 정리 뒤 ${command}${note}`;
}
