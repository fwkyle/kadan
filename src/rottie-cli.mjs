// Rottie 공개 CLI 호출 길목 — 창(KADAN_WINDOW=rottie)·시니어 탭·adopt가 함께 쓴다. 바닥은 아니다.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { assertNotLiveRottie } from "./live-floor-guard.mjs";

export class RottieFloorError extends Error {
  constructor(message, { code = "ROTTIE_UNKNOWN", effect = "unknown", exitCode = 1 } = {}) {
    super(`${code}: ${message}`);
    this.name = "RottieFloorError";
    this.code = code;
    this.effect = effect;
    this.exitCode = exitCode;
  }
}

function rottieBin(env = process.env) {
  const bin = env.KADAN_ROTTIE_BIN;
  if (!bin || !path.isAbsolute(bin)) {
    throw new RottieFloorError("KADAN_ROTTIE_BIN 절대경로가 필요하다", {
      code: "KADAN_ROTTIE_BIN_REQUIRED",
      effect: "none",
      exitCode: 2,
    });
  }
  return bin;
}

// 로티 실행 파일은 첫 인자가 아래 넷이 아니면 CLI가 아니라 앱 전체로 다시 떠서 약 3초 뒤 기존 창을 앞으로 가져온다
// (2026-10-16 로티 쪽 실측 BG-final). 인자 없음·--version·오타가 그 꼴이라 kyle의 포커스를 뺏는다. 실행 전에 막는다.
export const ROTTIE_CLI_VERBS = ["status", "workspace", "terminal", "recovery"];
export function assertRottieArgv(argv) {
  if (Array.isArray(argv) && ROTTIE_CLI_VERBS.includes(argv[0])) return;
  throw new RottieFloorError(
    `로티 실행 파일의 첫 인자는 ${ROTTIE_CLI_VERBS.join("|")} 중 하나여야 한다(받은 값: ${JSON.stringify(argv?.[0] ?? null)}) — 앱이 다시 떠 포커스를 뺏을 수 있어 실행하지 않는다`,
    { code: "ROTTIE_ARGV_REJECTED", effect: "none", exitCode: 2 }
  );
}

// env는 기본 process.env다. 시니어 탭처럼 호출자가 정한 환경으로 로티를 부르는 쪽이 같은 길목을 쓰게 한다.
export function runRottie(argv, spawnFn = spawnSync, env = process.env) {
  // 주입 spawnFn이어도 항상 적용한다(시험에서도 가드가 보이게).
  assertRottieArgv(argv);
  // 주입된 spawnFn은 실제 앱에 닿지 않는다. 진짜 spawnSync일 때만 운영 로티 접근을 막는다.
  if (spawnFn === spawnSync) assertNotLiveRottie(env);
  const result = spawnFn(rottieBin(env), argv, {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) {
    throw new RottieFloorError(result.error.message, {
      code: result.error.code || "ROTTIE_SPAWN_FAILED",
      effect: "unknown",
      exitCode: 1,
    });
  }

  let envelope;
  try {
    envelope = JSON.parse((result.stdout || "").trim());
  } catch {
    throw new RottieFloorError(
      `JSON 봉투를 읽지 못했다 (exit ${result.status ?? "?"})`,
      {
        code: "ROTTIE_JSON_PARSE",
        effect: result.status === 0 ? "unknown" : "none",
        exitCode: result.status || 1,
      }
    );
  }
  if (result.status !== 0 || envelope.ok !== true) {
    throw new RottieFloorError(
      envelope.error?.message || (result.stderr || "").trim() || "Rottie CLI 실패",
      {
        code: envelope.error?.code || "ROTTIE_UNKNOWN",
        effect: envelope.error?.effect || "unknown",
        exitCode: result.status || 1,
      }
    );
  }
  return envelope;
}
export function parseRottieCreateEvidence(envelope) {
  const terminal = envelope.result?.terminal;
  const build = envelope.runtime?.build;
  if (
    !terminal?.id ||
    terminal.state !== "running" ||
    typeof build !== "string" ||
    build.length === 0
  ) {
    throw new RottieFloorError(
      "create 응답에 실행 중인 terminal.id 또는 runtime.build가 없다",
      {
        code: "ROTTIE_CREATE_RESULT_INVALID",
        effect: "unknown",
        exitCode: 1,
      }
    );
  }
  return {
    rottieTerminalId: terminal.id,
    rottiePid: String(terminal.pid),
    rottieWorkspaceId: terminal.workspaceId,
    rottieBuild: build,
  };
}
