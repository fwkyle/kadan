// 시니어 대화형 호출 하나를 감싸는 프로세스의 본체. `kadan senior`가 기존 호출 프로세스(runJudgeProcess)로 돌린다.
//   ask <호출 폴더>  — 질문 한 줄을 넣고 끝을 기다린 뒤 판정을 outcome.json에 쓰고 자기 세션을 끈다. TERM/INT면 세션을 끄고 나간다.
//   reap <호출 폴더> — 예약 종료. tmux 서버가 상한 뒤에 부른다. 끄기 전 확인은 다른 길과 같은 함수(killOwn)다.
// 판정은 종료 코드·stderr 글이 아니라 outcome.json의 낱말로 넘긴다(경로에 든 숫자가 한도 낱말로 읽히지 않게).
import fs from 'node:fs';
import path from 'node:path';
import {askSeat, closeSeat, killOwn, readRecord, seniorTmux, writeOutcome} from './senior-session.mjs';

const [action, dir] = process.argv.slice(2);
if (!['ask', 'reap'].includes(action) || !dir || !path.isAbsolute(dir)) {
  process.stderr.write('사용: senior-session-run.mjs ask|reap <호출 폴더 절대경로>\n');
  process.exit(2);
}

if (action === 'reap') {
  const result = killOwn(dir, {reason: 'scheduled'});
  process.exit(result.killed || ['no-session', 'no-record'].includes(result.why) ? 0 : 3);
}

const record = readRecord(dir);
if (!record) { process.stderr.write(`세션 기록을 읽지 못했다: ${dir}\n`); process.exit(2); }
const run = seniorTmux({socket: record.socket, home: record.home});
let finished = false;
// 처리기는 동기이고 짧다: 감싼 쪽(watch-call-process)이 TERM 1초 뒤 KILL을 보낸다.
for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
  process.once(signal, () => {
    // 이미 판정을 썼으면 덮어쓰지 않는다. 세션은 어느 경우든 끈다(이미 꺼졌으면 아무 일도 없다).
    if (!finished) try { writeOutcome(dir, {reason: 'interrupted', detail: signal}); } catch { /* 종료 코드를 지킨다 */ }
    try { killOwn(dir, {run, reason: 'interrupted'}); } catch { /* 종료 코드를 지킨다 */ }
    process.exit(code);
  });
}

let outcome;
try { outcome = await askSeat(record, {run}); }
catch (error) { outcome = {reason: 'call-failed', detail: `session-error — ${String(error?.message ?? error)}`}; }
try {
  // 답은 표지를 뗀 본문만 공통부가 읽는 자리(호출 폴더의 result.txt)에 둔다. advice의 bytes·digest와 영수증 answer가 같은 글을 가리킨다.
  if (outcome.reason === 'ok') fs.writeFileSync(path.join(dir, 'result.txt'), outcome.answer, {mode: 0o600});
  writeOutcome(dir, {reason: outcome.reason, ...(outcome.detail ? {detail: outcome.detail} : {})});
} catch (error) {
  process.stderr.write(`판정 기록 실패: ${error.message}\n`);
  process.exitCode = 1;
}
finished = true;
closeSeat(record, {run, reason: outcome.reason});
