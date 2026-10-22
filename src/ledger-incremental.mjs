// Why: 감시기는 주기마다 원장 사건 약 7만 개를 처음부터 다시 읽고 검증·투영했다. 커서 뒤 새 사건만 이어 붙여 같은 결과를 낸다.
// SQLite 저장 전용이다. JSONL 저장은 지금처럼 전체를 읽는다. 상태는 디스크에 쓰지 않고 프로세스 안에만 둔다.
//
// 실패는 두 갈래이고 이름이 다르다.
//  (a) 새 묶음 검증 실패(순번 빈틈·mailId 중복·완료 우편 짝 깨짐·인계 충돌): 증분 상태와 커서를 함께 버리고,
//      전체 읽기가 내는 예외를 그대로 던진다. 다음 호출은 전체 다시 읽기로 시작한다.
//  (b) 어긋남 감지(끝 순번 감소·끝 행 지문 다름·DB 파일 교체·옛 원문 변경): 한 줄 로그를 남기고 전체 다시 읽는다.
// 전체 검증은 시작·복원·DB 교체 때만 한다. 주기에서는 새 행만 검증하므로, 옛 행이 손상돼도 주기마다 잡던 일은 사라진다.
import {createHash} from 'node:crypto';
import path from 'node:path';
import {storageMode,storageSnapshot,streamHeads,streamRowPayload,databaseIdentity,readStream} from './storage.mjs';
import {ledgerStreams,slimWatchRequest,createDomainValidator,readLedgerState,projectLedger,
  domainProjector,legacyCorrupt,createUniqueDone} from './ledger-domains.mjs';

const LEGACY = 'ledger.jsonl';
const names = Object.values(ledgerStreams);
const states = new Map();
const counts = {full:0,incremental:0,unchanged:0,drift:0,rejected:0};
const sha = text => createHash('sha256').update(text).digest('hex');
const slimOf = stream => stream === ledgerStreams.system ? slimWatchRequest : null;

// 한 스냅샷 안에서 전체를 읽어 상태를 만든다. 검증에 실패하면 예외를 그대로 던지고 상태는 만들어지지 않는다.
function build(home) {
  const heads = streamHeads(home,[LEGACY,...names]);
  const legacy = readStream(home,LEGACY,{optional:true});
  const streams = new Map(names.map(stream => [stream,readStream(home,stream,{optional:true,slim:slimOf(stream)})]));
  const validator = createDomainValidator(legacy);
  const ordered = validator.add(streams);
  const cursors = new Map(),prints = new Map();
  for (const stream of [LEGACY,...names]) {
    const head = heads.get(stream);
    cursors.set(stream,head?.seq ?? 0);
    prints.set(stream,head ? sha(head.payload) : null);
  }
  return {cursors,prints,validator,view:{legacy,streams,ordered},legacyBad:legacyCorrupt(legacy),projections:new Map()};
}

// 커서 뒤 새 사건만 읽어 이어 붙인다. 어긋나면 {drift:이유}, 검증에 실패하면 예외, 바뀐 게 없으면 st 그대로.
function advance(home,st) {
  const heads = streamHeads(home,[LEGACY,...names]);
  if (databaseIdentity(home) !== st.identity) return {drift:'DB 파일 식별값이 바뀜(파일 교체)'};
  const next = new Map();
  for (const stream of [LEGACY,...names]) {
    const head = heads.get(stream),seq = head?.seq ?? 0,had = st.cursors.get(stream);
    if (seq < had) return {drift:`${stream} 끝 순번 감소 ${had}→${seq}`};
    if (stream === LEGACY && seq !== had) return {drift:'옛 원문(ledger.jsonl) 변경'};
    if (had > 0) {
      const payload = seq === had ? head.payload : streamRowPayload(home,stream,had);
      if (payload === null || sha(payload) !== st.prints.get(stream)) return {drift:`${stream} 순번 ${had} 행 지문 다름`};
    }
    next.set(stream,{seq,head});
  }
  // 새 행 읽기에는 LIMIT·나눠 읽기를 두지 않는다. send+dispatch(+완료 우편) 묶음 경계를 자르지 않으려는 것이다.
  const fresh = new Map(names.map(stream => [stream,next.get(stream).seq > st.cursors.get(stream)
    ? readStream(home,stream,{optional:true,slim:slimOf(stream),after:st.cursors.get(stream)}) : []]));
  if (![...fresh.values()].some(rows => rows.length)) return st;
  const added = st.validator.add(fresh);
  const streams = new Map(st.view.streams);
  for (const stream of names) {
    if (!fresh.get(stream).length) continue;
    streams.set(stream,st.view.streams.get(stream).concat(fresh.get(stream)));
    st.cursors.set(stream,next.get(stream).seq);
    st.prints.set(stream,sha(next.get(stream).head.payload));
  }
  // 버전마다 새 배열을 준다(사건 객체는 공유). 들고 있는 배열을 제자리에서 늘려 밖으로 내주지 않는다.
  st.view = {legacy:st.view.legacy,streams,ordered:st.view.ordered.concat(added)};
  return st;
}

function rebuild(home,key) {
  // 파일 식별값을 읽기 전·후에 잰다. 읽는 도중 파일이 바뀌었으면 옛 데이터에 새 식별값이 붙으므로 한 번 더 읽고, 또 바뀌면 포기한다.
  for (let attempt = 0; attempt < 2; attempt++) {
    const identity = databaseIdentity(home);
    const st = storageSnapshot(home,() => build(home));
    if (databaseIdentity(home) !== identity) continue;
    st.identity = identity;
    states.set(key,st);counts.full++;
    return st;
  }
  throw new Error('원장 DB 파일이 읽는 도중 바뀜: 잠시 뒤 다시 시도');
}

function current(home,log) {
  const key = path.resolve(home),had = states.get(key);
  if (!had) return rebuild(home,key);
  const before = had.view;
  let out;
  try { out = storageSnapshot(home,() => advance(home,had)); }
  catch {
    // (a) 검증 실패: 상태와 커서를 함께 버리고 전체 읽기로 확정한다. 전체 읽기도 실패하면 그 예외가 곧 전체 읽기의 예외다.
    states.delete(key);counts.rejected++;
    return rebuild(home,key);
  }
  if (out.drift) {
    // (b) 어긋남: 조용히 넘기지 않는다.
    states.delete(key);counts.drift++;
    log(`[원장 증분 읽기] 전체 다시 읽기: ${out.drift}`);
    return rebuild(home,key);
  }
  if (out.view === before) counts.unchanged++;
  else counts.incremental++;
  return out;
}

export function readLedgerStateIncremental(home,{log = console.error} = {}) {
  if (storageMode(home) !== 'sqlite') return readLedgerState(home);
  return current(home,log).view;
}

// readLedger / readTaskLedger / readMailLedger / readMailboxLedger / readSystemLedger와 같은 결과. 영역(domain)마다 투영 상태를 따로 둔다.
// uniqueDone의 본 키 집합은 영역 사이에 공유하지 않는다 — 영역 필터를 거친 뒤의 첫 완료여야 한다.
export function readLedgerIncremental(home,{domain = null,log = console.error} = {}) {
  if (storageMode(home) !== 'sqlite') return projectLedger(readLedgerState(home,{domain}),domain);
  const st = current(home,log),key = domain ?? '';
  let memo = st.projections.get(key);
  if (!memo) {
    if (domain && st.legacyBad) throw new Error('과거 원장 손상: 도메인 조회 불가');
    const project = domainProjector(domain),unique = createUniqueDone();
    memo = {project,unique,out:project.legacy(st.view.legacy).filter(unique),upTo:0};
    st.projections.set(key,memo);
  }
  const rows = st.view.ordered;
  if (memo.upTo < rows.length) {
    memo.out = memo.out.concat(memo.project.rows(rows.slice(memo.upTo)).filter(memo.unique));
    memo.upTo = rows.length;
  }
  return memo.out;
}

// 시험·진단용. 상태가 없으면 null.
export function incrementalInfo(home) {
  const st = states.get(path.resolve(home));
  return st ? {cursors:Object.fromEntries(st.cursors),ordered:st.view.ordered.length} : null;
}
export const incrementalCounts = () => ({...counts});
export function resetIncremental() {
  states.clear();
  for (const key of Object.keys(counts)) counts[key] = 0;
}
