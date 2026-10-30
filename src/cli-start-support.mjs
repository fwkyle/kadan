// start·stop 보조 — 창 선택·로티 사전 점검·시작/종료 기록 (HW-3-impl: cli.mjs에서 옮김)
import { conversationOf } from "./conversation-ref.mjs";
import { openTaskIds } from "./handover-state.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { floor } from "./floor.mjs";
import { resolveLedgerBy } from "./ledger.mjs";
import {
  closeRottieWindow,
  removeRottieWindow,
  showRottieWindow,
  rottieConnectivity,
  openWindow,
  tmux,
} from "./floor-tmux.mjs";
import { die } from "./cli-basics.mjs";
import { windowSettingBlock } from "./window-setting.mjs";

// Claude Code는 처음 보는 폴더에서 '폴더 신뢰' 확인 창을 띄우고, 발령의 Enter가 그 창의 "No, exit"를 눌러 역할이 사라진다
// (2026-10-23). 역할의 작업 폴더가 카단 기록 폴더(KADAN_HOME) 자신이거나 그 안이면 막는다. 안이면 그 기록 폴더 경로를, 아니면 null.
export function workdirInsideHome(cwd, home) {
  const real = value => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };
  const root = real(home), dir = real(cwd);
  const relative = path.relative(root, dir);
  // `..review` 같은 이름의 자식 폴더는 부모 경로가 아니다(검수 F3). 부모는 `..` 단독이나 `../`로 시작할 때뿐이다.
  const outside = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  return outside ? null : root;
}

export function workdirInsideHomeMessage(root) {
  return `작업 폴더가 카단 기록 폴더(${root}) 안이다 — 작업 저장소(worktree)에서 다시 실행하라`;
}

export function resolveWindowChoice(env = process.env) {
  const value = env.KADAN_WINDOW;
  if (!value) return { kind: "none" };
  if (value === "orca" || value === "rottie" || value === "none") {
    return { kind: value };
  }
  return { error: "KADAN_WINDOW_INVALID", value };
}

export function requireWindowChoice(env = process.env) {
  const blocked = windowSettingBlock(env);
  if (blocked) die(blocked, 2);
  const choice = resolveWindowChoice(env);
  if (choice.error) {
    die(
      `${choice.error}: KADAN_WINDOW=${choice.value} (orca|rottie|none만 허용)`,
      2
    );
  }
  if (choice.kind === "orca" && !env.KADAN_ORCA_BIN) {
    die("KADAN_ORCA_BIN_REQUIRED: KADAN_WINDOW=orca에는 절대경로가 필요하다", 2);
  }
  if (choice.kind === "rottie" && !env.KADAN_ROTTIE_BIN) {
    die("KADAN_ROTTIE_BIN_REQUIRED: KADAN_WINDOW=rottie에는 절대경로가 필요하다", 2);
  }
  return choice;
}

// 고정값이 없는데(환경변수도 기계 설정도 없음) 로티가 켜져 있으면 한 줄로 알린다. 자동으로 고르지 않고 시작도 막지 않는다.
// 호출 전에 adoptMachineWindow가 설정을 환경으로 채우므로, KADAN_WINDOW가 비어 있다는 것은 둘 다 없다는 뜻이다.
export function unpinnedWindowWarning({ env = process.env, listBinsFn } = {}) {
  if (env.KADAN_WINDOW) return null;
  const bins = (listBinsFn ?? listRunningRottieBins)();
  if (!bins.length) return null;
  return `경고: 창 선택이 고정되지 않았다 — 지금 켜진 로티(${bins[0]}${bins.length > 1 ? ` 외 ${bins.length - 1}개` : ""})가 보이지만 이번 시작은 백그라운드로 진행한다. ` +
    `로티로 고정: kadan window set rottie --rottie-bin <절대경로> / 백그라운드로 고정: kadan window set none`;
}

const ROTTIE_BIN_NAME = /(^|[\/])rottie$/i;

function rottieBinFromCommand(command) {
  if (typeof command !== "string") return null;
  const text = command.trim();
  if (!text.startsWith("/")) return null;
  const app = text.match(/^(\/.+?\/Contents\/MacOS\/rottie)(?:\s|$)/i);
  const unix = text.match(/^(\/\S*\/rottie)(?:\s|$)/i);
  const binary = app?.[1] ?? unix?.[1];
  if (!binary) return null;
  if (binary.includes("terminal-daemons")) return null;
  if (!ROTTIE_BIN_NAME.test(binary)) return null;
  return binary;
}

export function listRunningRottieBins({ spawnFn = spawnSync } = {}) {
  const result = spawnFn("ps", ["-axww", "-o", "command="], { encoding: "utf8" });
  const seen = new Set();
  const bins = [];
  for (const line of (result.stdout ?? "").split("\n")) {
    const bin = rottieBinFromCommand(line);
    if (!bin) continue;
    if (seen.has(bin)) continue;
    seen.add(bin);
    bins.push(bin);
  }
  return bins;
}

function formatRottiePreflightFailure({ reason, bin, connection, candidates }) {
  const shown = bin ?? "모름";
  const what =
    reason === "missing"
      ? "파일 없음: KADAN_ROTTIE_BIN=" + shown
      : "연결 실패: KADAN_ROTTIE_BIN=" +
        shown +
        " 번들 " +
        (connection?.bundleId ?? "모름") +
        "(빌드 " +
        (connection?.build ?? "모름") +
        ")에 " +
        (connection?.code ?? "모름");
  const listed = candidates.length
    ? candidates.map((item) => "  " + item).join("\n")
    : "  (지금 켜진 로티 실행 파일 없음)";
  return [
    what,
    "지금 켜진 로티 실행 파일 후보:",
    listed,
    "켜진 로티가 정확히 하나이고 연결될 때만 자동으로 붙는다. 지금은 후보가 하나가 아니거나 연결되지 않아 멈춘다.",
    "사람이 할 일: KADAN_ROTTIE_BIN을 위 후보 중 하나로 바꾼다.",
  ].join("\n");
}

export function inspectHiddenStartPolicy({
  env = process.env,
  floorName,
  hidden = false,
  roleProfile,
  reusing = false,
} = {}) {
  const forbidden =
    hidden === true &&
    floorName === "tmux" &&
    env.KADAN_WINDOW === "rottie" &&
    roleProfile != null &&
    reusing === false;
  if (!forbidden) return { ok: true };
  return {
    ok: false,
    message:
      `KADAN_HIDDEN_FORBIDDEN: KADAN_WINDOW=rottie에서 역할 프로필(${roleProfile}) 세션은 --hidden으로 시작할 수 없다 — 로티 창이 기본이다. ` +
      `로티가 없거나 연결 불가를 확인했을 때만 KADAN_WINDOW=none --hidden으로 백그라운드 시작한다 (worker-creation.md 92~94행).`,
  };
}

// 임시 장치: 로티 정식 출시로 경로가 고정되면 이 점검은 걷어낸다 (2026-09-06 [kyle] 결정).
export function inspectRottieStartPreflight({
  env = process.env,
  hidden = false,
  forceWindow = false,
  existsFn = fs.existsSync,
  connectFn = rottieConnectivity,
  listBinsFn = listRunningRottieBins,
} = {}) {
  const needsWindow = forceWindow || env.KADAN_WINDOW === "rottie";
  if (!needsWindow || hidden) return { ok: true, skipped: true };
  const bin = env.KADAN_ROTTIE_BIN;
  const candidates = listBinsFn();
  // 로컬 빌드 폴더가 정리되면 경로가 끊긴다. 켜진 로티가 정확히 하나이고 연결되면 그쪽에 붙는다
  // (2026-09-23 [kyle]: "현재 켜져 있는 로티에 딱 붙여 줘"). 여러 개면 어느 쪽인지 모르므로 멈춘다.
  const attach = (reason) => {
    if (env.KADAN_ROTTIE_AUTO_ATTACH === "off" || candidates.length !== 1 || candidates[0] === bin) return null;
    const to = candidates[0];
    const attached = connectFn({ bin: to });
    if (!attached?.ok) return null;
    env.KADAN_ROTTIE_BIN = to;
    return { ok: true, bin: to, connection: attached, candidates, switched: { from: bin ?? null, to, reason } };
  };
  if (!bin || !existsFn(bin)) {
    const switched = attach("missing");
    if (switched) return switched;
    return {
      ok: false,
      reason: "missing",
      bin,
      candidates,
      message: formatRottiePreflightFailure({ reason: "missing", bin, candidates }),
    };
  }
  const connection = connectFn({ bin });
  if (!connection?.ok) {
    const switched = attach("connect");
    if (switched) return switched;
    return {
      ok: false,
      reason: "connect",
      bin,
      connection,
      candidates,
      message: formatRottiePreflightFailure({
        reason: "connect",
        bin,
        connection,
        candidates,
      }),
    };
  }
  return { ok: true, bin, connection, candidates };
}

// 실행 명령에서 실행기(harness)와 모델을 읽어 원장에 남긴다. 판단에는 쓰지 않는다 —
// 사고 뒤 "어느 실행기·어느 모델이었나"를 원장만으로 답하기 위한 기록이다. 화면이 사라지면
// ps도 함께 사라진다. 실행기별 어댑터가 아니라 명령 첫 낱말과 --model 값을 그대로 옮긴다.
export function describeStartCmd(cmd) {
  if (typeof cmd !== "string" || !cmd.trim()) return {};
  const text = cmd.trim();
  const tokens = text.split(/\s+/);
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
  const harness = tokens[index]?.split("/").pop();
  // 따옴표를 벗겨서 남긴다. 안 벗기면 원장에 '\'kimi/k3[1m]\'' 처럼 따옴표째 박힌다(2026-09-12 실측).
  const model = text.match(/--model[=\s]+["']*([^\s"']+)["']*/)?.[1];
  return {
    ...(harness ? { harness } : {}),
    ...(model ? { model } : {}),
    ...conversationOf(text),
    cmd: text,
  };
}

export function buildStartLedgerEntry({
  floorName,
  role,
  session,
  evidence,
  window,
  rottieTerminalId,
  orcaTerminalHandle,
  reused,
  cmd,
  cwd,
  env = process.env,
}) {
  return {
    kind: "start",
    floor: floorName,
    role,
    session,
    by: resolveLedgerBy({ env }),
    ...describeStartCmd(cmd),
    ...(cwd ? { cwd } : {}),
    ...(evidence.panePid ? { panePid: evidence.panePid } : {}),
    ...(evidence.rottiePid ? { rottiePid: evidence.rottiePid } : {}),
    ...(evidence.rottieTerminalId
      ? { rottieTerminalId: evidence.rottieTerminalId }
      : {}),
    ...(evidence.rottieWorkspaceId
      ? { rottieWorkspaceId: evidence.rottieWorkspaceId }
      : {}),
    ...(evidence.rottieBuild ? { rottieBuild: evidence.rottieBuild } : {}),
    ...Object.fromEntries(["herdrSocket", "herdrWorkspaceId", "herdrPaneId", "herdrTerminalId"]
      .filter(key => evidence[key]).map(key => [key, evidence[key]])),
    window,
    ...(rottieTerminalId ? { rottieTerminalId } : {}),
    ...(orcaTerminalHandle ? { orcaTerminalHandle } : {}),
    ...(typeof reused === "boolean" ? { reused } : {}),
    ...(evidence.outputLog ? { outputLog: evidence.outputLog } : {}),
  };
}

// 종료 전에 그 역할이 받았지만 done이 없는 카드를 센다. 화면은 stop과 함께 사라지므로
// 그 뒤엔 아무도 결과를 증언할 수 없다 (2026-09-01 c31·c32·c34 미아 6건). 막지 않고 알린다.
export function pendingCardsFor(entries, role) {
  return openTaskIds(entries, role);
}

export function buildStopLedgerEntry({ role, session, env = process.env }) {
  return {
    kind: "stop",
    role,
    session,
    by: resolveLedgerBy({ env }),
  };
}

export function openStartedWindow(session, platform = process.platform, deps = {}) {
  let fields = {};
  if (deps.choice?.kind === "rottie") {
    const result = rottieConnectivity({ bin: deps.rottieBin ?? process.env.KADAN_ROTTIE_BIN, spawnFn: deps.spawnFn });
    fields = { rottieBundleId: result.bundleId, rottieConnect: result.ok ? "ok" : "failed" };
    if (!result.ok) {
      (deps.print ?? console.log)(`창 rottie 연결 안 됨: KADAN_ROTTIE_BIN 번들 ${result.bundleId ?? "모름"}(빌드 ${result.build ?? "모름"})에 ${result.code} — 켜진 로티가 이 번들이 아니면 KADAN_ROTTIE_BIN을 켜진 앱의 CLI로 바꾼다`);
      return { method: "manual", ...fields, rottieConnectError: String(result.code) };
    }
  }
  return { ...(openWindow(session, platform, deps) ?? { method: "manual" }), ...fields };
}

const WINDOW_MESSAGE_MAX = 200;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// 로티가 준 원인 문구를 원장에 한 줄로 남기려고 줄바꿈·제어 문자(C0·DEL·C1)를 공백 하나로 줄이고
// 글자(grapheme) 200개에서 자르고 잘렸으면 끝에 …를 붙인다. 이모지·분해 한글을 반으로 끊지 않는다.
export function cleanWindowMessage(message) {
  const text = String(message ?? "").replace(/[\p{Cc}\s]+/gu, " ").trim();
  if (text.length <= WINDOW_MESSAGE_MAX) return text;
  const kept = [];
  for (const { segment } of graphemes.segment(text)) {
    if (kept.length === WINDOW_MESSAGE_MAX) return `${kept.join("")}…`;
    kept.push(segment);
  }
  return text;
}

function messageField(name, message) {
  const text = cleanWindowMessage(message);
  return text ? { [name]: text } : {};
}

export function closeStartedWindow(lastStart, { env = process.env, closeFn = closeRottieWindow, removeFn = removeRottieWindow,
  connectFn = rottieConnectivity, showFn = showRottieWindow, existsFn = fs.existsSync,
  listBinsFn = listRunningRottieBins, print = console.log } = {}) {
  const terminalId = lastStart?.rottieTerminalId;
  if (!terminalId) return {};
  // start의 자식 프로세스가 교정한 환경은 감독에게 돌아가지 않는다. 종료할 때도 다시 확인한다.
  // 현재 KADAN_WINDOW와 무관하게, 실제로 열었던 로티 탭 기록을 기준으로 한다.
  const preflight = inspectRottieStartPreflight({env, forceWindow:true, existsFn, connectFn, listBinsFn});
  const fields = {rottieTerminalId:terminalId, ...(preflight.switched ? {rottieBinSwitched:preflight.switched} : {})};
  const failed = (code, message) => ({...fields, rottieWindowClosed:false, rottieWindowError:String(code),
    ...messageField("rottieWindowMessage", message)});
  if (!preflight.ok) {
    const code = preflight.connection?.code || (env.KADAN_ROTTIE_BIN ? "ENOENT" : "KADAN_ROTTIE_BIN 없음");
    print(`창 닫기 실패: ${terminalId} ${code} — ${preflight.message}`);
    return failed(code, preflight.connection?.message ?? preflight.message);
  }
  const bin = env.KADAN_ROTTIE_BIN;
  if (preflight.switched) print(`로티 경로 자동 교정: ${preflight.switched.from ?? "(없음)"} → ${bin}`);
  // 켜진 앱을 찾은 것만으로 다른 탭을 닫지 않는다. 원장에 있는 정확한 ID를 먼저 조회한다.
  const shown = showFn({bin, terminalId});
  if (!shown.ok) {
    print(`창 닫기 실패: ${terminalId} ${shown.code} — 대상 탭 조회 실패, 닫기·제거하지 않음`);
    return failed(shown.code, shown.message);
  }
  const result = closeFn({ bin, terminalId });
  if (!result.closed) {
    print(`창 닫기 실패: ${terminalId} ${result.code} (번들 ${preflight.connection?.bundleId ?? "모름"})`);
    return failed(result.code, result.message);
  }
  print(`창 닫힘: ${terminalId}`);
  // 닫힌 탭은 목록에 '종료됨'으로 남으므로 한 번 더 제거한다. 제거 실패는 기록만 하고 재시도하지 않는다.
  const removal = removeFn({ bin, terminalId });
  if (removal.removed) print(`탭 제거됨: ${terminalId}`);
  else print(`탭 제거 실패: ${terminalId} ${removal.code} — 탭이 '종료됨'으로 남는다`);
  return {
    ...fields,
    rottieWindowClosed: true,
    rottieWindowRemoved: removal.removed,
    ...(!removal.removed
      ? { rottieRemoveError: String(removal.code), ...messageField("rottieRemoveMessage", removal.message) }
      : {}),
  };
}
