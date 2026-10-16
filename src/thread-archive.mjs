// 업무 포럼 글의 보관·재개(봇 전용) — 알림 경로(user-notify)가 동기라서 웹훅 전송처럼 자식 프로세스(discord-archive.mjs)를
// spawnSync로 띄워 강제 시간 제한을 건다. 웹훅은 보관을 못 하므로 봇 토큰이 필요하고, 토큰은 자식만 읽는다.
// 반환(전송 함수와 같은 모양): {outcome:'sent'|'failed'|'uncertain', attempts, status?, code?, reason?, skip?}
//   skip: 봇 설정이 없는 것처럼 '요청이 나가지 않았고 다시 해도 같은' 실패(장애로 세지 않는다).
import {spawnSync} from 'node:child_process';
import {loadSecret} from './secrets.mjs';

const CHILD = new URL('./discord-archive.mjs', import.meta.url).pathname;
const PASS_ENV = ['KADAN_SECRET_DISCORD_BOT_FILE', 'KADAN_DISCORD_API_BASE', 'KADAN_NOTIFY'];

export function setArchivedSync({home, env = process.env, threadId, archived, budgetMs = 12000}) {
  const child = spawnSync(process.execPath, [CHILD], {
    input: JSON.stringify({home, env: Object.fromEntries(PASS_ENV.filter(k => env[k] !== undefined).map(k => [k, env[k]])), threadId, archived, budgetMs}),
    encoding: 'utf8', timeout: budgetMs + 2000, maxBuffer: 1 << 16,
  });
  if (child.error || child.status !== 0)
    return {outcome: 'uncertain', attempts: null, reason: child.error?.code === 'ETIMEDOUT' ? '자식 프로세스 시간 초과' : '자식 프로세스 오류'};
  try { return JSON.parse(child.stdout.trim().split('\n').at(-1)); } catch { return {outcome: 'uncertain', attempts: null, reason: '보관 결과 해석 실패'}; }
}

// 오류·기록 문구에서 가릴 봇 토큰(없거나 못 읽으면 빈 목록). 토큰이 notify-log·오류 출력에 나가지 않게 scrubSecrets 목록에 더한다.
export function botSecrets(home, env = process.env) {
  try {
    const token = loadSecret(env, home, 'discord-bot').values?.DISCORD_BOT_TOKEN;
    return token ? [token] : [];
  } catch { return []; }
}
