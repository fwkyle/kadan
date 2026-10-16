// kadan discord watch [--once] [--interval 초] [--to-mail [역할]] | send [텍스트] [--reply-to 메시지ID | --thread 스레드ID] [--edit 메시지ID] [--quiet] | thread <스레드ID> [--rename 이름] [--archive] | check
// #비서 채널과 등록한 레포 포럼 스레드의 대화(3단계). watch는 새 메시지를 JSON 한 줄씩 표준 출력으로 낸다(비서가 감시 도구로 구독). 판단은 비서가 한다.
// 예외: --to-mail(다리)은 레포 포럼 스레드의 결정 요청 답(선택지와 안 맞는 글은 자유 답)을 정해진 규칙으로 기록한다(discord-decision.mjs). 우편 모드에서만 한다.
// 조회·답변만 한다: 발령·결정 승인·머지는 이 명령이 하지 않는다. 설명은 docs/discord-chat.md.
import fs from 'node:fs';
import {ledgerHome} from '../ledger.mjs';
import {die} from '../cli-basics.mjs';
import {createMailOut} from '../discord-mail.mjs';
import {createDecisionAnswerer} from '../discord-decision.mjs';
import {SECRETARY} from '../mailbox.mjs';
import {writeBridgeExit} from '../discord-bridge-exit.mjs';
import {createChat, runWatch, sendText, editThread, checkChat, DEFAULT_INTERVAL_S} from '../discord-chat.mjs';

const USAGE = 'usage: kadan discord watch [--once] [--interval 초] [--to-mail [역할]] | send [텍스트…|--stdin] [--reply-to 메시지ID|--thread 스레드ID] [--edit 메시지ID] [--thread-name 이름] [--quiet] | thread <스레드ID> [--rename 이름] [--archive] | check';
// 쓰기가 실제로 끝나야(역압 포함) 풀린다. 소비자가 안 읽으면 여기서 기다리고, 파이프가 닫히면 거절한다.
const writeLine = line => new Promise((resolve, reject) => process.stdout.write(line + '\n', error => (error ? reject(error) : resolve())));
const text = v => (typeof v === 'string' ? v : undefined);

export async function cmdDiscord(argv, flags, {home = ledgerHome(), env = process.env, out = writeLine,
  err = line => process.stderr.write(line + '\n'), fetchFn, sleep, readStdin = () => fs.readFileSync(0, 'utf8')} = {}) {
  const [action, ...rest] = argv;
  let chat;
  try { chat = createChat({home, env, fetchFn, sleep}); } catch (error) { die(error.message, 2); }
  for (const w of chat.cfg.warnings) err(w);
  try {
    if (action === 'watch' && !rest.length) {
      const intervalS = flags.interval === undefined ? DEFAULT_INTERVAL_S : Number(flags.interval);
      if (!Number.isFinite(intervalS) || intervalS < 2 || intervalS > 300) die('--interval은 2~300초여야 한다', 2);
      const abort = new AbortController();
      // 종료 신호: 막힌 출력·진행 중 요청을 기다리지 않는다. 잠금은 exit 훅이 돌려준다. 안 나간 줄은 cursor가 앞에 있어 다음 실행에서 다시 나온다.
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { abort.abort(); setTimeout(() => process.exit(0), 1500).unref(); });
      process.stdout.on('error', () => abort.abort()); // 구독자가 사라지면(EPIPE) 조용히 끝낸다
      // 우편 모드: 줄을 stdout에 내는 대신 우편함에 저장한다(조회·잠금·상태·재시도·가림은 그대로).
      const toMail = flags['to-mail'] === undefined ? null : flags['to-mail'] === true ? SECRETARY : text(flags['to-mail']);
      if (flags['to-mail'] !== undefined && (!toMail || /\s/.test(toMail))) die(USAGE, 2);
      let emit = line => out(JSON.stringify(line));
      if (toMail) {
        const mailOut = createMailOut({home, to: toMail, log: err});
        const decide = createDecisionAnswerer({home, chat, env, log: err});
        emit = async line => {             // 결정 답으로 끝난 글(true)은 우편으로 보내지 않는다. {note}는 어느 결정인지 특정 안 된 글이라 머리에 적어 보낸다
          const done = await decide(line);
          return done === true ? undefined : mailOut(line, done || {});
        };
      }
      return await runWatch(chat, {once: flags.once === true, intervalS, out: emit, err, signal: abort.signal, sleep,
        lockInfo: toMail ? {mode: 'mail', to: toMail} : {mode: 'stdout'}});
    }
    if (action === 'send') {
      if (flags.stdin !== undefined && flags.stdin !== true) die(USAGE, 2);
      if (flags.quiet !== undefined && flags.quiet !== true) die(USAGE, 2);
      const body = flags.stdin === true ? readStdin() : rest[0] === '--' ? rest.slice(1).join(' ') : rest.join(' ');
      const sent = await sendText(chat, body, {thread: text(flags.thread), replyTo: text(flags['reply-to']), edit: text(flags.edit), threadName: text(flags['thread-name']), quiet: flags.quiet === true});
      for (const s of sent) out(JSON.stringify(s));
      return;
    }
    if (action === 'thread' && rest.length === 1) {
      await editThread(chat, rest[0], {rename: text(flags.rename), archive: flags.archive === true});
      return out(JSON.stringify({ok: true}));
    }
    if (action === 'check' && !rest.length) return (await checkChat(chat)).forEach(l => out(l));
  } catch (error) {
    if (action === 'watch') writeBridgeExit(home, error, [chat.cfg.token, ...chat.cfg.secrets]); // 감시 경보가 꺼진 이유로 붙인다
    if (error.sent?.length) err(`일부만 올라갔다: ${error.sent.length}개 올라간 뒤 멈춤 — ${JSON.stringify(error.sent.map(s => s.id))}`);
    const e = new Error(error.message); e.exitCode = error.kind === 'http' && error.status >= 400 && error.status < 500 ? 3 : 1;
    throw e;
  }
  die(USAGE, 2);
}
