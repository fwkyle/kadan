import {storageMode,storagePath,storageSnapshot} from './storage.mjs';
import {appendDomainLedger,readLedgerState,projectLedger,domainProjector,ledgerStreams} from './ledger-domains.mjs';
import {assertTestHome} from './test-home-guard.mjs';
import {hydrateWatchRequest} from './watch-request-context.mjs';
export {classifyLedgerEntry} from './ledger-domains.mjs';
// 원장 — 바닥과 무관한 append-only 사건. 저장 backend는 공통 저장 경계가 선택한다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function ledgerHome() {
  const home = process.env.KADAN_HOME || process.env.KADAN_LITE_HOME;
  assertTestHome(home); // 시험 중에는 미지정·실사용 경로를 거부한다.
  return home || path.join(os.homedir(), ".kadan");
}

export function ledgerPath() {
  return storagePath(ledgerHome());
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
  assertTestHome(home);
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
  return projectLedger(readLedgerState(home,{domain:'tasks'}),'tasks');
}
export function readMailLedger(home = ledgerHome()) {
  return projectLedger(readLedgerState(home,{domain:'mail'}),'mail');
}
// 우편함 계산용: 우편 영역 + 역할 세대(start·stop) 기록. mail-generation.mjs가 같은 이름의 새 세션을 가른다.
export function readMailboxLedger(home = ledgerHome()) {
  return projectLedger(readLedgerState(home,{domain:'mailbox'}),'mailbox');
}
// 우편 중복 거르기용 좁은 조회: 수신자·sourceKey가 같은 send 사건 하나. 원장 전체를 읽고 검증하지 않는다.
// SQLite는 우편 영역(과거 원문 포함) 줄만 최신부터 훑고, 글자 포함(instr)으로 먼저 걸러 JSON 해석 없이 첫 일치에서 멈춘다.
// 그래서 방금 저장한 우편(재시작 중복)은 사건 수와 상관없이 바로 찾는다. 없다고 확인하는 데는 우편 영역 전체를 한 번 훑는다. 저장소가 없으면 null.
export function findMailBySourceKey(home,role,sourceKey) {
  if (storageMode(home) === 'none') return null;
  const needle = `"sourceKey":${JSON.stringify(sourceKey)}`;
  return storageSnapshot(home,db => {
    const row = db.prepare("SELECT payload FROM events NOT INDEXED WHERE stream IN ('ledger.jsonl','mail/events.jsonl') AND instr(payload,?)>0 AND json_extract(payload,'$.kind')='send' AND json_extract(payload,'$.role')=? ORDER BY rowid DESC LIMIT 1").get(needle, role);
    return row ? JSON.parse(row.payload) : null;
  });
}
// 받는 역할과 상관없이 같은 sourceKey의 우편을 찾는다. 디코 우편은 받는이가 우편마다 달라질 수 있어(비서 또는 레포 슈퍼) 중복 확인에 쓴다.
export function findMailBySourceKeyAny(home,sourceKey) {
  if (storageMode(home) === 'none') return null;
  const needle = `"sourceKey":${JSON.stringify(sourceKey)}`;
  return storageSnapshot(home,db => {
    const row = db.prepare("SELECT payload FROM events NOT INDEXED WHERE stream IN ('ledger.jsonl','mail/events.jsonl') AND instr(payload,?)>0 AND json_extract(payload,'$.kind')='send' ORDER BY rowid DESC LIMIT 1").get(needle);
    return row ? JSON.parse(row.payload) : null;
  });
}
export function readSystemLedger(home = ledgerHome()) {
  return projectLedger(readLedgerState(home,{domain:'system'}),'system');
}
// 복원 조회(recovery inspect)용 좁은 읽기: 시스템 영역 조회 가운데 start·stop·window만 같은 순서·같은 모양으로 낸다.
// Rottie가 15초마다 탭 수만큼 부르므로 원장 네 영역을 다 읽고 검증하지 않는다(2026-11-10 실측: 전체 약 1초).
// 그래서 전체 읽기가 잡던 원장 손상(순번·연결)은 여기서 보고하지 않는다. 복원 실행(restore)은 전체 읽기 그대로다.
// 원장이 10배면: 종류는 SQL에서 거르지만 색인이 없어 시스템 영역의 모든 행을 한 번씩 본다(걸리는 시간이 행 수에 비례).
// 사건 종류를 앞머리에서 읽는다: 저장되는 사건은 {"t":"<24자 시각>","kind":"<종류>" 로 시작한다(appendDomainLedger).
// 앞머리가 정확히 그 모양이고 그 구간에 따옴표·역슬래시가 없을 때만 앞머리를 믿고, 아니면 JSON을 해석한다(결과는 같다).
// 이유: 감시AI 호출 기록 약 4천 건이 건당 2만 자라, 종류 하나 보려고 모두 해석하면 조회의 절반 이상이 거기서 든다.
const RECOVERY_KIND = (() => {
  const plain = part => `instr(${part},'"')=0 AND instr(${part},char(92))=0`;
  const kindEnd = `instr(substr(payload,41,64),'"')`;
  const head = `substr(payload,1,6)='{"t":"' AND substr(payload,31,10)='","kind":"' AND ${kindEnd}>1`
    + ` AND ${plain('substr(payload,7,24)')} AND instr(substr(payload,41,${kindEnd}-1),char(92))=0`;
  return `CASE WHEN ${head} THEN substr(payload,41,${kindEnd}-1) ELSE json_extract(payload,'$.kind') END`;
})();
export function readRecoveryLedger(home = ledgerHome()) {
  if (storageMode(home) === 'none') return [];
  return storageSnapshot(home,db => {
    const read = db.prepare(`SELECT payload FROM events WHERE stream=?`
      + ` AND ${RECOVERY_KIND} IN ('start','stop','window') ORDER BY seq`);
    const rows = stream => read.all(stream).map(row => JSON.parse(row.payload));
    const project = domainProjector('system');
    return [...project.legacy(rows('ledger.jsonl')),...project.rows(rows(ledgerStreams.system))];
  });
}
// 감시AI 호출 기록 한 건의 원본(관계표 parents·경로표 routes 포함). 일반 조회는 이 큰 필드를 뺀다.
// requestId 글자 포함(instr)으로 먼저 걸러 해당 줄만 해석한다. 저장소가 없으면 null.
export function readWatchRequest(home,requestId) {
  if (storageMode(home) === 'none') return null;
  return storageSnapshot(home,db => {
    const row = db.prepare("SELECT payload FROM events NOT INDEXED WHERE stream='system/events.jsonl' AND instr(payload,?)>0 AND json_extract(payload,'$.kind')='watch-ai-request' AND json_extract(payload,'$.requestId')=? LIMIT 1").get(requestId,requestId);
    return row ? hydrateWatchRequest(db,JSON.parse(row.payload)) : null;
  });
}
