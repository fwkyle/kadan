import {storageMode,storagePath} from './storage.mjs';
import {appendDomainLedger,readLedgerState,projectLedger} from './ledger-domains.mjs';
export {classifyLedgerEntry} from './ledger-domains.mjs';
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
  return appendDomainLedger(entry,home);
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

// 읽기용 호환 투영: 과거 원문 뒤에 새 저장 순서로 이어 붙인다. 시각으로 재정렬하지 않는다.
export function readLedger(home = ledgerHome()) {
  return projectLedger(readLedgerState(home));
}
export function readTaskLedger(home = ledgerHome()) {
  return projectLedger(readLedgerState(home),'tasks');
}
export function readMailLedger(home = ledgerHome()) {
  return projectLedger(readLedgerState(home),'mail');
}
export function readSystemLedger(home = ledgerHome()) {
  return projectLedger(readLedgerState(home),'system');
}
