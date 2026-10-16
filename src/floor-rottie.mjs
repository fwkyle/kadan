// Rottie CLI v1 바닥 — 공개 CLI 봉투만 사용하고 내부 파일 장부는 읽거나 쓰지 않는다.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLedger } from "./ledger.mjs";
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

function rottieBin() {
  const bin = process.env.KADAN_ROTTIE_BIN;
  if (!bin || !path.isAbsolute(bin)) {
    throw new RottieFloorError("KADAN_ROTTIE_BIN 절대경로가 필요하다", {
      code: "KADAN_ROTTIE_BIN_REQUIRED",
      effect: "none",
      exitCode: 2,
    });
  }
  return bin;
}

function runRottie(argv, spawnFn = spawnSync) {
  // 주입된 spawnFn은 실제 앱에 닿지 않는다. 진짜 spawnSync일 때만 운영 로티 접근을 막는다.
  if (spawnFn === spawnSync) assertNotLiveRottie();
  const result = spawnFn(rottieBin(), argv, {
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

function lastStartFor(session) {
  const starts = readLedger().filter(
    (entry) =>
      entry.kind === "start" &&
      entry.session === session &&
      entry.floor === "rottie" &&
      entry.rottieTerminalId
  );
  return starts[starts.length - 1] || null;
}

function terminalIdFor(session) {
  const terminalId = lastStartFor(session)?.rottieTerminalId;
  if (!terminalId) {
    throw new RottieFloorError(`원장에 Rottie 주소가 없다: ${session}`, {
      code: "KADAN_ROTTIE_ADDRESS_MISSING",
      effect: "none",
      exitCode: 1,
    });
  }
  return terminalId;
}

function showTerminal(session) {
  const terminalId = terminalIdFor(session);
  return runRottie(["terminal", "show", "--terminal", terminalId, "--json"]).result
    .terminal;
}

export function buildRottieSendArgv({
  terminalId,
  bodyFile,
  idempotencyKey,
  noEnter = false,
}) {
  return [
    "terminal",
    "send",
    "--terminal",
    terminalId,
    "--body-file",
    bodyFile,
    ...(noEnter ? ["--no-enter"] : []),
    "--idempotency-key",
    idempotencyKey,
    "--json",
  ];
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

export function buildRottieFloorCreateArgv({
  session,
  role,
  cwd,
  cmd,
  idempotencyKey,
}) {
  const command = cmd || process.env.SHELL || "/bin/zsh";
  const environmentRole = session.startsWith("kadan-")
    ? session.slice("kadan-".length)
    : role;
  return [
    "terminal",
    "create",
    "--workspace",
    cwd,
    "--title",
    role,
    "--command",
    `env KADAN_ROLE=${environmentRole} ${command}`,
    "--idempotency-key",
    idempotencyKey,
    "--json",
  ];
}

function create({ session, role, cwd, cmd }) {
  const idempotencyKey = `kadan-${session}-${Date.now()}`;
  const argv = buildRottieFloorCreateArgv({
    session,
    role,
    cwd,
    cmd,
    idempotencyKey,
  });

  let envelope;
  try {
    envelope = runRottie(argv);
  } catch (error) {
    if (
      error instanceof RottieFloorError &&
      error.code === "ROTTIE_WORKSPACE_NOT_OPEN" &&
      error.effect === "none"
    ) {
      runRottie(["workspace", "add", "--path", cwd, "--json"]);
      envelope = runRottie(argv);
    } else {
      throw error;
    }
  }
  return parseRottieCreateEvidence(envelope);
}

function alive(session) {
  if (!lastStartFor(session)) return false;
  return showTerminal(session).state === "running";
}

function pid(session) {
  if (!lastStartFor(session)) return null;
  const terminal = showTerminal(session);
  return terminal.pid == null ? null : String(terminal.pid);
}

function read(session, options = {}) {
  const terminalId = terminalIdFor(session);
  const argv = [
    "terminal",
    "output",
    "--terminal",
    terminalId,
    ...(options.since ? ["--since", options.since] : []),
    "--max-bytes",
    "1048576",
    "--json",
  ];
  const result = runRottie(argv).result;
  const chunks = Array.isArray(result?.chunks) ? result.chunks : [];
  return {
    text: chunks
      .map((chunk) => Buffer.from(chunk.bytesBase64 || "", "base64").toString("utf8"))
      .join(""),
    cursor: result?.nextCursor ?? null,
    gap: result?.gap ?? null,
    incremental: Boolean(options.since),
    terminal: result?.terminal,
    retention: result?.retention,
  };
}

export function sendRottieText({
  terminalId,
  session,
  text,
  baselineText,
  baselineGap = null,
  spawnFn = spawnSync,
  now = Date.now,
  tempRoot = os.tmpdir(),
}) {
  const tempDir = fs.mkdtempSync(path.join(tempRoot, "kadan-send-"));
  const bodyFile = path.join(tempDir, "body.txt");
  const enterFile = path.join(tempDir, "enter.txt");
  fs.writeFileSync(bodyFile, text, { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(enterFile, "\r", { encoding: "utf8", mode: 0o600 });
  try {
    const idempotencyKey = `kadan-send-${session}-${now()}`;
    const result = runRottie(
      buildRottieSendArgv({
        terminalId,
        bodyFile,
        idempotencyKey,
        noEnter: true,
      }),
      spawnFn
    ).result;
    const delivery = result?.delivery;
    if (!delivery?.bodySha256 || !Number.isInteger(delivery.sequence)) {
      throw new RottieFloorError("send 응답에 영수증 필드가 없다", {
        code: "ROTTIE_SEND_RESULT_INVALID",
        effect: "unknown",
        exitCode: 1,
      });
    }
    if (delivery.outputCursor) {
      runRottie([
        "terminal",
        "wait",
        "--terminal",
        terminalId,
        "--until",
        "output",
        "--since",
        delivery.outputCursor,
        "--timeout-seconds",
        "2",
        "--json",
      ], spawnFn);
    }
    const enterResult = runRottie(
      buildRottieSendArgv({
        terminalId,
        bodyFile: enterFile,
        idempotencyKey: `${idempotencyKey}-enter`,
        noEnter: true,
      }),
      spawnFn
    ).result;
    return {
      terminalId,
      sequence: delivery.sequence,
      enterSequence: enterResult?.delivery?.sequence,
      bodySha256: delivery.bodySha256,
      outputCursor:
        enterResult?.delivery?.outputCursor ?? delivery.outputCursor,
      deliveryId: delivery.id,
      baselineText,
      gap: baselineGap,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
}

function send(session, text) {
  const terminalId = terminalIdFor(session);
  const baseline = read(session);
  return sendRottieText({
    terminalId,
    session,
    text,
    baselineText: baseline.text,
    baselineGap: baseline.gap,
  });
}

function stop(session) {
  const terminalId = terminalIdFor(session);
  runRottie(["terminal", "close", "--terminal", terminalId, "--json"]);
}

function list() {
  const latestBySession = new Map();
  for (const entry of readLedger()) {
    if (entry.kind === "stop" || entry.kind === "start") latestBySession.delete(entry.session);
    if (
      entry.kind === "start" &&
      entry.floor === "rottie" &&
      entry.rottieTerminalId
    ) {
      latestBySession.set(entry.session, entry);
    }
  }
  return [...latestBySession.values()].flatMap((entry) => {
    let terminal;
    try {
      terminal = runRottie(["terminal", "show", "--terminal", entry.rottieTerminalId, "--json"]).result.terminal;
    } catch (error) {
      if (error instanceof RottieFloorError && error.code === "ROTTIE_TERMINAL_NOT_FOUND") return [];
      throw error;
    }
    return [{
      session: entry.session,
      alive: terminal.state === "running",
      pid: terminal.pid == null ? null : String(terminal.pid),
      state: terminal.state,
      terminalId: terminal.id,
    }];
  });
}

function waitForChange(session, ms, cursor) {
  if (!cursor) return null;
  const terminalId = terminalIdFor(session);
  const result = runRottie([
    "terminal",
    "wait",
    "--terminal",
    terminalId,
    "--until",
    "output",
    "--since",
    cursor,
    "--timeout-seconds",
    String(Math.max(1, Math.min(600, Math.ceil(ms / 1000)))),
    "--json",
  ]).result;
  return {
    reached: result?.reached === true,
    reason: result?.reason,
    cursor: result?.cursor,
  };
}

export const rottieFloor = {
  name: "rottie",
  create,
  alive,
  pid,
  send,
  read,
  stop,
  list,
  waitForChange,
  attach(session) {
    return `Rottie 패널 ${terminalIdFor(session)}에서 보세요`;
  },
};
