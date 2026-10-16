// 업무 글 보관·재개 자식 프로세스 — thread-archive.mjs가 spawnSync로 띄워 stdin으로 {home, env, threadId, archived, budgetMs}를 준다.
// 봇 토큰은 여기서만 읽는다. 출력(stdout 한 줄 JSON)에는 토큰·주소·오류 원문을 넣지 않고 상태 코드·디스코드 오류 코드만 남긴다.
import {fileURLToPath} from 'node:url';
import {loadSecret} from './secrets.mjs';
import {createApi, apiBase, DiscordError} from './discord-bot.mjs';
import {sanitize} from './thread-archive.mjs';
import {setThreadArchived} from './discord-chat.mjs';

export async function run({home, env, threadId, archived, budgetMs}) {
  const bot = loadSecret(env, home, 'discord-bot');
  const token = bot.values?.DISCORD_BOT_TOKEN;
  if (!token || /\s/.test(token)) return {outcome: 'failed', attempts: 0, skip: true, reason: '봇 설정 없음(discord-bot 비밀 파일의 DISCORD_BOT_TOKEN)'};
  const done = r => sanitize(r, [token]);
  try {
    const api = createApi({base: apiBase(env), token, secrets: [token]});
    await setThreadArchived({api: (method, path, body) => api(method, path, body, {budgetMs})}, threadId, archived);
    return done({outcome: 'sent', attempts: 1});
  } catch (error) {
    if (error instanceof DiscordError) {
      const base = {attempts: error.attempts ?? 1, reason: error.message};
      if (error.kind === 'uncertain') return done({outcome: 'uncertain', ...base});
      return done({outcome: 'failed', ...base, status: error.status, code: error.code});
    }
    return done({outcome: 'failed', attempts: 0, skip: true, reason: '보관 준비 오류'});
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { input += c; });
  process.stdin.on('end', async () => {
    let result;
    try { result = await run(JSON.parse(input)); } catch { result = {outcome: 'failed', attempts: 0, reason: '보관 준비 오류'}; }
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  });
}
