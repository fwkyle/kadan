// 포럼 채널의 업무 글 기록 — `업무 키 → {threadId, statusMessageId}`만 $KADAN_HOME/notify-threads.json에 둔다(주소·토큰은 저장하지 않는다).
// 같은 파일에 `decisions`(결정 id → {threadId, messageId, forum})도 둔다: 결정 요청 메시지를 답변·취소 때 고치려고 남기는 id뿐이다.
// 레포 '결정' 글은 업무 글과 같은 방식으로 `<레포>/__decisions__` 키를 쓴다.
// 1단계의 옛 형식(`업무 키 → 글 id` 문자열)도 읽는다: 읽을 때 {threadId, statusMessageId:null}로 바꾸고, 다음 저장 때 새 형식으로 쓴다.
// 감시기와 CLI가 동시에 쓸 수 있어 잠금(mkdir 잠금 + 오래된 잠금 치우기)을 걸고, 쓸 때는 임시 파일 → rename(0600)이다.
// 상태 읽기 → (새 글 만들기) → 상태 갱신은 한 잠금 안에서 한다.
import fs from 'node:fs';
import path from 'node:path';

export const THREADS_FILE = 'notify-threads.json';
const LOCK_STALE_MS = 20000; // 알림 한 번의 최대 시간(약 14초)보다 길게
const file = home => path.join(home, THREADS_FILE);
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// archived: 끝난 업무라 봇이 보관한 글이면 true. 옛 기록(문자열·archived 없음)은 false로 읽고, 파일에는 true일 때만 쓴다.
const entryOf = v => typeof v === 'string' && v ? {threadId: v, statusMessageId: null, archived: false}
  : v && typeof v === 'object' && typeof v.threadId === 'string' && v.threadId
    ? {threadId: v.threadId, statusMessageId: typeof v.statusMessageId === 'string' && v.statusMessageId ? v.statusMessageId : null, archived: v.archived === true} : null;
const storedEntry = ({archived, ...rest}) => (archived ? {...rest, archived: true} : rest);

const MAX_DECISIONS = 500; // 오래된 결정 기록부터 버린다(해결된 결정은 다시 고칠 일이 거의 없다)

function readState(home) {
  try {
    const v = JSON.parse(fs.readFileSync(file(home), 'utf8'));
    return v?.version === 1 && v.threads && typeof v.threads === 'object' ? v : {};
  } catch { return {}; }
}

export function readThreads(home) {
  return Object.fromEntries(Object.entries(readState(home).threads ?? {}).map(([k, e]) => [k, entryOf(e)]).filter(([, e]) => e));
}

const decisionOf = v => v && typeof v === 'object' && typeof v.messageId === 'string' && v.messageId
  ? {threadId: typeof v.threadId === 'string' && v.threadId ? v.threadId : null, messageId: v.messageId, forum: v.forum === true, ...(v.resolved === true ? {resolved: true} : {})} : null;

export function readDecisions(home) {
  const raw = readState(home).decisions;
  return raw && typeof raw === 'object' ? Object.fromEntries(Object.entries(raw).map(([k, e]) => [k, decisionOf(e)]).filter(([, e]) => e)) : {};
}

function writeState(home, threads, decisions) {
  fs.mkdirSync(home, {recursive: true, mode: 0o700});
  const tmp = `${file(home)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({version: 1, threads: Object.fromEntries(Object.entries(threads).map(([k, e]) => [k, storedEntry(e)])), ...(Object.keys(decisions).length ? {decisions} : {})}, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(tmp, file(home));
}

// 최신 파일을 다시 읽고 자기 업무 줄만 바꿔 쓴다(다른 업무의 기록을 지우지 않는다). 잠금 안에서 부른다.
// entry: {threadId, statusMessageId}. 글이 바뀌면(새 글) statusMessageId를 null로 넘겨 옛 글의 메시지를 끌고 가지 않는다.
export function setThread(home, work, entry) {
  writeState(home, {...readThreads(home), [work]: entryOf(entry)}, readDecisions(home));
}

// 글의 보관 여부만 바꾼다(기록이 없으면 아무것도 안 한다). 잠금 안에서 부른다.
export function setArchived(home, work, archived) {
  const all = readThreads(home);
  if (all[work]) writeState(home, {...all, [work]: {...all[work], archived: archived === true}}, readDecisions(home));
}

// 결정 요청 메시지의 위치를 남긴다. 잠금 안에서 부른다.
export function setDecision(home, id, entry) {
  const all = readDecisions(home);
  // 해결 기록은 한 방향이다: 한 번 resolved면 어떤 쓰기도 false로 되돌리지 못한다.
  const next = {...all, [id]: decisionOf({...entry, ...(all[id]?.resolved ? {resolved: true} : {})})};
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_DECISIONS))) delete next[k];
  writeState(home, readThreads(home), next);
}

// 잠금을 얻어 fn(threads)을 돌린다. lockUntilMs(절대 시각)까지 못 얻으면 fn을 돌리지 않고 {locked:false}를 돌려준다 —
// 잠금 없이 읽기·전송·쓰기를 하지 않는다. 호출 쪽은 전체 알림 종료 시각을 넘지 않게 lockUntilMs를 정한다.
export function withThreadLock(home, lockUntilMs, fn) {
  const lock = `${file(home)}.lock`;
  fs.mkdirSync(home, {recursive: true, mode: 0o700});
  let held = false;
  while (!held) {
    try { fs.mkdirSync(lock); held = true; } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmdirSync(lock); } catch { /* 다른 프로세스가 치움 */ }
      if (Date.now() >= lockUntilMs) return {locked: false};
      sleep(Math.max(1, Math.min(50, lockUntilMs - Date.now())));
    }
  }
  try { return {locked: true, value: fn(readThreads(home))}; }
  finally { try { fs.rmdirSync(lock); } catch { /* 이미 없음 */ } }
}
