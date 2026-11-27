import {storageMode,storagePath,storageSnapshot,readStream} from './storage.mjs';
import {appendDomainLedger,readLedgerState,projectLedger,domainProjector,ledgerStreams,validateDomainEvent,uniqueDone,legacyCorrupt,SLIM_DROPPABLE} from './ledger-domains.mjs';
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
// 우편 전송 길(send·mail·dispatch)의 통합 조회. readLedger와 똑같이 원장 전체를 읽고 검증한다(손상 감지가 같다).
// 2026-11-27부터 명령은 같은 결과를 내는 좁은 읽기(readSendLedgerNarrow)를 쓰고, 이 함수는 그 비교 기준으로 남는다.
// 다른 점은 결과에서 전송 길이 읽지 않는 감시 사건 여섯 종류를 뺀다는 것 하나다. 나머지 줄의 내용과 순서는 readLedger와 같다.
// 이 여섯 종류가 통합 조회 결과의 절반 가까이를 차지한다(2026-11-13 실측: 91MB 중 약 43MB).
// 우편 재알림(watch-mail-reminder)은 우편함의 세대 판정(mail-rule.mjs)이 읽으므로 빼지 않는다.
// 전송 길의 코드가 아래 종류를 읽게 되면 이 목록에서 빼야 한다(tests/send-ledger-narrow.test.mjs가 소비 모듈을 지킨다).
// 어차피 버릴 줄이므로 감시 사건의 큰 본문(관계표·경로표·순회 시간표)은 SQL에서 먼저 뺀다(영역 조회와 같은 규칙).
// 원장이 10배면 읽는 줄 수와 메모리도 10배다(전체를 읽고 검증하는 구조는 그대로다).
export const SEND_UNUSED_KINDS = Object.freeze(['watch-cycle','watch-ai-request','watch-ai-call','watch-ai-report','watch-scope','watch-ai-retired']);
export function readSendLedger(home = ledgerHome()) {
  const unused = new Set(SEND_UNUSED_KINDS);
  return projectLedger(readLedgerState(home,{slimWatch:true})).filter(entry => !unused.has(entry?.kind));
}
export function readTaskLedger(home = ledgerHome()) {
  return projectLedger(readLedgerState(home,{domain:'tasks'}),'tasks');
}
export function readMailLedger(home = ledgerHome()) {
  return projectLedger(readLedgerState(home,{domain:'mail'}),'mail');
}
// 우편함 계산용: 우편 영역 + 역할 세대(start·stop) 기록. mail-generation.mjs가 같은 이름의 새 세션을 가른다.
// 원장 전체를 읽고 검증한다. 우편함 명령은 같은 결과를 내는 좁은 읽기(readMailboxLedgerNarrow)를 쓰고, 이 함수는 그 비교 기준으로 남는다.
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
const RECOVERY_HEAD = (() => {
  const plain = part => `instr(${part},'"')=0 AND instr(${part},char(92))=0`;
  const kindEnd = `instr(substr(payload,41,64),'"')`;
  return `substr(payload,1,6)='{"t":"' AND substr(payload,31,10)='","kind":"' AND ${kindEnd}>1`
    + ` AND ${plain('substr(payload,7,24)')} AND instr(substr(payload,41,${kindEnd}-1),char(92))=0`;
})();
const RECOVERY_KIND = (() => {
  const kindEnd = `instr(substr(payload,41,64),'"')`;
  return `CASE WHEN ${RECOVERY_HEAD} THEN substr(payload,41,${kindEnd}-1) ELSE json_extract(payload,'$.kind') END`;
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
// ── 좁은 읽기(2026-11-27 D1): 우편함 명령(inbox·mail·send)이 판정에 쓰는 줄만 SQL로 골라 읽는다 ──
// Why: 역할 수십 개가 명령을 칠 때마다 원장 네 영역 17만 줄을 읽고 검증해 명령 하나가 0.5GB 넘게 썼다(2026-11-21 패닉 2회).
// 결과는 위의 전체 읽기(readMailboxLedger·readSendLedger)와 같은 줄·같은 순서다. 전체 읽기 함수는 비교 기준으로 그대로 둔다
// (tests/ledger-narrow-read.test.mjs가 두 결과를 지문으로 맞춘다).
// 방식: SQL은 넓게(필요한 줄을 빠뜨리지 않게) 고르고, 정확한 고르기·모양 바꾸기는 전체 읽기와 같은 domainProjector가 한다.
//  - 과거 원문 영역(ledger.jsonl)은 통째로 읽는다. 종류 없는 줄·broken 줄의 판정(legacyCorrupt·.broken)이 전체 읽기와 같아야 해서다.
//  - 세 영역에서 고른 줄은 저장 순번(_ledgerOrder)으로 합친다. 시각으로 재정렬하지 않는다.
//  - 시스템 영역은 종류를 앞머리에서 읽어(RECOVERY_KIND) 큰 감시 줄을 JSON으로 풀지 않는다.
// 유지하는 손상 감지(읽은 줄에 한해): 과거 원문 손상(우편함), 줄 모양(validateDomainEvent), 영역 안 순번 역전, 읽은 줄끼리 순번 중복, 우편 ID 중복.
// 포기하는 손상 감지: 읽지 않은 줄의 모든 손상, 순번 빠짐(영역을 다 읽어야 안다), send/dispatch 짝, 완료 우편과 done의 연결.
// 이 넷은 전체 읽기(readLedger 계열)·감시기 시작·storage verify가 계속 잡는다. readRecoveryLedger와 같은 타협이다.
// 원장이 10배면: 우편함 읽기는 우편 영역 줄 수 + start·stop 수 + 과거 원문 줄 수에 비례한다(감시 줄은 SQL이 한 번씩 보기만 한다).
// 전송 길 읽기는 여섯 감시 종류와 dispatch를 뺀 줄 수에 비례한다. 둘 다 여전히 원장과 함께 자란다(증분 읽기는 후속 D2).
const NARROW_KINDS = list => list.map(kind => `'${kind}'`).join(',');
const NARROW_ALL = 'SELECT payload FROM events WHERE stream=? ORDER BY seq';
const MAILBOX_NARROW = [
  // 우편함이 작업 영역에서 쓰는 것은 완료 우편이 달린 done뿐이다(판정 근거).
  [ledgerStreams.tasks, `SELECT payload FROM events WHERE stream=? AND json_extract(payload,'$.kind')='done'`
    + ` AND json_type(payload,'$.completionMailId') IS NOT NULL ORDER BY seq`],
  [ledgerStreams.mail, NARROW_ALL],
  // 세대(start·stop)·인계(handover)·넣은 알림(watch-mail-reminder). 정확한 조건은 domainProjector('mailbox')가 거른다.
  [ledgerStreams.system, `SELECT payload FROM events WHERE stream=?`
    + ` AND ${RECOVERY_KIND} IN (${NARROW_KINDS(['start','stop','handover','watch-mail-reminder'])}) ORDER BY seq`],
];
const SEND_NARROW = [
  [ledgerStreams.tasks, `SELECT payload FROM events WHERE stream=? AND json_extract(payload,'$.kind') IS NOT 'dispatch' ORDER BY seq`],
  [ledgerStreams.mail, NARROW_ALL],
  // 남는 감시 줄의 큰 본문은 전체 읽기(slimWatch)와 같은 허용 목록으로 SQL에서 뺀다.
  [ledgerStreams.system, `SELECT CASE WHEN substr(${RECOVERY_KIND},1,6)='watch-'`
    + ` THEN json_remove(payload,${SLIM_DROPPABLE.map(key => `'$.${key}'`).join(',')}) ELSE payload END AS payload`
    + ` FROM events WHERE stream=? AND (${RECOVERY_KIND} IS NULL OR ${RECOVERY_KIND} NOT IN (${NARROW_KINDS(SEND_UNUSED_KINDS)})) ORDER BY seq`],
];
// 책임자 계산용: 통합 조회의 인계(handover) 줄만 같은 순서로 낸다.
const HANDOVER_NARROW = [
  [ledgerStreams.system, `SELECT payload FROM events WHERE stream=? AND ${RECOVERY_KIND}='handover' ORDER BY seq`],
];
function readNarrow(home, domain, plan) {
  if (storageMode(home) === 'none') return [];
  return storageSnapshot(home, db => {
    const legacy = readStream(home, 'ledger.jsonl', {optional: true});
    if (domain && legacyCorrupt(legacy)) throw new Error('과거 원장 손상: 도메인 조회 불가');
    const project = domainProjector(domain), kept = [];
    const mailIds = new Set(legacy.filter(row => row?.kind === 'send' && row.mailId).map(row => row.mailId));
    for (const [index, [stream, sql]] of plan.entries()) {
      let previous = 0;
      for (const row of db.prepare(sql).iterate(stream)) {
        const value = JSON.parse(row.payload);
        validateDomainEvent(stream, value);
        if (value._ledgerOrder <= previous) throw new Error(`도메인 원장 순서 손상: ${stream}`);
        previous = value._ledgerOrder;
        if (value.kind === 'send') {
          if (mailIds.has(value.mailId)) throw new Error('도메인 원장 중복 mailId');
          mailIds.add(value.mailId);
        }
        // 줄마다 바로 투영해 해석한 원본을 쥐고 있지 않는다(정점 메모리).
        for (const entry of project.rows([value])) kept.push({order: previous, index, entry});
      }
    }
    kept.sort((a, b) => a.order - b.order || a.index - b.index);
    for (let i = 1; i < kept.length; i++) {
      if (kept[i].order === kept[i - 1].order) throw new Error('도메인 원장 순번 중복');
    }
    return uniqueDone([...project.legacy(legacy), ...kept.map(item => item.entry)]);
  });
}
// readMailboxLedger와 같은 결과(우편 영역 + 세대·인계·완료 근거)를 필요한 줄만 읽어 낸다.
export function readMailboxLedgerNarrow(home = ledgerHome()) {
  return readNarrow(home, 'mailbox', MAILBOX_NARROW);
}
// readSendLedger와 같은 결과(통합 조회에서 감시 사건 여섯 종류를 뺀 것)를 그 줄을 읽지 않고 낸다.
export function readSendLedgerNarrow(home = ledgerHome()) {
  const unused = new Set(SEND_UNUSED_KINDS);
  return readNarrow(home, null, SEND_NARROW).filter(entry => !unused.has(entry?.kind));
}
// readLedger 결과에서 인계(handover) 줄만 고른 것과 같다. 업무 책임자 계산(effectiveWorkOwner)은 확정 인계만 보므로
// 우편의 차례 반환 판정이 원장 전체 대신 이것을 읽는다(운영 원장에 인계 줄은 수십 건이다).
export function readHandoverLedger(home = ledgerHome()) {
  return readNarrow(home, null, HANDOVER_NARROW).filter(entry => entry?.kind === 'handover');
}
const LIFECYCLE_KINDS = new Set(['start', 'stop', 'window']);
// 한 세션의 현재 세대 수명 사건(마지막 start부터의 start·stop·window)만 최신 쪽부터 거꾸로 읽는다(up --auto의 has-tab 빠른 길).
// 로티 탭 판정(currentRottieWindow·inheritsOnlyOldTab)은 그 세션의 마지막 start 이후 사건에만 달려 있어 결과가 전체 읽기와 같다.
// 이 읽기는 원장 전체를 검증하지 않는다. 판단할 수 없으면(저장소 없음·start 없음·해석 실패·broken) null을 돌려
// 호출한 쪽이 readSystemLedger 전체 검증으로 넘어가게 한다. 탭을 열거나 기록하기 전에는 반드시 그 전체 검증을 거친다.
// 원장이 10배면: SQL 스캔은 마지막 start 이후 구간의 행 수에 비례하고,
// JS 파싱·힙은 그 구간의 이 세션 수명 사건 수에만 비례한다.
export function readSessionLatestLifecycle(home = ledgerHome(), session) {
  if (storageMode(home) === 'none' || typeof session !== 'string') return null;
  try {
    return storageSnapshot(home, db => {
      const read = db.prepare(`SELECT payload FROM events WHERE stream=?`
        + ` AND ${RECOVERY_KIND} IN ('start','stop','window')`
        + ` AND json_extract(payload,'$.session')=? ORDER BY seq DESC`);
      const found = {system: [], legacy: []};
      for (const [name, stream] of [['system', ledgerStreams.system], ['legacy', 'ledger.jsonl']]) {
        for (const row of read.iterate(stream, session)) {
          const value = JSON.parse(row.payload);
          if (!value || typeof value !== 'object' || value.broken || value.session !== session
            || !LIFECYCLE_KINDS.has(value.kind)) return null;
          found[name].push(value);
          if (value.kind === 'start') {
            const project = domainProjector('system');
            return [...project.legacy(found.legacy.reverse()), ...project.rows(found.system.reverse())];
          }
        }
      }
      return null;
    });
  } catch { return null; }
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
