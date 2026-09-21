// AI 실행기 신원 경계 — 2026-09-21 사고.
// `kadan start <역할> --profile <프로필>`을 --cmd 없이 실행하면 AI가 아닌 빈 셸 pane이
// 생기고, 이후 `kadan send --task/--execution`이 역할 지침과 카드 본문을 그 셸
// 프롬프트에 명령으로 붙여넣는다. 모델을 명시하지 않은 실행기 세션도 역할과 무관한
// 전역 기본 모델을 상속한다.
//
// 이 모듈은 두 경계를 검사한다.
// 1) inspectStartCmdPolicy — 프로필 세션의 새 pane 생성에 --cmd가 있는가.
// 2) inspectCardSendIdentity — 카드 연결 send 대상의 현재 세대를 시작한 명령이
//    등록 실행기이고 모델이 지정됐는가. 판정은 마지막 stop 이후의 start 기록에서
//    현재 pane PID와 같은 기록의 cmd를 읽는다. 이전 세대의 신원은 소급하지 않는다.
// 둘 다 실패하면 닫힌다 — 붙여넣기·Enter·send 원장 기록 모두 없다.

// 카드 발령을 받을 수 있는 실행기 — agent-runners.json의 등록 실행기와 같다.
export const AI_HARNESS_NAMES = new Set(["codex", "omo", "claude", "devin"]);

// 단일 셸 명령만 허용한다. 인용 문자열은 한 인자로 유지하고 셸 연산/확장은 거부한다.
export function commandWords(command) {
  if (typeof command !== "string") return null;
  const words = []; let word = "", quote = "", started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "\n" || c === "\r") return null;
    if (quote) {
      if (c === quote) { quote = ""; continue; }
      if (quote === '"' && /[$`\\]/.test(c)) return null;
      word += c; continue;
    }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (/\s/.test(c)) {
      if (started) words.push(word);
      word = ""; started = false; continue;
    }
    if (/[;&|<>#()$`\\*?{}~]/.test(c)) return null;
    word += c; started = true;
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

function modelOf(args) {
  let model = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") break;
    if (["--help", "-h", "--version", "-V"].includes(args[i])) return null;
    if (args[i] === "--model" || args[i] === "-m") {
      const value = args[++i];
      if (!value || value.startsWith("-") || /\s/.test(value)) return null;
      model = value;
    } else if (args[i].startsWith("--model=")) {
      const value = args[i].slice(8);
      if (!value || value.startsWith("-") || /\s/.test(value)) return null;
      model = value;
    }
  }
  return model;
}

// ps의 실제 실행 인자에서 실행 파일 또는 Node/Bun 스크립트 자리만 확인한다.
// 프롬프트/주석에 등장하는 실행기 이름은 프로세스 신원이 아니다.
export function matchesAiProcess(args, harness) {
  const words = args.trim().split(/\s+/);
  const base = value => value?.split("/").pop();
  const executable = base(words[0]);
  if (executable === harness) return true;
  return ["node", "bun", "nodejs"].includes(executable) &&
    [harness, `${harness}.js`, `${harness}.mjs`, `${harness}.cjs`].includes(base(words[1]));
}

// 프로필을 달고 새 pane을 만들 때는 실행 명령이 필수다. 살아있는 세대 재사용에는
// 새 프로세스가 없으므로 명령을 요구하지 않는다.
export function inspectStartCmdPolicy({ roleProfile, cmd, reusing = false } = {}) {
  if (roleProfile == null || reusing) return { ok: true };
  if (typeof cmd === "string" && cmd.trim()) return { ok: true };
  return {
    ok: false,
    reason: "profile-needs-cmd",
    message:
      `KADAN_PROFILE_NEEDS_CMD: 역할 프로필(${roleProfile}) 세션을 --cmd 없이 만들 수 없다 — ` +
      `--cmd '<실행기> --model <모델> ...'로 AI 실행 명령을 붙여라. 빈 셸 pane에 카드 지시가 ` +
      `붙여넣어지는 사고를 막는 경계다. 살아있는 세대의 재사용은 명령 없이 허용된다.`,
  };
}

// 카드 연결 send 대상의 AI 신원. entries는 원장 사건 목록, currentPid는 floor.pid의
// 실측값이다. 성공이면 {ok:true, harness, model}, 실패면 {ok:false, reason, message}.
// reason: no-ai-launch(현재 pane의 실행 명령 기록 없음) · not-ai(등록 실행기 아님) ·
// no-model(실행기지만 모델 미지정).
export function inspectCardSendIdentity({ entries, session, currentPid } = {}) {
  const generation = [];
  for (const entry of entries ?? []) {
    if (entry?.kind === "stop" && entry.session === session) generation.length = 0;
    else if (entry?.kind === "start" && entry.session === session) generation.push(entry);
  }
  const panePid = String(currentPid ?? "");
  const live = panePid
    ? generation.filter(
        (e) => String(e.panePid ?? e.rottiePid ?? "") === panePid
      )
    : [];
  const launch = live.find((e) => typeof e.cmd === "string" && e.cmd.trim());
  if (!launch) {
    return {
      ok: false,
      reason: "no-ai-launch",
      message:
        `카드 전송 불가: ${session}의 현재 pane을 AI로 시작한 기록(--cmd)이 없다 — ` +
        `빈 셸이나 기록 없는 pane에는 카드를 보내지 않는다`,
    };
  }
  const words = commandWords(launch.cmd);
  if (!words) return {ok:false, reason:"unsafe-command", message:"카드 전송 불가: 단일 AI 실행 명령만 허용한다 (셸 결합·주석·확장 불가)"};
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  const harness = words.shift()?.split("/").pop() ?? "";
  if (!AI_HARNESS_NAMES.has(harness)) {
    return {
      ok: false,
      reason: "not-ai",
      harness,
      message:
        `카드 전송 불가: ${session}의 시작 명령은 등록 AI 실행기(codex·omo·claude·devin)가 ` +
        `아니다: ${launch.cmd.slice(0, 80)}`,
    };
  }
  const model = modelOf(words);
  if (!model) {
    return {
      ok: false,
      reason: "no-model",
      harness,
      message:
        `카드 전송 불가: ${session}의 시작 명령에 모델이 없다(--model/-m) — ` +
        `모델을 확인할 수 없는 AI 세션에는 카드를 보내지 않는다`,
    };
  }
  return { ok: true, harness, model, launch };
}
