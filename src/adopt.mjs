// 대화를 감독으로 옮기기(2026-10-06 [kyle]): 사람이 tmux 밖(앱·터미널)에서 이야기하던 AI 대화를 복제해
// 카단 바닥의 감독 세션으로 이어 연다. 그 뒤로는 감독이 우편을 받고, 원래 대화가 꺼져도 일이 이어진다.
// 원래 대화와 복제본이 함께 지시하면 같은 일을 두 번 맡기게 되므로, 옮긴 뒤 원래 대화는 더 지시하지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitForSettled } from './quickstart.mjs';
import { shellArg } from './adopt-permissions.mjs';
import { fillTemplate, runnerTemplate } from './runner-table.mjs';

export const ADOPT_PROFILES = ['conductor', 'super'];
export const ADOPT_HARNESSES = ['claude', 'codex', 'agy', 'omo'];
// agy·omo는 새 창의 대화 ID·권한을 확인할 길이 없어 인수 확인(accept)과 원본 탭 자동 닫기를 하지 않는다(2026-11-24).
export const ADOPT_UNCHECKED_HARNESSES = ['agy', 'omo'];
const SAFE = /^[\w.:/@-]+$/;
// 큰 문맥 모델 이름(예: claude-opus-5-5[1m])은 대괄호가 있어 셸이 파일 이름 패턴으로 읽지 않게 따옴표로 감싼다.
// 긴 대화를 옮길 때는 원래와 같은 큰 문맥 모델이어야 문맥이 넘치지 않는다.
const SAFE_MODEL = /^[\w.:/@[\]-]+$/;
// 인자·사용법 검증 실패 표시. 이 오류는 인수 준비 전이라 비서 우편함에 알리지 않는다(2026-10-22 [kyle]).
export const ADOPT_USAGE = 'KADAN_ADOPT_USAGE';
const usageError = message => Object.assign(new Error(message), {code: ADOPT_USAGE});
const shellModel = (model) => (/[[\]]/.test(model) ? `'${model}'` : model);

// 실행기마다 "복제해서 이어 열기" 명령이 다르다. 모델은 꼭 적는다 — 모델이 안 적힌 창에는 카드 전송이 거부된다.
export function adoptCommand({ harness, id, model, effort, permissionArgs = [], resumeTemplate } = {}) {
  if (!id || !SAFE.test(id)) throw usageError('대화 ID가 비었거나 쓸 수 없는 글자가 있다');
  if (!model || !SAFE_MODEL.test(model)) throw usageError('--model이 필요하다 — 옮긴 감독 창에 모델이 적혀 있어야 카드 전송이 된다');
  if (effort !== undefined && !/^[a-z]+$/.test(effort)) throw usageError('--effort는 영문 소문자 한 낱말이다(예: high)');
  const permissions = permissionArgs.map(arg => ` ${shellArg(arg)}`).join('');
  if (harness === 'claude') return `claude --resume ${id} --fork-session --model ${shellModel(model)}${effort ? ` --effort ${effort}` : ''}${permissions}`;
  if (harness === 'codex') return `codex fork ${id} --model ${shellModel(model)}${effort ? ` -c model_reasoning_effort=${effort}` : ''}${permissions}`;
  // agy는 복제 옵션이 없어 같은 대화를 이어 연다(원본 탭을 닫는 흐름이라 충돌하지 않는다). omo는 --fork로 복제한다.
  // agy는 실행기 표의 resume 틀(카단 start로 띄운 agy와 같은 권한 옵션)이 있으면 그 틀로 만든다(2026-11-24 [kyle]).
  // 틀에 {effort} 자리가 없으면 강도는 지금처럼 뒤에 덧붙인다.
  // omo의 생각 강도는 모델 문자열의 `:<thinking>`이라 따로 붙이지 않는다 — 몰래 버리지 않고 거절한다.
  if (harness === 'agy' && resumeTemplate) {
    const filled = fillTemplate(resumeTemplate, { model: shellModel(model), effort, conversation: id });
    return resumeTemplate.includes('{effort}') || !effort ? filled : `${filled} --effort ${effort}`;
  }
  if (harness === 'agy') return `agy --conversation ${id} --model ${shellModel(model)}${effort ? ` --effort ${effort}` : ''}`;
  if (harness === 'omo') {
    if (effort) throw usageError('omo는 --effort 대신 --model provider/모델:<강도>로 강도를 적는다');
    return `omo --fork ${id} --model ${shellModel(model)}`;
  }
  throw usageError(`--harness는 ${ADOPT_HARNESSES.join('·')} 중 하나다`);
}

// 지금 대화가 스스로 밝힌 ID와 생각 강도. Claude Code는 실행 중인 대화 ID를 CLAUDE_CODE_SESSION_ID로, 강도를 CLAUDE_EFFORT로
// 넘겨준다(2026-10-06 실측 — 강도를 안 넘기면 복제본이 기본값 medium으로 떴다). Codex는 그런 값을 확인하지 못해 --resume으로 받는다.
export function detectConversation(env = process.env) {
  if (!env.CLAUDE_CODE_SESSION_ID) return null;
  return { harness: 'claude', id: env.CLAUDE_CODE_SESSION_ID, ...(/^[a-z]+$/.test(env.CLAUDE_EFFORT ?? '') ? { effort: env.CLAUDE_EFFORT } : {}) };
}

// 실행기를 지정하면 그 실행기의 감지만 쓴다. 지정이 없으면 Claude Code 환경 → agy 순서다.
export function detectForAdopt(env, harness, findAgy) {
  return (!harness || harness === 'claude' ? detectConversation(env) : null)
    ?? (!harness || harness === 'agy' ? findAgy() : null);
}

// Claude Code는 대화 기록을 시작 폴더 이름(영문·숫자 밖의 글자는 모두 '-')으로 만든 폴더에 둔다(2026-10-06 실측).
// 다른 폴더에서 이어 열면 "대화 없음" 화면에 첫 안내가 붙고 관계표에는 빈 감독이 남으므로, 띄우기 전에 확인한다.
export function findClaudeTranscript({ id, cwd = process.cwd(), userHome = os.homedir() } = {}) {
  const projects = path.join(userHome, '.claude', 'projects');
  if (fs.existsSync(path.join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'), id + '.jsonl'))) return { ok: true };
  let elsewhere = null;
  try { elsewhere = fs.readdirSync(projects).find((dir) => fs.existsSync(path.join(projects, dir, id + '.jsonl'))) ?? null; } catch {}
  return { ok: false, elsewhere };
}

// 실행기 표(runner-settings)의 agy resume 틀을 꺼낸다. 못 읽거나 이어 열 틀로 쓸 수 없으면 {error}만 돌려 부른 쪽이 기본 명령으로 내려간다.
export function agyResumeTemplate(readSettings) {
  try {
    const settings = readSettings?.();
    if (!settings) return { error: '실행 모델 설정 파일이 없다' };
    const template = runnerTemplate(settings, 'agy', 'resume');
    if (!/^agy\s/.test(template) || !template.includes('{conversation}') || !template.includes('{model}') || /\{(prompt|cwd)\}/.test(template)) {
      return { error: 'agy resume 틀이 `agy … {model} … {conversation}` 꼴이 아니다' };
    }
    return { template };
  } catch (error) {
    return { error: error.message };
  }
}

export function adoptPrompt(role, parent, profile = 'conductor') {
  const title = profile === 'super' ? '슈퍼감독' : '감독';
  return `당신은 이제 카단의 ${title} '${role}'입니다(직속 상위 ${parent === '@user' ? '사용자' : parent}). ` +
    '이 창은 방금까지의 대화를 복제해 카단으로 옮긴 것이고, 원래 대화는 더 지시하지 않습니다. ' +
    `${profile === 'super' ? 'kadan-super' : 'kadan-conductor'} 스킬을 읽은 뒤, 대화에서 사용자가 맡긴 일을 이어서 진행하세요. 승인 범위는 대화에서 받은 데까지입니다. ` +
    '감독은 직접 구현하지 않고 작업자·검수자에게 맡깁니다. 결정이 필요하면 사용자에게 묻습니다.' +
    // adopt로 세운 새 감독이 상위에 아무것도 안 보내 슈퍼감독이 몰랐다(2026-11-24). 상위가 역할일 때만, 첫 한 번만 소개를 시킨다.
    (parent && parent !== '@user'
      ? ` 상위 ${parent}에게 자기 소개 우편 한 통(목표·승인 범위·업무 키 요약)을 kadan mail로 한 번만 보내세요. 이후 상위에는 머지 요청·질문·마감·사고만 보냅니다.`
      : '');
}

// agy는 복제가 아니라 같은 대화를 이어 열어서, 새 창이 자기를 원래 탭으로 여기고 원래 탭의 "여기서 멈춘다"를 따랐다(2026-11-24 첫 실사용).
// 그래서 agy일 때만 첫 안내 맨 앞에 이 창이 새 감독 창임을 밝힌다. claude·codex·omo는 새 세션이라 넣지 않는다.
export function agySameConversationNotice(session) {
  return `지금 이 창(${session})이 kadan adopt로 이어 연 새 감독 창이다. 원래 탭이 아니며, 원래 탭에서 한 "멈춘다"는 말은 이 창에 해당하지 않는다. 맡은 범위를 이어서 진행하라.`;
}

export function runAdopt({role, flags = {}, env = process.env, floor, sessionName, start, send,
  log = console.log, sleep, findTranscript = findClaudeTranscript, inherit, prepare,
  notice = () => {}, monitor = () => {}, detect = detectConversation, readRunnerSettings} = {}) {
  if (!role || /\s/.test(role)) throw usageError('사용법: kadan adopt <감독이름> --model <모델> [--resume <대화ID> --harness claude|codex|agy|omo] [--effort high] [--parent @user|<역할>] [--profile conductor|super] [--hidden] [--no-prompt] [--inherit-mail]');
  // 실행기를 지정했으면 이름부터 검증하고, 지정한 실행기와 다른 대화는 자동 감지로도 열지 않는다(검수 exec-b189a814).
  if (flags.harness !== undefined && typeof flags.harness !== 'string') throw usageError('--harness에는 값이 필요하다(claude·codex·agy·omo)');
  const harness = flags.harness;
  if (harness !== undefined && !ADOPT_HARNESSES.includes(harness)) throw usageError(`--harness는 ${ADOPT_HARNESSES.join('·')} 중 하나다`);
  if (flags.effort !== undefined && typeof flags.effort !== 'string') throw usageError('--effort에는 값이 필요하다(예: --effort high)');
  let conversation = typeof flags.resume === 'string' ? { harness: harness ?? 'claude', id: flags.resume } : detect(env, harness);
  if (conversation && harness && conversation.harness !== harness) conversation = null;
  if (!conversation && ['codex', 'omo'].includes(harness)) throw usageError(`--harness ${harness}는 지금 대화 ID를 알 수 없다 — --resume <대화ID>를 함께 줘라`);
  if (!conversation) throw usageError('옮길 대화를 모른다 — Claude Code·agy 안에서 실행하거나 --resume <대화ID> --harness codex|agy|omo로 알려 줘라');
  const profile = typeof flags.profile === 'string' ? flags.profile : 'conductor';
  if (!ADOPT_PROFILES.includes(profile)) throw usageError('--profile은 conductor(감독) 또는 super(슈퍼감독)다');
  const parent = typeof flags.parent === 'string' ? flags.parent : '@user';
  // Validate basic arguments before reading private conversation state.
  adoptCommand({...conversation, model: flags.model});
  const session = sessionName(role);
  // 살아 있는 세션을 재사용하면 대화가 옮겨지지 않은 채 "옮겼다"고 보고하게 된다.
  if (floor.alive(session)) throw usageError(`이미 살아 있음: ${session} — 다른 이름을 써라`);
  if (conversation.harness === 'claude') {
    const found = findTranscript({ id: conversation.id });
    if (!found.ok) throw usageError(found.elsewhere
      ? `이 폴더에서 시작한 대화가 아니다(기록 폴더 ${found.elsewhere}) — 대화를 시작한 폴더에서 실행해라`
      : `대화 기록을 찾지 못했다: ${conversation.id}`);
  }

  const inherited = inherit ? inherit(conversation) : null;
  // agy: 실행기 표 resume 틀(권한 옵션 포함)로 연다. 틀을 못 읽으면 기본 명령(권한 옵션 없음)으로 열고 사실대로 한 줄 알린다.
  const agy = conversation.harness === 'agy' ? agyResumeTemplate(readRunnerSettings) : null;
  const cmd = adoptCommand({...conversation, model: flags.model,
    effort: typeof flags.effort === 'string' ? flags.effort : conversation.effort,
    permissionArgs: inherited?.permissions.args || [], resumeTemplate: agy?.template});
  if (inherited?.unsupported) log(inherited.unsupported);
  if (agy?.template) log('agy 권한: 실행기 표의 agy resume 틀대로 연다(카단 start로 띄운 agy와 같은 권한).');
  else if (agy) log(`agy 권한: 실행기 표 resume 틀을 쓰지 못해(${agy.error}) 권한 옵션 없는 기본 명령으로 연다 — 우편 전송 때마다 확인 창이 뜰 수 있다.`);
  const nameCheck = start([role], {cmd, profile, parent, hidden: Boolean(flags.hidden),
    reason: `대화 옮기기(adopt): ${conversation.harness} ${conversation.id}`,
    ...(flags['inherit-mail'] === true ? {'inherit-mail': true} : {})});
  const transfer = prepare?.({role, session, conversation, ...inherited});
  const out = { role, session, cmd, parent, profile, prompt: 'skipped', ...(nameCheck ?? {}),
    ...(transfer ? {adoptionId: transfer.id, status: 'awaiting-acceptance'} : {}) };
  if (transfer && !flags['no-prompt']) monitor(transfer.id);
  const firstMessage = (conversation.harness === 'agy' ? `${agySameConversationNotice(session)}\n\n` : '')
    + adoptPrompt(role, parent, profile)
    + (transfer ? `\n\n${transfer.instruction}` : '');
  if (!flags['no-prompt']) {
    const settled = waitForSettled({ read: () => floor.read(session), ...(sleep ? { sleep } : {}) });
    const screen = settled ? floor.read(session) : '';
    const text = typeof screen === 'string' ? screen : screen?.text || '';
    const blocked = /Teach auto mode|trust this (folder|workspace)|Yes.*No.*Enter to confirm/i.test(text);
    if (settled && !blocked) {
      try {
        send({role, session, message: firstMessage, roleProfile: profile, awaitingAcceptance: Boolean(transfer)}); out.prompt = 'sent';
      } catch (error) {
        if (transfer) error.adoptionId = transfer.id;
        throw error;
      }
    }
    else {
      out.prompt = 'not-ready';
      log('감독 화면이 아직 준비되지 않아 첫 안내를 보내지 않았습니다. 비서에게 확인을 맡깁니다.');
    }
  }
  if (transfer) {
    if (out.prompt !== 'sent' && !flags['no-prompt']) {
      notice({id: transfer.id, role, reason: '새 감독의 첫 안내 입력 대기. 원본 탭을 보존했습니다.'});
    }
    if (inherited?.sourceWarning) notice({id: transfer.id, role, reason: inherited.sourceWarning});
  }
  log('');
  log(conversation.harness === 'agy'
    ? `같은 대화 이어 열기: agy 대화 ${conversation.id} → ${session}`
    : `복제 창 생성: ${conversation.harness} 대화 ${conversation.id} → ${session}`);
  log('원래 대화에서는 이제 지시하지 마세요(같은 일을 두 번 맡기게 됩니다). 이어서 말하려면 감독 창에서 하세요.');
  if (transfer) log(`인수 확인 대기: ${transfer.id} — 새 감독의 확인 전에는 원본 탭을 닫지 않습니다.`);
  log(`감독 창: kadan attach ${role}`);
  return out;
}
