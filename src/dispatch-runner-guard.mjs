// 옛 실행기·모델 세션에 카드를 발령하지 못하게 막는 경계 — 2026-09-29 [kyle] 승인.
// 작업자·검수자 기본값(runner-settings.json)이 바뀌어도 이미 떠 있던 옛 세션에 새 카드가 가는 일이 반복됐다
// (9/23 grok→opus, 9/29 opus→sonnet). 기억에 기댄 규칙은 놓치므로 발령 입구(guardedSend)에서 대조한다.
//
// 세션 쪽 값은 inspectCardSendIdentity가 고른 launch — 마지막 stop 이후, 지금 pane PID와 같은 start 기록 중
// 실제 실행 명령(cmd)이 있는 것 — 에서만 읽는다. 살아 있는 세션에 `kadan start`를 다시 부르면 같은 PID에
// cmd·model이 빈 새 start 기록이 붙으므로(cli.mjs cmdStart의 reusing 분기) "가장 최근 start"는 기준이 못 된다.
// 기본값 쪽은 발령 시점에 runner-settings.json을 새로 읽는다.
//
//   실행기 또는 모델 다름          → 거절(옛 세션)
//   강도·실행 인자만 다름          → 통과 + 경고 한 줄 (강도는 start 기록에 따로 없고 명령 안에 있다.
//                                   실행기별 어댑터를 만들지 않으려고 기본값 명령과 세션 명령의 문자열을 비교한다)
//   --allow-old-runner "<이유>"    → 거절을 예외 통과. 이유는 send 기록에 남긴다. 빈 이유는 예외가 아니라서
//                                   세션이 기본값과 같아도, 받는 역할이 무엇이든 항상 거절한다(규칙 하나)
//   설정 없음·역할 값 없음·작업자/검수자가 아닌 역할 → 적용하지 않는다(skip)
//   시작 기록 없음·모델 모름         → 경고(대조할 세션 값이 없다). 실제로는 여기 오기 전에
//                                   inspectCardSendIdentity가 더 엄하게 막는다 — 새 검사가 기존 경계를 약하게 만들지 않는다
// profile은 호출부가 --raw여도 같은 규칙으로 정해 넘긴다(role-instructions.mjs의 inferDispatchProfile).
//
// 카드 단계 대조 — 2026-10-02 [kyle] 승인. 10/1부터 검수 카드 18건이 `--profile worker`로 띄운 세션(작업자와 같은
// 소넷)에 갔다. 세션 시작 프로필만 보면 worker 기본값과 같아 통과했고, 작업자·검수자가 다른 모델이라는 전제가 조용히 깨졌다.
// phaseProfile은 발령 카드의 단계가 요구하는 프로필(review→reviewer, 그 외 작업 단계→worker, inferCardPhaseProfile)이다.
//   세션 프로필(worker/reviewer)과 카드 단계 프로필이 다름 → 거절(profile-phase-mismatch). --allow-old-runner 예외 규칙은 같다
//   같으면                                                 → 위 대조를 그대로(카드 단계 프로필 기본값과)
//   카드 단계를 모름·세션 프로필이 작업자/검수자가 아님      → 기존 동작 그대로
// 폴백 — 2026-10-02 [kyle]. 기본값과 실행기·모델이 달라도 지금 설정의 그 프로필 폴백 목록 중 하나와 같으면
// 통과 + 경고 한 줄(폴백 번호), send 기록에 fallbackIndex를 남긴다. 어느 것과도 다르면 기존처럼 거절.
import { readSettings, launchFor, launchForFallback, PROFILE_ROLES } from "./runner-settings.mjs";
import { launchIdentityOf } from "./ai-identity.mjs";

export const GUARDED_PROFILES = ["worker", "reviewer"];

const shorten = (text, length = 100) => (text.length > length ? `${text.slice(0, length)}…` : text);
const shownValue = ({ runner, model, effort }) => [runner, model, effort ?? "강도 없음"].join(" · ");
const PHASE_CARD = { reviewer: "검수 카드(review)", worker: "작업 카드(구현·수정 등)" };
const PROFILE_SESSION = { reviewer: "검수자(reviewer)", worker: "작업자(worker)" };

export function inspectDispatchRunnerGuard({ home, role, session, profile, phaseProfile, identity, allowOldRunner, readSettingsFn = readSettings } = {}) {
  const exception = typeof allowOldRunner === "string" && allowOldRunner.trim() ? allowOldRunner.trim() : null;
  if (allowOldRunner !== undefined && !exception) {
    return { result: "reject", code: "blank-exception-reason", message: [
      "카드 발령 거절: --allow-old-runner에는 이유가 필요하다 — 빈 이유는 예외가 아니다",
      `조치: --allow-old-runner "<이유>"로 이유를 적거나, 예외가 필요 없으면 옵션을 빼라`,
    ].join("\n") };
  }
  if (!GUARDED_PROFILES.includes(profile)) return { result: "skip", reason: "not-worker-reviewer" };
  const have = `${identity.harness ?? "모름"} · ${identity.model ?? "모름"}`;
  const startInfo = identity.launch?.settingsRevision != null ? ` (시작 때 설정 revision ${identity.launch.settingsRevision})` : "";
  const stop = (code, lines, settingsRevision) => exception
    ? { result: "allowed", code, warning: `경고: ${session} 옛 세션 예외 통과(--allow-old-runner) — ${lines[0].replace(/^카드 발령 거절: /, "")} — 이유: ${exception}`,
        ledger: { result: "allowed", code, reason: exception, ...(settingsRevision != null ? { settingsRevision } : {}) } }
    : { result: "reject", code, message: lines.join("\n") };
  const mismatch = GUARDED_PROFILES.includes(phaseProfile) && phaseProfile !== profile;
  const target = mismatch ? phaseProfile : profile;
  const command = `kadan stop ${role} 뒤 kadan start ${role} --profile ${target}로 새로 띄워 보내라`;

  let expected, settings;
  try {
    settings = readSettingsFn(home);
    if (!settings) return { result: "skip", reason: "no-settings" };
    expected = launchFor(settings, target);
  } catch (error) {
    return stop("settings-unreadable", [
      `카드 발령 거절: 실행 모델 설정을 읽을 수 없다 — ${error.message}`,
      `이 세션(${session}) 값 = ${have}${startInfo} — 기본값과 대조할 수 없다`,
      `조치: 설정 파일을 고친 뒤 다시 발령하거나, 의도한 예외면 --allow-old-runner "<이유>"`,
    ]);
  }
  if (mismatch) {
    const want = expected ? `지금 기본값 ${shownValue(expected)}` : "기본값 없음";
    return stop("profile-phase-mismatch", [
      `카드 발령 거절: ${PHASE_CARD[target]}를 ${PROFILE_SESSION[profile]} 프로필 세션에 보낸다 — ${PHASE_CARD[target]}는 ${target} 프로필(${want})이어야 한다`,
      `이 세션(${session}) 값 = ${have}${startInfo} — 세션 프로필 ${profile}`,
      `조치: ${command} (의도한 예외면 --allow-old-runner "<이유>")`,
    ], expected?.revision);
  }
  if (!expected) return { result: "skip", reason: "no-role-value" };

  const want = launchIdentityOf(expected.cmd);
  if (!want.ok) {
    return {
      result: "warn", code: "expected-unreadable",
      warning: `경고: ${profile} 기본값 명령에서 실행기·모델을 읽지 못해 ${session}과(와) 대조하지 못했다: ${shorten(expected.cmd)}`,
      ledger: { result: "warn", code: "expected-unreadable", settingsRevision: expected.revision },
    };
  }
  if (!identity.harness || !identity.model || typeof identity.launch?.cmd !== "string") {
    return {
      result: "warn", code: "session-unknown",
      warning: `경고: ${session}의 시작 기록·실행 모델을 몰라 ${profile} 기본값과 대조하지 못했다`,
      ledger: { result: "warn", code: "session-unknown", settingsRevision: expected.revision },
    };
  }
  if (want.harness !== identity.harness || want.model !== identity.model) {
    const fallback = matchingFallback(settings, target, identity);
    if (fallback) {
      return {
        result: "warn", code: "fallback",
        warning: `경고: ${session}은(는) ${target} 폴백 ${fallback.fallbackIndex}번(${shownValue(fallback)})으로 떠 있다 — 기본값(${shownValue(expected)})이 아니다`,
        ledger: { result: "warn", code: "fallback", fallbackIndex: fallback.fallbackIndex, settingsRevision: expected.revision },
      };
    }
    return stop("runner-or-model", [
      `카드 발령 거절: 옛 실행기·모델 세션이다 — 지금 ${profile} 기본값 = ${shownValue(expected)} (설정 revision ${expected.revision})`,
      `이 세션(${session}) 값 = ${have}${startInfo}`,
      `조치: ${command} (의도한 예외면 --allow-old-runner "<이유>")`,
    ], expected.revision);
  }
  if (identity.launch.cmd.trim() !== expected.cmd.trim()) {
    return {
      result: "warn", code: "effort-or-args",
      warning: `경고: ${session}의 강도·실행 인자가 지금 ${profile} 기본값과 다르다(기본값 강도 ${expected.effort ?? "없음"}) — 세션 명령: ${shorten(identity.launch.cmd)}`,
      ledger: { result: "warn", code: "effort-or-args", settingsRevision: expected.revision },
    };
  }
  return { result: "pass" };
}

// 기본값과 다른 세션이 지금 설정의 폴백 목록 중 하나와 실행기·모델이 같으면 그 폴백(번호 포함)을 돌려준다.
// `kadan start --profile <p> --fallback N`으로 정식으로 띄운 세션을 옛 세션으로 거절하지 않게 한다(2026-10-02 [kyle]).
// 읽지 못하는 폴백 항목은 건너뛴다 — 맞는 항목이 없으면 기존처럼 거절이다.
function matchingFallback(settings, profile, identity) {
  const count = settings.presets[settings.activePreset].fallback?.[PROFILE_ROLES[profile]]?.length ?? 0;
  for (let index = 1; index <= count; index++) {
    let fallback;
    try { fallback = launchForFallback(settings, profile, index); } catch { continue; }
    const got = launchIdentityOf(fallback.cmd);
    if (got.ok && got.harness === identity.harness && got.model === identity.model) return fallback;
  }
  return null;
}
