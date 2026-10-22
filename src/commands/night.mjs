// kadan night on/off/status — 나이트 모드 명령. 설계: docs/daily/research/2026-10-23_나이트-모드.md
// 새 권한이 아니다: kyle의 현재 말을 기록하고 슈퍼감독에게 나눠 줄 뿐, 승인·머지·결정 답은 대신하지 않는다.
import {appendLedger, readLedger} from '../ledger.mjs';
import {isUserActor, isSupervisorActor} from '../actors.mjs';
import {WorkStore} from '../work-store.mjs';
import {
  nightState, nightTargets, resolveEnd, buildNightMessage, sendNightMail, finishNight, readDecisionEvents, clock,
} from '../night.mjs';

export const MAX_TEXT = 4000;
const USAGE = 'kadan night on "<문구>" [--until HH:MM | --for 8h] [--quote "<kyle 원문>"] [--discord-message <글 id>] | off [--reason 이유] | status';

function describeOn(state, now, missing) {
  const on = state.start, untilMs = Date.parse(on.until);
  return {
    on: true, text: on.text, by: on.by, viaChat: on.viaChat === true, ...(on.quote ? {quote: on.quote} : {}),
    startedAt: on.t, until: on.until, untilLocal: clock(untilMs), remainingMinutes: Math.max(0, Math.round((untilMs - now) / 60_000)),
    to: on.to ?? [], delivered: on.delivered ?? [], missing,
  };
}

// 열린 업무를 가진 슈퍼감독 중 문구를 받지 못한 이름. 관계표나 업무를 못 읽으면 모른다(null).
function missingSupers(home, entries, on) {
  try {
    const {to} = nightTargets({works: new WorkStore(home).list(), entries, by: on.by});
    return to.filter(role => !(on.to ?? []).includes(role));
  } catch { return null; }
}

// 가장 최근 켜짐의 원문. 원장의 마지막 `on` 사건과 그 뒤 끝 사건에서 읽는다(새 저장소 없음). 켠 적이 없으면 null.
function lastRun(entries, state) {
  let end = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.kind !== 'night') continue;
    if (e.phase !== 'on') { end ??= e; continue; }
    const endedAt = end ? end.endedAt : (state.pending ? new Date(state.pending.endedAt).toISOString() : undefined);
    return {phase: end?.phase ?? state.pending?.phase ?? 'on', t: (end ?? e).t, startedAt: e.t, ...(endedAt ? {endedAt} : {}),
      by: e.by, viaChat: e.viaChat === true, text: e.text, ...(e.quote ? {quote: e.quote} : {})};
  }
  return null;
}

// `status --text`의 글: 문구·kyle 원문을 줄바꿈 그대로 보인다. 켜 있으면 지금 문구와 끝 시각, 켠 적이 없으면 한 줄 안내.
export function nightOriginalText(result) {
  const run = result?.on ? result : result?.last;
  if (!run?.text) return '켠 적이 없습니다. 원문이 없습니다.';
  return [`--- ${result?.on ? '지금 켜진' : '마지막'} 위임 원문 (${run.by}${run.viaChat ? ', kyle 채팅을 옮겨 적음' : ''}) ---`, run.text,
    ...(run.quote ? ['--- kyle 채팅 원문 ---', run.quote] : []),
    `--- ${result?.on ? `끝: ${result.untilLocal}` : `${run.startedAt} ~ ${run.endedAt ?? '끝 시각 미기록'}`} ---`].join('\n');
}

// deps(시험용 주입): now, sendMail(role, message), readWorks, readEntries, readDecisions, record, notify, readBody.
export function nightCommand(args, flags, {home, by, deps = {}}) {
  const [sub, ...rest] = args;
  if (flags.help || !sub) return USAGE;
  const now = (deps.now ?? Date.now)();
  const entries = (deps.readEntries ?? (() => readLedger(home)))();
  const state = nightState(entries, (deps.readDecisions ?? (() => readDecisionEvents(home)))(), now);

  if (sub === 'status') {
    if (state.on) return describeOn(state, now, missingSupers(home, entries, state.start));
    return {on: false, ...(state.pending ? {pendingEnd: state.pending.phase, note: '끝났지만 아직 요약 전입니다(감시기 다음 주기나 다음 night 명령이 마무리합니다)'} : {}),
      last: lastRun(entries, state)};
  }
  if (!['on', 'off'].includes(sub)) throw new Error(`알 수 없는 night 명령. ${USAGE}`);

  const actor = isUserActor(by) ? 'human' : isSupervisorActor(by) ? 'super' : null;
  if (!actor) throw new Error('나이트 모드는 사람 또는 슈퍼감독만 켜고 끕니다');

  // 끝났는데 기록이 없는 켜짐(시각 만료·kyle의 새 입력)은 먼저 마무리한다. 이 마무리가 요약을 한 번 보낸다.
  let settled = null;
  if (state.pending) settled = finishNight({home, by, deps});

  if (sub === 'off') {
    if (settled) return {on: false, already: settled.phase, summary: settled.summary.text};
    if (!state.on) throw new Error('이미 꺼져 있습니다');
    const event = finishNight({home, by, phase: 'off', reason: typeof flags.reason === 'string' ? flags.reason : null, deps});
    if (!event) throw new Error('이미 꺼져 있습니다');
    return {on: false, phase: event.phase, summary: event.summary.text};
  }

  if (state.on) throw new Error(`이미 켜져 있습니다 — 문구는 덮어쓰지 않습니다. 바꾸려면 night off 뒤 다시 켜세요. ${JSON.stringify(describeOn(state, now, null))}`);
  const text = rest.join(' ').trim();
  if (!text) throw new Error(`위임 문구가 필요합니다. ${USAGE}`);
  const quote = typeof flags.quote === 'string' ? flags.quote.trim() : '';
  // 원장에 무한 길이를 쓰지 않는다. 긴 글은 요약 알림에서 접어 보이지만 원문 전체는 on 사건에 남으므로 상한을 둔다.
  for (const [name, value] of [['문구', text], ['kyle 원문', quote]])
    if (value.length > MAX_TEXT) throw new Error(`${name}이(가) ${MAX_TEXT}자를 넘습니다(${value.length}자): 줄여서 다시 켜세요`);
  const viaChat = actor === 'super';
  if (viaChat && !quote) throw new Error('슈퍼감독이 켤 때는 kyle의 채팅 원문이 필요합니다: kyle이 말한 그대로 --quote "<원문>"으로 옮기세요');
  if (flags['discord-message'] !== undefined && (typeof flags['discord-message'] !== 'string' || !flags['discord-message'])) throw new Error('--discord-message는 디코 글 id 하나여야 합니다');

  const until = resolveEnd({until: flags.until, for: flags.for}, now);
  const works = deps.readWorks ? deps.readWorks() : new WorkStore(home).list();
  const {to, unreachable} = nightTargets({works, entries, by});
  const message = buildNightMessage({text, quote, viaChat, by, untilMs: Date.parse(until)});
  const send = deps.sendMail ?? sendNightMail(home, by);
  const delivered = to.map(role => {
    try { return {role, ...send(role, message)}; } catch (error) { return {role, ok: false, error: String(error.message).slice(0, 200)}; }
  });
  const event = {
    kind: 'night', phase: 'on', by, text, ...(quote ? {quote} : {}), viaChat,
    ...(flags['discord-message'] ? {discordMessageId: flags['discord-message']} : {}),
    until, to, delivered, ...(unreachable.length ? {unreachable} : {}), t: new Date(now).toISOString(),
  };
  (deps.record ?? (entry => appendLedger(entry, home)))(event);
  return {on: true, until, untilLocal: clock(Date.parse(until)), to, delivered, ...(unreachable.length ? {unreachable} : {}), ...(settled ? {previousEnded: settled.phase} : {})};
}
