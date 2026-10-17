// kadan start (HW-3-impl: cli.mjs에서 옮김)
import { startRoleProfile } from "../role-instructions.mjs";
import { launchFor, launchForFallback, readSettings, PROFILE_ROLES } from "../runner-settings.mjs";
import { registerRoleManually, registerStartedRole, reparentStartedRole, isKadanToolCommand } from "../hierarchy-register.mjs";
import { inspectStartCmdPolicy } from "../ai-identity.mjs";
import { floor } from "../floor.mjs";
import { appendLedger, ledgerHome, resolveLedgerBy, readLedger } from "../ledger.mjs";
import { mailboxLetters } from "../mailbox-state.mjs";
import { unreadForRole } from "../mail-generation.mjs";
import { roleNameWarning } from "../role-name.mjs";
import { conversationOf } from "../conversation-ref.mjs";
import { tmux } from "../floor-tmux.mjs";
import { die, sessionName, lastStartFor, recordedPid } from "../cli-basics.mjs";
import { guardedSend } from "../cli-guarded-send.mjs";
import { briefStartedRole } from "../start-brief.mjs";
import {
  requireWindowChoice,
  inspectHiddenStartPolicy,
  inspectRottieStartPreflight,
  buildStartLedgerEntry,
  openStartedWindow,
  unpinnedWindowWarning,
} from "../cli-start-support.mjs";

export function cmdStart(argv, flags) {
  const role = argv[0];
  if (!role) die("사용법: kadan start <역할> [--hidden] [--cmd <명령> [--reason 이유] | --fallback N --reason 이유] [--profile secretary|super|conductor|worker|reviewer] [--no-prompt]");
  const windowChoice = floor.name === "tmux" ? requireWindowChoice() : null;
  if (floor.name === "tmux" && !flags.hidden) {
    const warning = unpinnedWindowWarning();
    if (warning) console.error(warning);
  }
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
      floor.name === "herdr" ? { ...lastStartFor(session), panePid: existingPid }
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

  const pid = evidence.panePid;
  let method = floor.name === "herdr" ? "manual" : "hidden";
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
    `시작됨: ${session} (pane PID ${pid ?? "?"}, 창: ${method}${
      method === "manual" ? ` — 직접: ${floor.attach(session)}` : ""
    })`
  );
  // 감시 알림이 갈 곳을 사람이 따로 적지 않아도 되게 한다. 실패는 알리기만 하고 시작을 막지 않는다.
  // --parent가 있으면 만든 역할 대신 그 상위로 적는다(대화 옮기기: 비서가 대신 실행해도 상위는 사용자).
  // --profile super는 --parent가 없으면 만든 쪽이 아니라 @user가 상위다(슈퍼감독은 사용자 직속 동료, 2026-10-14).
  const explicitParent = typeof flags.parent === "string" ? flags.parent : roleProfile === "super" ? "@user" : null;
  const creator = resolveLedgerBy({ env: process.env });
  const registration = explicitParent !== null ? registerRoleManually({ role, parent: explicitParent, home: ledgerHome() }) : registerStartedRole({
    role,
    cmd: startedCmd,
    creator,
    home: ledgerHome(),
  });
  // 같은 이름을 새 대화가 다시 쓰는 start(세대 경계: 이어가기가 아닌 이름 재사용)면 옛 상위 줄을 물려받지 않는다.
  // 이미 표에 있는 이름이거나 만든 쪽을 몰라 등록이 건너뛴 경우만 다룬다(A2, 2026-10-14).
  if (nameCheck?.nameReuse && !nameCheck.nameReuse.inherited && !isKadanToolCommand(startedCmd)
    && ["이미 등록됨", "만든 사람의 역할을 모름"].includes(registration.reason)) {
    const known = creator && creator !== "사람" && creator !== "watch" && creator !== role;
    const moved = reparentStartedRole({
      role,
      parent: explicitParent ?? (known ? creator : null),
      home: ledgerHome(),
      isAlive: child => floor.alive(sessionName(child)),
    });
    if (moved.changed) {
      console.error(`관계표 상위 변경: ${role}: ${moved.from} → ${moved.to} (같은 이름을 새 대화가 다시 써서 옛 상위 줄을 물려받지 않는다)`);
    } else if (moved.reason === "만든 쪽을 모름") {
      console.error(`관계표 상위 ${moved.from}를 그대로 둔다 — 만든 쪽을 몰라 바꾸지 않았다. 바꾸려면 --parent를 주고 다시 시작한다.`);
    } else if (!moved.same && moved.reason && moved.reason !== "관계표에 없음") {
      console.error(`관계표 상위를 바꾸지 못했다(${moved.reason}) — 옛 상위 ${moved.from ?? "?"}가 남아 있다`);
    }
    if (moved.children > 0 && (moved.changed || moved.reason === "만든 쪽을 모름")) {
      console.error(`옛 하위 ${moved.children}개(살아 있는 것 ${moved.aliveChildren}개)가 이 이름을 상위로 가리킨다. 끝난 역할은 \`kadan hierarchy prune\`.`);
    }
  }
  if (registration.registered) {
    console.log(`감시 등록: ${role} → ${registration.parent}`);
  } else if (registration.hierarchyPath && registration.reason !== "이미 등록됨") {
    // 관계표를 찾았는데도 못 적은 경우만 알린다. 관계표가 없는 환경은 정상이다.
    console.error(`감시 등록 안 됨(${registration.reason}) — 알림 수신자를 직접 확인하라`);
  }
  // 새로 만든 AI 세션이면 프로필 지침이 붙은 첫 안내를 한 번 보낸다. 못 보내도 start는 성공이다(start-brief.mjs).
  // 이번 start가 만든 세대(PID·로티 터미널)를 대기 전에 고정하고, 보내기 직전 현재 세대와 비교한다.
  const env = process.env;
  const pinnedPid = pid == null ? null : String(pid), pinnedTerminal = rottieTerminalId ?? evidence.rottieTerminalId ?? null;
  briefStartedRole({
    role, session, roleProfile, reusing, cmd: startedCmd, noPrompt: flags["no-prompt"] === true, floor,
    tries: Number(env.KADAN_START_BRIEF_TRIES) || undefined, intervalMs: Number(env.KADAN_START_BRIEF_INTERVAL_MS) || undefined,
    isCurrent: () => {
      if (pinnedPid === null || !floor.alive(session) || String(floor.pid(session)) !== pinnedPid) return false;
      const latest = lastStartFor(session);
      return String(recordedPid(latest)) === pinnedPid && (pinnedTerminal === null || latest?.rottieTerminalId === pinnedTerminal);
    },
    send: ({ role: to, session: target, message, roleProfile: profile }) =>
      guardedSend({ floor, session: target, role: to, message, roleProfile: profile, recordedPid: pinnedPid }),
  });
  return nameCheck;
}
