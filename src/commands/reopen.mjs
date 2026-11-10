// kadan reopen — 꺼진 역할을 stop 기록의 대화 번호로 같은 대화·작업 폴더·실행기·모델로 다시 연다. 본체는 ../reopen.mjs.
// restart는 살아 있는 창의 프로그램만 다시 띄우고, restore는 끊어진 로티 탭을 다시 붙인다. reopen은 카단이 끈 역할을 다시 연다.
import { floor } from "../floor.mjs";
import { appendLedger, ledgerHome, readLedger, resolveLedgerBy } from "../ledger.mjs";
import { currentSocket } from "../floor-tmux.mjs";
import { readSettings, runnerChoices } from "../runner-settings.mjs";
import { registerRoleManually, registerStartedRole } from "../hierarchy-register.mjs";
import { reopenRole } from "../reopen.mjs";
import { die, sessionName } from "../cli-basics.mjs";
import {
  requireWindowChoice, inspectHiddenStartPolicy, inspectRottieStartPreflight, openStartedWindow,
  unpinnedWindowWarning, inheritedWindowWarning,
} from "../cli-start-support.mjs";

export const REOPEN_USAGE = "사용법: kadan reopen <역할> [--hidden]";

// reopenRole이 쓰는 실제 의존성. 창 규칙은 kadan start와 같다(창 선택·로티 사전 점검·역할 프로필의 --hidden 금지).
export function reopenDeps(home, { env = process.env, hidden = false, windowDeps = {} } = {}) {
  const choice = requireWindowChoice(env);
  return {
    read: () => readLedger(home),
    record: entry => appendLedger(entry, home),
    modelChoices: (settings, runner) => runnerChoices(settings, runner),
    windowPolicy: ({ roleProfile }) => {
      const preflight = inspectRottieStartPreflight({ env, floorName: floor.name, hidden });
      if (!preflight.ok) throw new Error(preflight.message);
      if (preflight.switched) console.error(`로티 경로 자동 교정: ${preflight.switched.from ?? "(없음)"} → ${preflight.switched.to} (켜진 로티 1개, 연결 확인)`);
      const policy = inspectHiddenStartPolicy({ env, floorName: floor.name, hidden, roleProfile, reusing: false });
      if (!policy.ok) throw new Error(policy.message);
      return preflight.switched ? { rottieBinSwitched: preflight.switched } : {};
    },
    openWindow: ({ session, role, cwd, panePid }) =>
      process.platform === "darwin" ? openStartedWindow(session, process.platform, { ...windowDeps, choice, role, cwd, panePid }) : { method: "manual" },
    // 관계표: 이미 있으면 그대로 두고, 정리(prune)로 빠졌으면 start와 같은 규칙으로 다시 넣는다(슈퍼감독은 @user 직속).
    register: ({ role, cmd, roleProfile }) => roleProfile === "super"
      ? registerRoleManually({ role, parent: "@user", home })
      : registerStartedRole({ role, cmd, creator: resolveLedgerBy({ env }), home }),
  };
}

export function cmdReopen(argv, flags) {
  const role = argv[0];
  if (!role) die(REOPEN_USAGE);
  if (floor.name !== "tmux") die("reopen은 tmux 바닥에서만 쓴다", 2);
  // restart와 같은 이유로 정확한 이름만 받는다(정규화 전후가 다르면 원장·세션·우편이 다른 이름을 본다).
  const canonical = sessionName(role).slice("kadan-".length);
  if (canonical !== role) die(`역할 이름이 정확하지 않다('${role}'는 정규화하면 '${canonical}') — 정확한 이름으로 다시 실행한다`);
  const home = ledgerHome();
  const session = sessionName(role);
  const hidden = flags.hidden === true;
  const inherited = inheritedWindowWarning({ home, socket: currentSocket() });
  if (inherited) console.error(inherited);
  if (!hidden) {
    const warning = unpinnedWindowWarning();
    if (warning) console.error(warning);
  }
  const deps = reopenDeps(home, { hidden });
  let result;
  try {
    let settings = null;
    try { settings = readSettings(home); } catch (error) { throw new Error(`실행 모델 설정을 읽지 못했다: ${error.message}`); }
    result = reopenRole({ home, role, session, floor, settings, deps, hidden });
  } catch (error) { die(error.message); }
  console.log(`다시 열림: ${session} (${result.harness} ${result.model}, 대화 ${result.conversation}, pane PID ${result.panePid ?? "?"}, 창: ${result.window}${
    result.window === "manual" ? ` — 직접: ${floor.attach(session)}` : ""})`);
  if (!result.storedChecked) console.error(`대화 파일이 남아 있는지는 확인하지 못했다(${result.harness} 설정에 stored 칸 없음) — 화면에서 같은 대화가 이어졌는지 확인하라: kadan read ${role}`);
  const registration = result.registration;
  if (registration?.registered) console.log(`감시 등록: ${role} → ${registration.parent}`);
  else if (registration?.hierarchyPath && registration.reason !== "이미 등록됨") console.error(`감시 등록 안 됨(${registration.reason}) — 알림 수신자를 직접 확인하라`);
}
