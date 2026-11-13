// kadan idle-roles — 오래 쉬는 역할 세션을 정리 후보로 골라 직속 상위 감독에게 알린다(끄지 않는다). 본체는 ../idle-roles.mjs.
import { floor } from "../floor.mjs";
import { appendLedger, ledgerHome, resolveLedgerBy } from "../ledger.mjs";
import { assertWritable } from "../storage.mjs";
import { idleRolesDue, claimIdleRolesRun, runIdleRoles, formatReport, idleRolesOff, IDLE_ROLES_OFF } from "../idle-roles.mjs";
import { readIdleHours, setIdleHours, MIN_IDLE_HOURS, MAX_IDLE_HOURS, DEFAULT_IDLE_HOURS } from "../idle-roles-setting.mjs";
import { readIdleState } from "../idle-screen-clock.mjs";

// 부를 때 만든다: 이 파일과 ../idle-roles.mjs는 자동 실행 명령을 거쳐 서로를 다시 부르는 순환 안에 있어, 모듈 첫머리에서 읽으면 초기화 전일 수 있다.
export const idleRolesUsage = () => "사용법: kadan idle-roles show | set <시간> --revision N --reason <이유> | run [--dry-run]\n" +
  `  show: 기준 시간(기본 ${DEFAULT_IDLE_HOURS}시간)과 마지막 실행·후보 수\n` +
  `  set: 기준 시간을 바꾼다(${MIN_IDLE_HOURS}~${MAX_IDLE_HOURS}시간). 실행 모델 설정 파일의 revision을 대조하고 바꾼 사람·이유를 원장에 남긴다\n` +
  "  run: 한 번 고르고 직속 상위 감독에게 묶음 우편을 보낸다. --dry-run은 보낼 묶음만 출력한다(우편·상태 파일 없음)\n" +
  `  아무것도 끄지 않는다. 자동 실행(kadan up --auto, 한 시간에 한 번)의 우편은 $KADAN_HOME/${IDLE_ROLES_OFF} 파일로 끈다(화면 표본은 계속 쌓인다)`;

export function cmdIdleRoles(argv, flags) {
  const [action, value, ...extra] = argv;
  if (flags.help || !action) { console.log(idleRolesUsage()); return; }
  const home = ledgerHome();
  if (action === "show") {
    if (value !== undefined) throw Object.assign(new Error(idleRolesUsage()), { exitCode: 2 });
    const setting = readIdleHours(home), state = readIdleState(home);
    console.log(JSON.stringify({
      hours: setting.hours, source: setting.source, revision: setting.revision, mailOff: idleRolesOff(home),
      lastRunAt: state.lastRunAt ? new Date(state.lastRunAt).toISOString() : null,
      candidates: Array.isArray(state.candidates) ? state.candidates.length : null,
    }, null, 2));
    return;
  }
  if (action === "set") {
    if (extra.length) throw Object.assign(new Error(idleRolesUsage()), { exitCode: 2 });
    assertWritable(home);
    const next = setIdleHours(home, { hours: value, revision: flags.revision, reason: flags.reason,
      by: resolveLedgerBy({ env: process.env }), record: entry => appendLedger({ ...entry, t: new Date().toISOString() }, home) });
    console.log(JSON.stringify({ hours: next.idleRoleHours, revision: next.revision }, null, 2));
    return;
  }
  if (action === "run") {
    if (value !== undefined) throw Object.assign(new Error(idleRolesUsage()), { exitCode: 2 });
    const dryRun = flags["dry-run"] === true;
    if (!dryRun) assertWritable(home);
    const report = runIdleRoles({ home, floor, dryRun });
    console.log(formatReport(report).join("\n"));
    return;
  }
  throw Object.assign(new Error(idleRolesUsage()), { exitCode: 2 });
}

// kadan up --auto의 한 시간 문. 되살리기 잠금 안에서는 차례만 잡고(claimIdleRolesGate), 잠금을 푼 뒤에 돈다(runIdleRolesGate):
// 대화 번호 조회와 우편 명령이 몇 초씩 걸려 잠금 안에서 돌면 kadan stop·수동 up이 그동안 막힌다.
// 어떤 실패도 자동 실행을 막지 않는다. 우편을 보냈을 때만 한 줄을 낸다.
export function claimIdleRolesGate(home, now = Date.now()) {
  try {
    if (!idleRolesDue(home, now)) return false;
    claimIdleRolesRun(home, now);
    return true;
  } catch { return false; }
}

export function runIdleRolesGate(home, { run = runIdleRoles, log = console.log, warn = console.error } = {}) {
  try {
    const report = run({ home, floor });
    const sent = report.mails.filter(mail => mail.sent);
    if (sent.length) log(`정리 후보 우편 ${sent.length}통: ${sent.map(mail => `${mail.to}(${mail.roles.length}개)`).join(", ")}`);
    const failed = report.mails.filter(mail => !mail.sent);
    if (failed.length) warn(`정리 후보 우편 실패 ${failed.length}통: ${failed.map(mail => `${mail.to}(${mail.delivery ?? "실패"})`).join(", ")}`);
  } catch (error) { warn(`정리 후보 고르기 실패: ${error.message}`); }
}
