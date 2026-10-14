// kadan start (HW-3-impl: cli.mjs에서 옮김)
import { startRoleProfile } from "../role-instructions.mjs";
import { launchFor, launchForFallback, readSettings, PROFILE_ROLES } from "../runner-settings.mjs";
import { registerRoleManually, registerStartedRole } from "../hierarchy-register.mjs";
import { inspectStartCmdPolicy } from "../ai-identity.mjs";
import { floor } from "../floor.mjs";
import { appendLedger, ledgerHome, resolveLedgerBy, readLedger } from "../ledger.mjs";
import { mailboxLetters } from "../mailbox-state.mjs";
import { unreadForRole } from "../mail-generation.mjs";
import { roleNameWarning } from "../role-name.mjs";
import { conversationOf } from "../conversation-ref.mjs";
import { tmux } from "../floor-tmux.mjs";
import { die, sessionName, lastStartFor } from "../cli-basics.mjs";
import {
  requireWindowChoice,
  inspectHiddenStartPolicy,
  inspectRottieStartPreflight,
  buildStartLedgerEntry,
  openStartedWindow,
} from "../cli-start-support.mjs";

export function cmdStart(argv, flags) {
  const role = argv[0];
  if (!role) die("사용법: kadan start <역할> [--hidden] [--cmd <명령> [--reason 이유] | --fallback N --reason 이유] [--profile secretary|super|conductor|worker|reviewer]");
  const windowChoice = floor.name === "tmux" ? requireWindowChoice() : null;
  const preflight = inspectRottieStartPreflight({
    floorName: floor.name,
    hidden: Boolean(flags.hidden),
  });
  if (!preflight.ok) die(preflight.message, 2);
  if (preflight.switched) console.error(`로티 경로 자동 교정: ${preflight.switched.from ?? "(없음)"} → ${preflight.switched.to} (켜진 로티 1개, 연결 확인)`);
  const session = sessionName(role);
  const reusing = floor.alive(session);
  const roleProfile = startRoleProfile({home:ledgerHome(),role,profile:flags.profile,previous:reusing?lastStartFor(session):null,reusing});
  const hiddenPolicy = inspectHiddenStartPolicy({ floorName: floor.name, hidden: Boolean(flags.hidden), roleProfile, reusing });
  if (!hiddenPolicy.ok) die(hiddenPolicy.message, 2);
  // 실행 모델 설정이 있으면 --cmd 없이도 역할 기본 명령을 채운다. 다른 명령은 이유를 남긴다(2026-09-23 [kyle] 승인 1단계).
  let launch = null;
  if (!reusing && Object.hasOwn(PROFILE_ROLES, roleProfile ?? "")) {
    try { launch = launchFor(readSettings(ledgerHome()), roleProfile); } catch (error) { die(error.message, 2); }
  }
  if (launch && typeof flags.cmd === "string" && flags.cmd.trim() && flags.cmd.trim() !== launch.cmd) {
    if (typeof flags.reason !== "string" || !flags.reason.trim())
      die(`실행 모델 설정과 다른 명령이다 — --reason <이유>를 함께 줘라. 설정값: ${launch.cmd}`, 2);
  }
  // 폴백은 사람이나 감독이 번호로 고른다. 자동 전환은 없다(2026-09-23 [kyle] 승인 3단계).
  let fallback = null;
  if (flags.fallback !== undefined) {
    if (typeof flags.fallback !== "string" || !/^[1-9][0-9]*$/.test(flags.fallback)) die("--fallback에는 1부터 시작하는 번호가 필요하다", 2);
    if (typeof flags.reason !== "string" || !flags.reason.trim()) die("폴백 발령에는 --reason <이유>가 필요하다", 2);
    if (typeof flags.cmd === "string" || flags.cmd === true) die("--fallback과 --cmd는 함께 쓸 수 없다", 2);
    if (reusing) die(`이미 살아 있음: ${session} — 폴백은 새로 띄울 때만 쓴다`, 2);
    if (!Object.hasOwn(PROFILE_ROLES, roleProfile ?? "")) die("폴백 발령에는 --profile worker|reviewer|conductor|super가 필요하다", 2);
    try { fallback = launchForFallback(readSettings(ledgerHome()), roleProfile, flags.fallback); } catch (error) { die(error.message, 2); }
    flags.cmd = fallback.cmd;
  }
  const useSettings = !fallback && launch && !(typeof flags.cmd === "string" && flags.cmd.trim());
  if (useSettings) flags.cmd = launch.cmd;
  const launchRecord = fallback
    ? {
      launchSource:"fallback", fallbackIndex:fallback.fallbackIndex, fallbackReason:flags.reason.trim(),
      settingsRevision:fallback.revision, settingsPreset:fallback.preset, ...(launch ? {settingsCmd:launch.cmd} : {})
    }
    : !launch ? {} : useSettings || flags.cmd.trim() === launch.cmd
    ? {launchSource:"settings", settingsRevision:launch.revision, settingsPreset:launch.preset}
    : {launchSource:"override", overrideReason:flags.reason.trim(), settingsRevision:launch.revision, settingsCmd:launch.cmd};
  // 프로필을 단 새 pane은 실행 명령 없이 만들 수 없다 — 빈 셸에 카드 지시가 붙는 사고 차단.
  const cmdPolicy = inspectStartCmdPolicy({ roleProfile, cmd: flags.cmd, reusing });
  if (!cmdPolicy.ok) die(cmdPolicy.message, 2);
  // 새 세션을 만들 때만 이름을 본다. 과거에 쓴 이름이면 이전 세대 우편을 넘겨받지 않았다고 알리고,
  // 처음 쓰는 이름이면 이름 규칙을 안내한다. 둘 다 거절하지 않는다(mail-generation.mjs·role-name.mjs).
  let nameCheck = null;
  if (!reusing) {
    let previous = null, previousUnread = null;
    try {
      const entries = readLedger(ledgerHome());
      previous = entries.findLast(e => e.kind === "start" && (e.role ?? e.session?.replace(/^kadan-/, "")) === role) ?? null;
      if (previous) previousUnread = unreadForRole(mailboxLetters(entries), role);
    } catch { /* 원장을 못 읽으면 판단하지 않는다 */ }
    if (previous) {
      // 같은 대화를 resume으로 다시 열거나 --inherit-mail이면 바로 앞 세대를 이어간다. new·fork는 새 대화라 끊는다.
      const resumed = conversationOf(flags.cmd).conversationMode === "resume";
      const inherited = flags["inherit-mail"] === true || resumed;
      const kept = inherited ? unreadForRole(mailboxLetters(readLedger(ledgerHome())), role, { current: true }) : null;
      nameCheck = { nameReuse: { previousStartAt: previous.t ?? null, previousUnread: inherited ? kept : previousUnread, inherited } };
      console.error(`이름 재사용: '${role}'은 ${previous.t ?? "예전"}에 쓴 이름이다. ${inherited
        ? `이전 세대 ${kept ?? "?"}건 이어감(${resumed ? "같은 대화 resume" : "--inherit-mail, 바로 앞 세대만"}).`
        : `이전 세대 미확인 ${previousUnread ?? "?"}건은 넘겨받지 않았다(원장에는 그대로 있고 inbox --previous-generations로 본다). 바로 앞 세대를 이어받으려면 --inherit-mail.`}`);
    } else {
      const warning = roleNameWarning({ role, profile: roleProfile, cwd: process.cwd() });
      if (warning) { nameCheck = { nameWarning: warning }; console.error(warning); }
    }
  }
  let evidence;
  let startedCmd;
  if (reusing) {
    console.log(`이미 살아 있음: ${session}`);
    const existingPid = floor.pid(session);
    evidence =
      floor.name === "rottie"
        ? {
            rottieTerminalId: lastStartFor(session)?.rottieTerminalId,
            rottiePid: existingPid,
            rottieWorkspaceId: lastStartFor(session)?.rottieWorkspaceId,
            rottieBuild: lastStartFor(session)?.rottieBuild,
          }
        : floor.name === "herdr" ? { ...lastStartFor(session), panePid: existingPid }
        : { panePid: existingPid };
  } else {
    try {
      startedCmd = flags.cmd || undefined;
      evidence = floor.create({
        session,
        role,
        cwd: process.cwd(),
        cmd: startedCmd,
      });
    } catch (error) {
      die(error.message);
    }
  }

  const pid = evidence.panePid ?? evidence.rottiePid;
  let method = floor.name === "rottie" ? "rottie" : floor.name === "herdr" ? "manual" : "hidden";
  let rottieTerminalId;
  let orcaTerminalHandle;
  let reused;
  let rottieConnection = {};
  if (!flags.hidden && floor.name === "tmux") {
    if (process.platform === "darwin") {
      const window = openStartedWindow(session, process.platform, {
        choice: windowChoice,
        role,
        panePid: pid,
      });
      if (window && typeof window === "object") {
        method = window.method;
        rottieTerminalId = window.rottieTerminalId;
        orcaTerminalHandle = window.orcaTerminalHandle;
        reused = window.reused;
        const { rottieBundleId, rottieConnect, rottieConnectError } = window;
        rottieConnection = { rottieBundleId, rottieConnect, rottieConnectError };
      } else {
        method = "manual";
      }
    } else {
      method = "manual";
    }
  }

  try {
    appendLedger({ ...buildStartLedgerEntry({
      floorName: floor.name,
      role,
      session,
      evidence,
      window: method,
      rottieTerminalId,
      orcaTerminalHandle,
      reused,
      cmd: startedCmd,
      cwd: process.cwd(),
    }), ...rottieConnection, ...(roleProfile?{roleProfile}: {}), ...(nameCheck?.nameReuse && flags["inherit-mail"] === true ? { inheritMail: true, inheritedUnread: nameCheck.nameReuse.previousUnread } : {}), ...launchRecord, ...(preflight.switched ? { rottieBinSwitched: preflight.switched } : {}) });
  } catch (error) {
    // 시작 기록이 없는 세션은 다음 start에서 재사용으로 읽혀 막히고 감시에도 잡히지 않는다(2026-10-08).
    // 방금 만든 세션만 닫는다. 재사용한 세션은 남의 세대라 건드리지 않는다.
    if (reusing) throw error;
    let closed = true;
    try { floor.stop(session); } catch { closed = false; }
    die(`시작 기록 실패 — ${closed ? `방금 만든 ${session}을 닫았다` : `방금 만든 ${session}을 닫지 못했다(직접 확인)`}: ${error.message}`);
  }
  console.log(
    `시작됨: ${session} (${floor.name === "rottie" ? "Rottie PID" : "pane PID"} ${pid ?? "?"}, 창: ${method}${
      method === "manual" ? ` — 직접: ${floor.attach(session)}` : ""
    })`
  );
  // 감시 알림이 갈 곳을 사람이 따로 적지 않아도 되게 한다. 실패는 알리기만 하고 시작을 막지 않는다.
  // --parent가 있으면 만든 역할 대신 그 상위로 적는다(대화 옮기기: 비서가 대신 실행해도 상위는 사용자).
  const registration = typeof flags.parent === "string" ? registerRoleManually({ role, parent: flags.parent, home: ledgerHome() }) : registerStartedRole({
    role,
    cmd: startedCmd,
    profile: roleProfile,
    creator: resolveLedgerBy({ env: process.env }),
    home: ledgerHome(),
  });
  if (registration.registered) {
    console.log(`감시 등록: ${role} → ${registration.parent}`);
  } else if (registration.hierarchyPath && registration.reason !== "이미 등록됨") {
    // 관계표를 찾았는데도 못 적은 경우만 알린다. 관계표가 없는 환경은 정상이다.
    console.error(`감시 등록 안 됨(${registration.reason}) — 알림 수신자를 직접 확인하라`);
  }
  return nameCheck;
}
