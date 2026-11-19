// 시니어 대화형 호출 하나를 감싸는 프로세스의 본체. `kadan senior`가 기존 호출 프로세스(runJudgeProcess)로 돌린다.
//   ask <호출 폴더>  — 질문 한 줄을 넣고 끝을 기다린 뒤 판정을 outcome.json에 쓴다. 세션은 끄지 않고 남김 표시만 적는다(TERM/INT도 같다).
//   reap <호출 폴더> — 옛 예약 종료의 자리. 새 코드는 예약을 걸지 않지만, 이미 떠 있는 tmux 서버에 걸린 옛 예약이 이 진입 파일을 부른다.
//                      세션을 끄지 않고(tmux 호출 0회) 끝남 기록만 남긴다 — 남겨 둔 세션을 옛 예약이 끄면 안 된다. 늘 0으로 끝난다.
// 판정은 종료 코드·stderr 글이 아니라 outcome.json의 낱말로 넘긴다(경로에 든 숫자가 한도 낱말로 읽히지 않게).
import fs from 'node:fs';
import path from 'node:path';
import {SUBMITTED_FILE, askSeat, keepSeat, markKept, readRecord, seniorTmux, writeOutcome} from './senior-session.mjs';

const [action, dir] = process.argv.slice(2);
if (!['ask', 'reap'].includes(action) || !dir || !path.isAbsolute(dir)) {
  process.stderr.write('사용: senior-session-run.mjs ask|reap <호출 폴더 절대경로>\n');
  process.exit(2);
}

if (action === 'reap') {
  markKept(dir, 'scheduled');
  process.exit(0);
}

const record = readRecord(dir);
if (!record) { process.stderr.write(`세션 기록을 읽지 못했다: ${dir}\n`); process.exit(2); }
const run = seniorTmux({socket: record.socket, home: record.home});
let finished = false, outcome;
// 처리기는 동기이고 짧다: 감싼 쪽(watch-call-process)이 TERM 1초 뒤 KILL을 보낸다. 그래서 파일 기록만 하고 tmux는 부르지 않는다.
for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
  process.once(signal, () => {
    // 이미 판정을 썼으면 덮어쓰지 않는다. 세션은 끄지 않고 남김 표시만 적는다(키·tmux 호출 0회).
    if (!finished) try { writeOutcome(dir, {reason: 'interrupted', detail: signal}); } catch { /* 종료 코드를 지킨다 */ }
    markKept(dir, finished ? outcome.reason : 'interrupted');
    process.exit(code);
  });
}

// 질문이 제출되면 표지 파일을 만든다(부른 쪽이 그때 로티 탭을 연다). 임시 파일에 쓴 뒤 옮겨 반쯤 쓴 파일이 보이지 않게 한다.
const onSubmitted = () => {
  const file = path.join(dir, SUBMITTED_FILE);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({askId: record.askId, session: record.session, panePid: record.panePid, dir, at: new Date().toISOString()}) + '\n', {mode: 0o600});
  fs.renameSync(`${file}.tmp`, file);
};
try { outcome = await askSeat(record, {run, onSubmitted}); }
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
keepSeat(record, {run, reason: outcome.reason});
