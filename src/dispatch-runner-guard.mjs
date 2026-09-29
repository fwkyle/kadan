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
import { readSettings, launchFor } from "./runner-settings.mjs";
import { launchIdentityOf } from "./ai-identity.mjs";

export const GUARDED_PROFILES = ["worker", "reviewer"];

const shorten = (text, length = 100) => (text.length > length ? `${text.slice(0, length)}…` : text);
const shownValue = ({ runner, model, effort }) => [runner, model, effort ?? "강도 없음"].join(" · ");

export function inspectDispatchRunnerGuard({ home, role, session, profile, identity, allowOldRunner, readSettingsFn = readSettings } = {}) {
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
  const command = `kadan stop ${role} 뒤 kadan start ${role} --profile ${profile}로 새로 띄워 보내라`;

  let expected;
  try {
    const settings = readSettingsFn(home);
    if (!settings) return { result: "skip", reason: "no-settings" };
    expected = launchFor(settings, profile);
  } catch (error) {
    return stop("settings-unreadable", [
      `카드 발령 거절: 실행 모델 설정을 읽을 수 없다 — ${error.message}`,
      `이 세션(${session}) 값 = ${have}${startInfo} — 기본값과 대조할 수 없다`,
      `조치: 설정 파일을 고친 뒤 다시 발령하거나, 의도한 예외면 --allow-old-runner "<이유>"`,
    ]);
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
