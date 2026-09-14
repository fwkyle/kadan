import {appendStream,readStream,storageMode,storagePath} from './storage.mjs';
// 원장 — 바닥과 무관한 append-only 사건. 저장 backend는 공통 저장 경계가 선택한다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function ledgerHome() {
  return process.env.KADAN_HOME || process.env.KADAN_LITE_HOME || path.join(os.homedir(), ".kadan");
}

export function ledgerPath() {
  return storageMode(ledgerHome())==='sqlite'?storagePath(ledgerHome()):path.join(ledgerHome(), "ledger.jsonl");
}

export function resolveLedgerBy({ source, env = process.env } = {}) {
  if (source === "watch") return "watch";
  return env.KADAN_ROLE || "사람";
}

export function ledgerBy(entry) {
  return typeof entry?.by === "string" && entry.by ? entry.by : "모름";
}

export function appendLedger(entry, home = ledgerHome()) {
  fs.mkdirSync(home, { recursive: true });
  const line = JSON.stringify({ t: new Date().toISOString(), ...entry });
  appendStream(home, "ledger.jsonl", JSON.parse(line));
  return line;
}

// 본문은 원장이 아니라 옆 파일에 둔다 (2026-09-06 [kyle] 승인).
// 원장은 append-only라 줄을 못 지우는데, 본문에 비밀이 섞이면 지울 방법이 없다.
// 옆 파일은 그 파일 하나만 지우면 되고 원장은 그대로 남는다.
export function mailDir(home = ledgerHome()) {
  return path.join(home, "mail");
}

// 보낸 본문을 지문 이름의 파일로 남긴다. 같은 지문이면 같은 본문이라 덮어써도 같다.
export function saveMailBody(digestValue, message, home = ledgerHome()) {
  if (!digestValue || typeof message !== "string") return null;
  const dir = mailDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${digestValue}.txt`);
  fs.writeFileSync(file, message);
  return file;
}

// 없으면 null이다. 사람이 지웠을 수도 있고 옛 편지일 수도 있다 — 둘 다 정상이다.
export function readMailBody(digestValue, home = ledgerHome()) {
  if (!digestValue) return null;
  const file = path.join(mailDir(home), `${digestValue}.txt`);
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function readLedger(home = ledgerHome()) {
  const file = path.join(home, "ledger.jsonl");
  if (storageMode(home)==='jsonl'&&!fs.existsSync(file)) return [];
  // 원문 조회에서는 입력 주소 쌍만 중복 제거한다. 카드 연결/별칭의 최초 done은 계산 시 결정한다.
  const seenDone = new Set();
  const sqliteRows=storageMode(home)==='sqlite'?readStream(home,'ledger.jsonl',{optional:true}):null;
  return (sqliteRows?sqliteRows.map(JSON.stringify).join('\n'):fs.readFileSync(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { t: null, broken: line };
      }
    })
    .filter((entry) => {
      if (entry?.kind !== "done" || !entry.role || !entry.taskId) return true;
      const key = `${entry.role}\0${entry.taskId}\0${entry.executionKey || ""}`;
      if (seenDone.has(key)) return false;
      seenDone.add(key);
      return true;
    });
}
