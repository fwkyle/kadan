// kadan discord watch [--once] [--interval 초] | send [텍스트] [--reply-to 메시지ID | --thread 스레드ID] [--edit 메시지ID] | thread <스레드ID> [--rename 이름] [--archive] | check
// #비서 채널 대화(3단계). watch는 새 메시지를 JSON 한 줄씩 표준 출력으로 낸다(비서가 감시 도구로 구독). 판단은 비서가 한다.
// 조회·답변만 한다: 발령·결정 승인·머지는 이 명령이 하지 않는다. 설명은 docs/discord-chat.md.
import fs from 'node:fs';
import {ledgerHome} from '../ledger.mjs';
import {die} from '../cli-basics.mjs';
import {createChat, runWatch, sendText, editThread, checkChat, DEFAULT_INTERVAL_S} from '../discord-chat.mjs';

const USAGE = 'usage: kadan discord watch [--once] [--interval 초] | send [텍스트…|--stdin] [--reply-to 메시지ID|--thread 스레드ID] [--edit 메시지ID] [--thread-name 이름] | thread <스레드ID> [--rename 이름] [--archive] | check';
const text = v => (typeof v === 'string' ? v : undefined);

export async function cmdDiscord(argv, flags, {home = ledgerHome(), env = process.env, out = line => process.stdout.write(line + '\n'),
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
      for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => abort.abort());
      process.stdout.on('error', () => abort.abort()); // 구독자가 사라지면(EPIPE) 조용히 끝낸다
      return await runWatch(chat, {once: flags.once === true, intervalS, out: line => out(JSON.stringify(line)), err, signal: abort.signal, sleep});
    }
    if (action === 'send') {
      if (flags.stdin !== undefined && flags.stdin !== true) die(USAGE, 2);
      const body = flags.stdin === true ? readStdin() : rest[0] === '--' ? rest.slice(1).join(' ') : rest.join(' ');
      const sent = await sendText(chat, body, {thread: text(flags.thread), replyTo: text(flags['reply-to']), edit: text(flags.edit), threadName: text(flags['thread-name'])});
      for (const s of sent) out(JSON.stringify(s));
      return;
    }
    if (action === 'thread' && rest.length === 1) {
      await editThread(chat, rest[0], {rename: text(flags.rename), archive: flags.archive === true});
      return out(JSON.stringify({ok: true}));
    }
    if (action === 'check' && !rest.length) return (await checkChat(chat)).forEach(l => out(l));
  } catch (error) {
    if (error.sent?.length) err(`일부만 올라갔다: ${error.sent.length}개 올라간 뒤 멈춤 — ${JSON.stringify(error.sent.map(s => s.id))}`);
    const e = new Error(error.message); e.exitCode = error.kind === 'http' && error.status >= 400 && error.status < 500 ? 3 : 1;
    throw e;
  }
  die(USAGE, 2);
}
