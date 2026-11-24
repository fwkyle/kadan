// Why: 비서 수명 조회(readSessionLifecycleLedger)가 대상 세션 행만 JS로 읽으면서도,
// 전체 읽기(readSystemLedger → ledger-domains.mjs의 validateDomainEvent·createDomainValidator)가 잡던
// 원장 손상을 놓쳐 가짜 비서 탭을 열지 않게 한다. 전체 행을 JS로 JSON.parse해 쌓지 않고 SQLite 안에서 검사한다.
//
// 검사하는 것(모두 전체 읽기와 같은 조건이다):
//  - 옛 원장(ledger.jsonl): 객체가 아니거나 kind가 문자열이 아니거나 broken이 참인 행(legacyCorrupt)
//  - 영역 원장 3개(tasks·mail·system): 종류(kind) 누락·빈 값·broken·영역에 안 맞는 종류, 순번(_ledgerOrder) 형식,
//    영역 안 순번 증가, 세 영역을 합친 순번의 빈틈·중복, send/dispatch 짝, mailId 형식·중복,
//    발령 연결(taskId·dispatchId), 완료 우편의 구조 연결(done.completionMailId ↔ 완료 우편)
// 검사하지 않는 것: 완료 우편이 가리키는 원 발령이 completionRequest(원장 이력 전체로 별칭·인계를 풀어 찾는 값)와
// 같은 행인지의 의미 검사. 이 값은 이력 전체를 JS로 투영해야 해서 좁은 읽기에서는 하지 않는다(전체 읽기는 그대로 한다).
// 원장이 10배면: 검사 시간은 영역 원장 행 수에 비례한다(행마다 JSON 경로 몇 개). JS 힙에는 행을 올리지 않는다.
import {ledgerStreams} from './ledger-domains.mjs';

const LEGACY = 'ledger.jsonl';
const {tasks: TASKS, mail: MAIL, system: SYSTEM} = ledgerStreams;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
// 발령(dispatch)이 보내는 사건에서 그대로 옮기는 필드(ledger-domains.mjs의 taskFields와 같아야 한다).
const TASK_FIELDS = ['t', 'role', 'taskId', 'rawTaskId', 'executionKey', 'workKey', 'board', 'by'];

const type = path => `json_type(payload,'$.${path}')`;
const value = path => `json_extract(payload,'$.${path}')`;
// JS의 참 판정(truthy): 거짓·0·빈 문자열·없음은 거짓, 나머지는 참.
const truthy = path => `COALESCE(CASE ${type(path)} WHEN 'true' THEN 1 WHEN 'array' THEN 1 WHEN 'object' THEN 1`
  + ` WHEN 'integer' THEN ${value(path)}<>0 WHEN 'real' THEN ${value(path)}<>0`
  + ` WHEN 'text' THEN ${value(path)}<>'' ELSE 0 END,0)`;
// ledgerDomain(kind)과 같은 영역 판정.
const DOMAIN_OF = kind => `(CASE WHEN ${kind} IN ('plan','dispatch','done') THEN 'tasks'`
  + ` WHEN ${kind}='send' OR ${kind} GLOB 'mail-*' OR ${kind}='reply' OR ${kind} GLOB 'reply-*'`
  + ` OR ${kind}='cancel' OR ${kind} GLOB 'cancel-*' THEN 'mail' ELSE 'system' END)`;
const STREAM_DOMAIN = `(CASE stream WHEN '${TASKS}' THEN 'tasks' WHEN '${MAIL}' THEN 'mail' ELSE 'system' END)`;
const ORDERED = `'${TASKS}','${MAIL}','${SYSTEM}'`;
// 칸이 없으면 SQL 비교가 NULL이 되어 NOT도 NULL로 빠진다. 없음·형식 틀림을 모두 '아님'으로 센다.
const not = cond => `COALESCE(${cond},0)=0`;

// 1단계: 옛 원장 전체와 영역 원장 3개의 행마다 가벼운 칸(종류·순번)만 읽는다. 시스템 영역의 큰 사건 본문은 읽지 않는다.
const ROW_CHECKS = `
WITH r AS MATERIALIZED (
  SELECT stream, seq, json_type(payload) AS pt, ${type('kind')} AS kt, ${value('kind')} AS kind,
    ${truthy('broken')} AS broken, ${type('_ledgerOrder')} AS ot, ${value('_ledgerOrder')} AS ord
  FROM events WHERE stream IN ('${LEGACY}',${ORDERED})
), good AS (
  SELECT * FROM r WHERE stream<>'${LEGACY}' AND ot IN ('integer','real')
    AND ord=CAST(ord AS INTEGER) AND ord>=1 AND ord<=${MAX_SAFE}
), grouped AS (
  SELECT count(*) AS n, count(CASE WHEN kind='send' THEN 1 END) AS sends,
    count(CASE WHEN kind='dispatch' THEN 1 END) AS dispatches FROM good GROUP BY ord
), steps AS (
  SELECT stream, ord, LAG(ord,1,0) OVER (PARTITION BY stream ORDER BY seq) AS prev FROM good
)
SELECT code, stream FROM (
  SELECT 1 AS code, '${LEGACY}' AS stream FROM r WHERE stream='${LEGACY}'
    AND ${not("pt='object' AND kt='text' AND NOT broken")}
  UNION ALL SELECT 2, stream FROM r WHERE stream<>'${LEGACY}'
    AND ${not(`pt='object' AND kt='text' AND kind<>'' AND NOT broken AND ${DOMAIN_OF('kind')}=${STREAM_DOMAIN}`)}
  UNION ALL SELECT 3, stream FROM r WHERE stream<>'${LEGACY}'
    AND ${not(`ot IN ('integer','real') AND ord=CAST(ord AS INTEGER) AND ord>=1 AND ord<=${MAX_SAFE}`)}
  UNION ALL SELECT 4, stream FROM steps WHERE ord<=prev
  UNION ALL SELECT 5, '' FROM (SELECT count(DISTINCT ord) AS c, max(ord) AS m FROM good) WHERE c<>m
  UNION ALL SELECT 6, '' FROM grouped WHERE n>2 OR (n=2 AND NOT (sends=1 AND dispatches=1))
) ORDER BY code LIMIT 1`;

// 2단계: 우편·작업 사건(send·dispatch·done)만 읽어 짝·mailId·발령 연결·완료 우편 구조를 본다.
const fieldColumns = TASK_FIELDS.map(name => `${type(name)} AS ${name}_t, ${value(name)} AS ${name}_v`).join(', ');
const pairEqual = TASK_FIELDS.map(name => `s.${name}_t IS d.${name}_t AND s.${name}_v IS d.${name}_v`).join(' AND ');
const TASK_SEND = alias => `(${alias}.kind='send' AND ${alias}.tid_t IS NOT NULL AND ${alias}.tid_t<>'null'`
  + ` AND NOT COALESCE(${alias}.tr_t='text' AND ${alias}.tr='mailbox',0)`
  + ` AND NOT ${alias}.cmp AND NOT ${alias}.sg_truthy`
  + ` AND NOT ${alias}.rf)`;
const LINK_CHECKS = `
WITH x AS MATERIALIZED (
  SELECT stream, ${value('kind')} AS kind, ${value('_ledgerOrder')} AS ord,
    ${type('mailId')} AS mt, ${value('mailId')} AS mail,
    ${type('taskId')} AS tid_t, ${value('taskId')} AS tid,
    ${type('dispatchId')} AS dsp_t, ${value('dispatchId')} AS dsp,
    ${type('transport')} AS tr_t, ${value('transport')} AS tr, ${truthy('completion')} AS cmp,
    ${truthy('systemGenerated')} AS sg_truthy, ${type('systemGenerated')} AS sg_t, ${value('systemGenerated')} AS sg,
    ${truthy('replyFinal')} AS rf, ${truthy('completionMailId')} AS cmid_truthy,
    ${type('completionMailId')} AS cmid_t, ${value('completionMailId')} AS cmid,
    ${type('result')} AS res_t, ${value('result')} AS res, ${type('by')} AS by_t, ${value('by')} AS by,
    ${type('role')} AS role_t, ${value('role')} AS role,
    ${type('completionTaskId')} AS ctid_t, ${value('completionTaskId')} AS ctid,
    ${type('replyTo')} AS rto_t, ${value('replyTo')} AS rto, ${fieldColumns}
  FROM events WHERE stream IN ('${TASKS}','${MAIL}','${LEGACY}')
    AND ${value('kind')} IN ('send','dispatch','done') AND (stream<>'${LEGACY}' OR ${value('kind')}='send')
), ordered AS (SELECT * FROM x WHERE stream<>'${LEGACY}'),
mailed AS (SELECT * FROM x WHERE kind='send' AND mt='text' AND mail<>''),
doneLinked AS (SELECT * FROM ordered WHERE kind='done' AND cmid_truthy)
SELECT code FROM (
  SELECT 1 AS code FROM ordered WHERE kind IN ('send','dispatch') AND ${not("mt='text' AND mail<>''")}
  UNION ALL SELECT 2 FROM ordered o WHERE (${TASK_SEND('o')} OR o.kind='dispatch')
    AND ${not("o.tid_t='text' AND o.tid<>'' AND o.dsp_t='text' AND o.dsp=o.mail")}
  UNION ALL SELECT 3 FROM ordered d WHERE d.kind='dispatch' AND NOT EXISTS (
    SELECT 1 FROM ordered s WHERE s.kind='send' AND s.ord=d.ord AND ${TASK_SEND('s')}
      AND s.mail IS d.mail AND ${pairEqual})
  UNION ALL SELECT 3 FROM ordered s WHERE ${TASK_SEND('s')} AND NOT EXISTS (
    SELECT 1 FROM ordered d WHERE d.kind='dispatch' AND d.ord=s.ord)
  UNION ALL SELECT 4 FROM ordered WHERE kind='send' AND mt='text' GROUP BY mail HAVING count(*)>1
  UNION ALL SELECT 4 FROM ordered o WHERE o.kind='send' AND o.mt='text'
    AND EXISTS (SELECT 1 FROM x l WHERE l.stream='${LEGACY}' AND l.mt='text' AND l.mail=o.mail)
  UNION ALL SELECT 5 FROM doneLinked d WHERE NOT EXISTS (
    SELECT 1 FROM ordered m JOIN mailed q ON q.mail=m.rto AND m.rto_t='text'
    WHERE m.stream='${MAIL}' AND m.kind='send' AND d.cmid_t='text' AND m.mt='text' AND m.mail=d.cmid
      AND m.sg_t='text' AND m.sg='task-completion' AND m.cmp AND m.rf AND m.tr_t='text' AND m.tr='mailbox'
      AND m.tid_t IS NULL AND m.ord=d.ord+1 AND m.by_t IS d.role_t AND m.by IS d.role
      AND m.ctid_t IS d.tid_t AND m.ctid IS d.tid AND m.res_t IS d.res_t AND m.res IS d.res
      AND q.by_t='text' AND q.by<>'' AND q.by<>'모름' AND q.by_t IS m.role_t AND q.by IS m.role)
  UNION ALL SELECT 6 FROM doneLinked GROUP BY cmid HAVING count(*)>1
  UNION ALL SELECT 7 FROM ordered m WHERE m.sg_t='text' AND m.sg='task-completion' AND NOT (m.kind='send' AND EXISTS (
    SELECT 1 FROM doneLinked d WHERE d.cmid_t='text' AND d.cmid=m.mail))
) ORDER BY code LIMIT 1`;

const ROW_MESSAGES = {
  1: () => '과거 원장 손상: 도메인 조회 불가',
  2: stream => `도메인 원장 종류 손상: ${stream}`,
  3: stream => `도메인 원장 순번 손상: ${stream}`,
  4: stream => `도메인 원장 순서 손상: ${stream}`,
  5: () => '도메인 원장 순번 누락',
  6: () => '도메인 원장 순번 중복',
};
const LINK_MESSAGES = {
  1: `도메인 원장 mailId 손상`,
  2: '도메인 원장 dispatch 연결 손상',
  3: '도메인 원장 send/dispatch 연결 손상',
  4: '도메인 원장 중복 mailId',
  5: '도메인 원장 완료 우편 연결 손상',
  6: '도메인 원장 완료 우편 중복',
  7: '도메인 원장 완료 사건 없는 우편',
};

// 손상이 있으면 전체 읽기와 같은 계열의 오류를 던진다. 호출한 쪽은 같은 읽기 트랜잭션(db) 안에서 부른다.
export function assertLedgerIntegrity(db) {
  const row = db.prepare(ROW_CHECKS).get();
  if (row) throw new Error(ROW_MESSAGES[row.code](row.stream));
  const link = db.prepare(LINK_CHECKS).get();
  if (link) throw new Error(LINK_MESSAGES[link.code]);
}
