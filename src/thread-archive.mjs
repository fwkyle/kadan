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
  // 자식 출력도 믿지 않고 한 번 더 걸러 받는다(허용 필드·정수만, 문자열은 봇 토큰 가림).
  try { return sanitize(JSON.parse(child.stdout.trim().split('\n').at(-1)), botSecrets(home, env)); }
  catch { return {outcome: 'uncertain', attempts: null, reason: '보관 결과 해석 실패'}; }
}

// 자식 출력은 허용한 필드만, 모양을 검사해서 받는다(정수만·고정 단어만·문자열은 비밀값 가림을 거친다).
// 디스코드 응답의 code·message는 반사될 수 있어 믿지 않는다 — 웹훅 경로(discord-send.mjs)처럼 code는 정수일 때만 낸다.
const OUTCOMES = new Set(['sent', 'failed', 'uncertain']);
const hide = (text, secrets) => secrets.reduce((out, s) => (s ? out.split(s).join('[가림]') : out), String(text));
export function sanitize(result, secrets = []) {
  const int = v => (Number.isInteger(v) ? v : undefined);
  const out = {outcome: OUTCOMES.has(result?.outcome) ? result.outcome : 'failed', attempts: result?.attempts === null ? null : int(result?.attempts) ?? 0};
  for (const key of ['status', 'code']) if (int(result?.[key]) !== undefined) out[key] = result[key];
  if (result?.skip === true) out.skip = true;
  if (typeof result?.reason === 'string') out.reason = hide(result.reason, secrets).slice(0, 300);
  return JSON.parse(hide(JSON.stringify(out), secrets));
}

// 오류·기록 문구에서 가릴 봇 토큰(없거나 못 읽으면 빈 목록). 토큰이 notify-log·오류 출력에 나가지 않게 scrubSecrets 목록에 더한다.
export function botSecrets(home, env = process.env) {
  try {
    const token = loadSecret(env, home, 'discord-bot').values?.DISCORD_BOT_TOKEN;
    return token ? [token] : [];
  } catch { return []; }
}
