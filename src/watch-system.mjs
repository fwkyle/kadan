import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function commandText(command, args, spawn) {
  const result = spawn(command, args, { encoding: "utf8" });
  return result.status === 0 ? (result.stdout ?? "").trim() : null;
}

const BASE_NAME = "kadan-watch";

function realOrSelf(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

// 기본 홈(~/.kadan, 링크면 실제 경로)의 감시기만 정확히 "kadan-watch".
// 다른 홈은 "kadan-watch:<폴더이름>-<실제경로 SHA-256 앞 16자(64비트)>"다. 같은 이름의 폴더는 해시로 구별하며,
// 서로 다른 경로가 같은 해시를 받을 확률은 무시할 만하지만 수학적으로 0은 아니다.
export function watchProcessName(home, defaultHome = path.join(os.homedir(), ".kadan")) {
  if (!home) return BASE_NAME;
  const real = realOrSelf(home);
  if (real === realOrSelf(defaultHome)) return BASE_NAME;
  const hash = createHash("sha256").update(real).digest("hex").slice(0, 16);
  const label = path.basename(real).replace(/[^\w.-]/g, "_").slice(0, 24);
  return `${BASE_NAME}:${label}-${hash}`;
}

export function assertSingleWatch(spawn, name = BASE_NAME) {
  process.title = name;
  const output = commandText("ps", ["-Ao", "pid=,command="], spawn);
  if (output == null) return;
  const duplicate = output
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
    .find(
      (match) =>
        match &&
        Number(match[1]) !== process.pid &&
        match[2] === name
    );
  if (duplicate) {
    throw new Error(`watch가 이미 실행 중이다 (PID ${duplicate[1]})`);
  }
}

// 사용자 알림은 user-notify.mjs 한 통로를 지난다(디스코드 → 시스템 알림 순). 호출하는 쪽 import 경로를 유지하려고 다시 내보낸다.
export { notifyUser } from "./user-notify.mjs";
