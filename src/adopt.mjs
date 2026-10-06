// 대화를 감독으로 옮기기(2026-10-06 [kyle]): 사람이 tmux 밖(앱·터미널)에서 이야기하던 AI 대화를 복제해
// 카단 바닥의 감독 세션으로 이어 연다. 그 뒤로는 감독이 우편을 받고, 원래 대화가 꺼져도 일이 이어진다.
// 원래 대화와 복제본이 함께 지시하면 같은 일을 두 번 맡기게 되므로, 옮긴 뒤 원래 대화는 더 지시하지 않는다.
import { waitForSettled } from './quickstart.mjs';

export const ADOPT_PROFILES = ['conductor', 'super'];
const SAFE = /^[\w.:/@-]+$/;
// 큰 문맥 모델 이름(예: claude-opus-5-5[1m])은 대괄호가 있어 셸이 파일 이름 패턴으로 읽지 않게 따옴표로 감싼다.
// 긴 대화를 옮길 때는 원래와 같은 큰 문맥 모델이어야 문맥이 넘치지 않는다.
const SAFE_MODEL = /^[\w.:/@[\]-]+$/;
const shellModel = (model) => (/[[\]]/.test(model) ? `'${model}'` : model);

// 실행기마다 "복제해서 이어 열기" 명령이 다르다. 모델은 꼭 적는다 — 모델이 안 적힌 창에는 카드 전송이 거부된다.
export function adoptCommand({ harness, id, model, effort } = {}) {
  if (!id || !SAFE.test(id)) throw new Error('대화 ID가 비었거나 쓸 수 없는 글자가 있다');
  if (!model || !SAFE_MODEL.test(model)) throw new Error('--model이 필요하다 — 옮긴 감독 창에 모델이 적혀 있어야 카드 전송이 된다');
  if (effort !== undefined && !/^[a-z]+$/.test(effort)) throw new Error('--effort는 영문 소문자 한 낱말이다(예: high)');
  if (harness === 'claude') return `claude --resume ${id} --fork-session --model ${shellModel(model)}${effort ? ` --effort ${effort}` : ''}`;
  if (harness === 'codex') return `codex fork ${id} --model ${shellModel(model)}${effort ? ` -c model_reasoning_effort=${effort}` : ''}`;
  throw new Error('--harness는 claude 또는 codex다');
}

// 지금 대화가 스스로 밝힌 ID와 생각 강도. Claude Code는 실행 중인 대화 ID를 CLAUDE_CODE_SESSION_ID로, 강도를 CLAUDE_EFFORT로
// 넘겨준다(2026-10-06 실측 — 강도를 안 넘기면 복제본이 기본값 medium으로 떴다). Codex는 그런 값을 확인하지 못해 --resume으로 받는다.
export function detectConversation(env = process.env) {
  if (!env.CLAUDE_CODE_SESSION_ID) return null;
  return { harness: 'claude', id: env.CLAUDE_CODE_SESSION_ID, ...(/^[a-z]+$/.test(env.CLAUDE_EFFORT ?? '') ? { effort: env.CLAUDE_EFFORT } : {}) };
}

export function adoptPrompt(role, parent) {
  return `당신은 이제 카단의 감독 '${role}'입니다(직속 상위 ${parent === '@user' ? '사용자' : parent}). ` +
    '이 창은 방금까지의 대화를 복제해 카단으로 옮긴 것이고, 원래 대화는 더 지시하지 않습니다. ' +
    'kadan-conductor 스킬을 읽은 뒤, 대화에서 사용자가 맡긴 일을 이어서 진행하세요. 승인 범위는 대화에서 받은 데까지입니다. ' +
    '감독은 직접 구현하지 않고 작업자·검수자에게 맡깁니다. 결정이 필요하면 사용자에게 묻습니다.';
}

export function runAdopt({ role, flags = {}, env = process.env, floor, sessionName, start, send, log = console.log, sleep } = {}) {
  if (!role || /\s/.test(role)) throw new Error('사용법: kadan adopt <감독이름> --model <모델> [--resume <대화ID> --harness claude|codex] [--effort high] [--parent @user|<역할>] [--profile conductor|super] [--hidden] [--no-prompt]');
  const conversation = typeof flags.resume === 'string'
    ? { harness: typeof flags.harness === 'string' ? flags.harness : 'claude', id: flags.resume }
    : detectConversation(env);
  if (!conversation) throw new Error('옮길 대화를 모른다 — Claude Code 안에서 실행하거나 --resume <대화ID> --harness codex로 알려 줘라');
  const profile = typeof flags.profile === 'string' ? flags.profile : 'conductor';
  if (!ADOPT_PROFILES.includes(profile)) throw new Error('--profile은 conductor(감독) 또는 super(슈퍼감독)다');
  const parent = typeof flags.parent === 'string' ? flags.parent : '@user';
  const cmd = adoptCommand({ ...conversation, model: flags.model, effort: typeof flags.effort === 'string' ? flags.effort : conversation.effort });
  const session = sessionName(role);
  // 살아 있는 세션을 재사용하면 대화가 옮겨지지 않은 채 "옮겼다"고 보고하게 된다.
  if (floor.alive(session)) throw new Error(`이미 살아 있음: ${session} — 다른 이름을 써라`);

  start([role], { cmd, profile, parent, hidden: Boolean(flags.hidden), reason: `대화 옮기기(adopt): ${conversation.harness} ${conversation.id}` });
  const out = { role, session, cmd, parent, profile, prompt: 'skipped' };
  if (!flags['no-prompt']) {
    const settled = waitForSettled({ read: () => floor.read(session), ...(sleep ? { sleep } : {}) });
    if (settled) { send({ role, session, message: adoptPrompt(role, parent), roleProfile: profile }); out.prompt = 'sent'; }
    else { out.prompt = 'not-ready'; log('감독 화면이 아직 준비되지 않아 첫 안내를 보내지 않았습니다. 창에서 직접 이어서 말하세요.'); }
  }
  log('');
  log(`옮김: ${conversation.harness} 대화 ${conversation.id} → ${session}`);
  log('원래 대화에서는 이제 지시하지 마세요(같은 일을 두 번 맡기게 됩니다). 이어서 말하려면 감독 창에서 하세요.');
  log(`감독 창: kadan attach ${role}`);
  return out;
}
