// kadan autopilot on/off/status — Autopilot 명령. 설계: docs/daily/research/2026-10-23_나이트-모드.md
// 새 권한이 아니다: kyle의 현재 말을 기록하고 슈퍼감독에게 나눠 줄 뿐, 승인·머지·결정 답은 대신하지 않는다.
import {appendLedger, readLedger} from '../ledger.mjs';
import {isUserActor, isSupervisorActor} from '../actors.mjs';
import {WorkStore} from '../work-store.mjs';
import {
  autopilotState, autopilotTargets, resolveEnd, buildAutopilotMessage, sendAutopilotMail, finishAutopilot, readDecisionEvents, clock, AUTO_CHECKLIST,
} from '../autopilot.mjs';
import {buildAutopilotNote, noteLine} from '../autopilot-note.mjs';
import {picksCommand} from '../autopilot-picks.mjs';
import {readDefaultWingman, setDefaultWingman, clearDefaultWingman, wingmanPath, NO_WINGMAN} from '../autopilot-wingman.mjs';
import {setRepoPolicy, evaluateGithub, listRepos, policyPath, normalizeGithub} from '../autopilot-repo-policy.mjs';
import {LEVELS, LEVEL_CRUISE, LEVEL_AUTOPILOT, LEVEL_FULL, LEVEL_LABEL} from '../autopilot-terms.mjs';

export const MAX_TEXT = 4000;
const ON_FLAGS = new Set(['help', 'until', 'for', 'quote', 'level', 'allow', 'wingman', 'discord-message']);
const USAGE = 'kadan autopilot on "<문구>" [--until HH:MM | --for 8h] [--quote "<kyle 원문>"] [--level cruise | --level autopilot [--allow <소유자/이름>]… [--wingman <슈퍼감독>|없음]] [--discord-message <글 id>] | off [--reason 이유] | status | repo [<소유자/이름> --deploy-branch <브랜치|없음> --night-merge 허용|금지 | --clear deployBranch|nightMerge] | repo list | repo show <소유자/이름> | wingman [<슈퍼감독> | --clear] | picks --todo <절대경로>… [--json] | note <decision|hold|gate|merge|start> "<한 줄>" [--work 키] [--pr 저장소#번호] [--sha …] [--reason …] [--hold-kind decision|gate|deploy-repo] [--verdict pass|reject]';

function describeOn(state, now, missing) {
  const on = state.start, untilMs = Date.parse(on.until);
  return {
    on: true, text: on.text, by: on.by, viaChat: on.viaChat === true, ...(on.quote ? {quote: on.quote} : {}),
    startedAt: on.t, until: on.until, untilLocal: clock(untilMs), remainingMinutes: Math.max(0, Math.round((untilMs - now) / 60_000)),
    level: on.level ?? LEVEL_CRUISE, allow: on.allow ?? [],
    wingman: on.wingman ?? null, wingmanSource: on.wingmanSource ?? 'none', ...(on.wingmanNote ? {wingmanNote: on.wingmanNote} : {}),
    to: on.to ?? [], delivered: on.delivered ?? [], missing,
  };
}

// 열린 업무를 가진 슈퍼감독 중 문구를 받지 못한 이름. 관계표나 업무를 못 읽으면 모른다(null).
function missingSupers(home, entries, on) {
  try {
    const {to} = autopilotTargets({works: new WorkStore(home).list(), entries, by: on.by});
    return to.filter(role => !(on.to ?? []).includes(role));
  } catch { return null; }
}

// 가장 최근 켜짐의 원문. 원장의 마지막 `on` 사건과 그 뒤 끝 사건에서 읽는다(새 저장소 없음). 켠 적이 없으면 null.
function lastRun(entries, state) {
  let end = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.kind !== 'autopilot') continue;
    if (e.phase !== 'on') { end ??= e; continue; }
    const endedAt = end ? end.endedAt : (state.pending ? new Date(state.pending.endedAt).toISOString() : undefined);
    return {phase: end?.phase ?? state.pending?.phase ?? 'on', t: (end ?? e).t, startedAt: e.t, ...(endedAt ? {endedAt} : {}),
      by: e.by, viaChat: e.viaChat === true, text: e.text, ...(e.quote ? {quote: e.quote} : {})};
  }
  return null;
}

// `status --text`의 글: 문구·kyle 원문을 줄바꿈 그대로 보인다. 켜 있으면 지금 문구와 끝 시각, 켠 적이 없으면 한 줄 안내.
export function autopilotOriginalText(result) {
  const run = result?.on ? result : result?.last;
  if (!run?.text) return '켠 적이 없습니다. 원문이 없습니다.';
  return [`--- ${result?.on ? '지금 켜진' : '마지막'} 위임 원문 (${run.by}${run.viaChat ? ', kyle 채팅을 옮겨 적음' : ''}) ---`, run.text,
    ...(run.quote ? ['--- kyle 채팅 원문 ---', run.quote] : []),
    ...(result?.on ? [`--- Wingman: ${result.wingman ?? 'Wingman 없음'}${result.wingmanNote ? ` (${result.wingmanNote})` : ''} ---`] : []),
    `--- ${result?.on ? `끝: ${result.untilLocal}` : `${run.startedAt} ~ ${run.endedAt ?? '끝 시각 미기록'}`} ---`].join('\n');
}

// 저장소 정책 한 줄 묶음을 사람이 읽는 줄로. 온톨로지 문서는 ontology/ 기준 상대 경로만 보인다(절대 경로 없음).
function repoLines(info) {
  const {settings: s, card, effective: e, verdict: v} = info;
  const name = info.github ?? info.repo ?? '(이름 모름)';
  const word = v.action === 'merge' ? 'Autopilot 중 자동 머지' : 'Autopilot 중 자동 머지 안 함';
  const where = info.repo && info.github && info.repo !== info.github ? ` [업무 ${info.repo}]` : '';
  const from = x => (x.from === 'kadan' ? '카단 설정' : x.from === 'ontology' ? '온톨로지 문서' : '값 없음');
  return [
    `${name}${where}: 카단 설정 deployBranch ${s.deployBranch ?? '(미설정)'}, nightMerge ${s.nightMerge ?? '(미설정)'}${s.at ? ` (${s.at}, ${s.by})` : ''}`,
    `${name}: 온톨로지 문서 ${card ? card.path : '없음'}`,
    `${name}: 적용값 deployBranch ${e.deployBranch.value ?? '(비어 있음)'} [${from(e.deployBranch)}], Autopilot 중 자동 머지(nightMerge) ${e.nightMerge.value ?? '(비어 있음=허용)'} [${from(e.nightMerge)}]`,
    `${name}: 최종 판정 ${word} (${v.reason}${v.detail ? `, ${v.detail}` : ''}${v.exceptBranch ? `, ${v.exceptBranch}으로 가는 PR만 보류` : ''})`,
  ];
}

// `autopilot wingman`: 기본 Wingman 보기·저장·지우기. 쓰기는 Autopilot 중 역할 세션에서 autopilot-guard가 거절한다. 원장은 읽지 않는다.
function wingmanCommand(args, flags, {home, by, deps}) {
  const [name, extra] = args, usage = 'kadan autopilot wingman [<슈퍼감독> | --clear]';
  if (extra !== undefined) throw new Error(`Wingman 이름은 하나만 줄 수 있습니다. ${usage}`);
  const now = (deps.now ?? Date.now)();
  // 쓰기(저장·지우기)는 사람만 한다: 행위자가 역할이면 Autopilot이 꺼져 있어도 거절한다. 보기는 누구나.
  if ((name !== undefined || flags.clear !== undefined) && !isUserActor(by)) throw new Error(`기본 Wingman 저장·지우기는 사람만 할 수 있습니다(행위자: ${by})`);
  if (flags.clear !== undefined) {
    if (flags.clear !== true || name !== undefined) throw new Error(`--clear는 이름 없이 혼자 씁니다. ${usage}`);
    const r = clearDefaultWingman(home, {by, now});
    return `기본 Wingman 지움 (이전 ${r.before ?? '없음'})`;
  }
  if (name === undefined) {
    const cur = readDefaultWingman(home);
    return [`기본 Wingman: ${cur.wingman ?? '없음'}${cur.at ? ` (${cur.at}, ${cur.by})` : ''}`, ...(cur.corrupt ? [`경고: ${cur.corrupt}`] : []), `저장 파일: ${wingmanPath(home)}`].join('\n');
  }
  const r = setDefaultWingman(home, {wingman: name, by, now});
  return `기본 Wingman 저장: ${r.wingman} (이전 ${r.before ?? '없음'}). 켤 때 --level autopilot이면 이 슈퍼감독이 Wingman이 됩니다`;
}

const flagText = v => (typeof v === 'string' ? v : undefined);

// `autopilot repo`: 읽기(인자 없음·list·show)와 쓰기(<소유자/이름> --deploy-branch/--night-merge/--clear). 원장은 읽지 않고 업무 목록만 읽는다.
function repoCommand(args, flags, {home, by, deps}) {
  const [name, value] = args;
  const works = () => (deps.readWorks ?? (() => new WorkStore(home).list()))();
  const usage = 'kadan autopilot repo <소유자/이름> [--deploy-branch <브랜치|없음>] [--night-merge 허용|금지] [--clear deployBranch|nightMerge] | list | show <소유자/이름>';
  if (name === undefined) return `정책 파일: ${policyPath(home)}\n사용법: ${usage}`;
  const listOpts = deps.origin ? {origin: deps.origin} : {};
  if (name === 'list') {
    const {corrupt, repos, legacy, unreadable} = listRepos(home, works(), listOpts);
    return [...(corrupt ? [`경고: ${corrupt} — 읽기는 Autopilot 중 자동 머지 안 함으로 봅니다`] : []),
      ...unreadable.map(u => `읽지 못함: ${u.path ?? '온톨로지 폴더'} — ${u.reason}`),
      ...(repos.length ? repos.flatMap(repoLines) : ['저장된 값도 온톨로지 문서도 업무 저장소도 없습니다']),
      ...legacy.map(l => `옛 형식 저장값(판정에 쓰지 않음): ${l.name} = ${l.value} — kadan autopilot repo ${l.name.includes('/') ? l.name : '<소유자/이름>'} --deploy-branch … 로 다시 설정하세요`)].join('\n');
  }
  if (name === 'show') {
    if (!value) throw new Error('저장소 이름이 필요합니다: kadan autopilot repo show <소유자/이름>');
    if (!normalizeGithub(value)) throw new Error(`저장소 키는 GitHub 소유자/이름이어야 합니다: ${value}`);
    return repoLines(evaluateGithub(home, value)).join('\n');
  }
  if (value !== undefined) throw new Error(`예전 merge|hold 쓰기는 없어졌습니다. ${usage}`);
  const [deployBranch, nightMerge, clear] = [flagText(flags['deploy-branch']), flagText(flags['night-merge']), flagText(flags.clear)];
  for (const key of ['deploy-branch', 'night-merge', 'clear']) if (flags[key] !== undefined && typeof flags[key] !== 'string') throw new Error(`--${key}에는 값이 하나 필요합니다. ${usage}`);
  const saved = setRepoPolicy(home, {repo: name, deployBranch, nightMerge, clear, by, record: deps.record ?? (entry => appendLedger(entry, home))});
  return [`저장: ${saved.repo} deployBranch ${saved.deployBranch ?? '(미설정)'}, nightMerge ${saved.nightMerge ?? '(미설정)'} (이전 deployBranch ${saved.before.deployBranch ?? '(미설정)'}, nightMerge ${saved.before.nightMerge ?? '(미설정)'})`,
    ...repoLines(evaluateGithub(home, saved.repo))].join('\n');
}

// deps(시험용 주입): now, sendMail(role, message), readWorks, readEntries, readDecisions, record, notify, readBody.
export function autopilotCommand(args, flags, {home, by, deps = {}}) {
  const [sub, ...rest] = args;
  if (flags.help || !sub) return USAGE;
  if (sub === 'repo') return repoCommand(rest, flags, {home, by, deps});
  if (sub === 'wingman') return wingmanCommand(rest, flags, {home, by, deps});
  if (sub === 'picks') return picksCommand(flags, {home, deps});
  const now = (deps.now ?? Date.now)();
  const entries = (deps.readEntries ?? (() => readLedger(home)))();
  const state = autopilotState(entries, (deps.readDecisions ?? (() => readDecisionEvents(home)))(), now);

  if (sub === 'status') {
    if (state.on) return describeOn(state, now, missingSupers(home, entries, state.start));
    return {on: false, ...(state.pending ? {pendingEnd: state.pending.phase, note: '끝났지만 아직 요약 전입니다(감시기 다음 주기나 다음 autopilot 명령이 마무리합니다)'} : {}),
      last: lastRun(entries, state)};
  }
  if (sub === 'note') {
    // 켜져 있을 때만 받는다. 끝났지만 요약 전인 켜짐도 꺼짐으로 보고 거절한다(마무리는 on/off/감시기 몫). 역할 세션·사람 모두 쓸 수 있다.
    if (!state.on) throw Object.assign(new Error('Autopilot이 켜져 있을 때만 기록할 수 있습니다'), {exitCode: 2});
    const event = buildAutopilotNote({words: rest, flags, by, now});
    (deps.record ?? (entry => appendLedger(entry, home)))(event);
    return noteLine(event);
  }
  if (!['on', 'off'].includes(sub)) throw new Error(`알 수 없는 autopilot 명령. ${USAGE}`);

  const actor = isUserActor(by) ? 'human' : isSupervisorActor(by) ? 'super' : null;
  if (!actor) throw new Error('Autopilot은 사람 또는 슈퍼감독만 켜고 끕니다');

  // on이 받는 옵션. 그 밖(없앤 --only-running 포함)은 모르는 옵션으로 거절한다. 마무리·기록 전에 본다.
  const unknown = sub === 'on' ? Object.keys(flags).find(name => !ON_FLAGS.has(name)) : undefined;
  if (unknown) throw Object.assign(new Error(`autopilot on이 모르는 옵션: --${unknown}. ${USAGE}`), {exitCode: 2});

  // 끝났는데 기록이 없는 켜짐(시각 만료·kyle의 새 입력)은 먼저 마무리한다. 이 마무리가 요약을 한 번 보낸다.
  let settled = null;
  if (state.pending) settled = finishAutopilot({home, by, deps});

  if (sub === 'off') {
    if (settled) return {on: false, already: settled.phase, summary: settled.summary.text};
    if (!state.on) throw new Error('이미 꺼져 있습니다');
    const event = finishAutopilot({home, by, phase: 'off', reason: typeof flags.reason === 'string' ? flags.reason : null, deps});
    if (!event) throw new Error('이미 꺼져 있습니다');
    return {on: false, phase: event.phase, summary: event.summary.text};
  }

  if (state.on) throw new Error(`이미 켜져 있습니다 — 문구는 덮어쓰지 않습니다. 바꾸려면 autopilot off 뒤 다시 켜세요. ${JSON.stringify(describeOn(state, now, null))}`);
  const text = rest.join(' ').trim();
  if (!text) throw new Error(`위임 문구가 필요합니다. ${USAGE}`);
  const quote = typeof flags.quote === 'string' ? flags.quote.trim() : '';
  // 원장에 무한 길이를 쓰지 않는다. 긴 글은 요약 알림에서 접어 보이지만 원문 전체는 on 사건에 남으므로 상한을 둔다.
  for (const [name, value] of [['문구', text], ['kyle 원문', quote]])
    if (value.length > MAX_TEXT) throw new Error(`${name}이(가) ${MAX_TEXT}자를 넘습니다(${value.length}자): 줄여서 다시 켜세요`);
  const viaChat = actor === 'super';
  if (viaChat && !quote) throw new Error('슈퍼감독이 켤 때는 kyle의 채팅 원문이 필요합니다: kyle이 말한 그대로 --quote "<원문>"으로 옮기세요');
  if (flags['discord-message'] !== undefined && (typeof flags['discord-message'] !== 'string' || !flags['discord-message'])) throw new Error('--discord-message는 디코 글 id 하나여야 합니다');

  // 단계: 없으면 cruise(고정 줄 3개만, 원장에도 cruise로 적는다). full(완전자율)은 아직 구현하지 않는다.
  const level = flags.level ?? LEVEL_CRUISE;
  if (level !== LEVEL_FULL && !LEVELS.includes(level)) throw new Error(`--level은 ${LEVELS.join('|')}만 쓸 수 있습니다. ${USAGE}`);
  if (level === LEVEL_FULL) throw Object.assign(new Error(`--level ${LEVEL_FULL}(${LEVEL_LABEL[LEVEL_FULL]})은 아직 구현하지 않았습니다`), {exitCode: 2});
  const auto = level === LEVEL_AUTOPILOT;

  // --allow: 그날 밤에만 정책 보류(금지·배포 브랜치) 두 가지를 푸는 kyle의 허용. Autopilot 단계에서만, 값마다 올바른 키, kyle 원문 필수.
  let allow;
  if (flags.allow !== undefined) {
    if (!auto) throw new Error('--allow는 --level autopilot과 함께만 쓸 수 있습니다');
    const keys = (Array.isArray(flags.allow) ? flags.allow : [flags.allow]).map(v => {
      const key = typeof v === 'string' ? normalizeGithub(v) : null;
      if (!key) throw new Error(`--allow에는 GitHub 소유자/이름 값이 필요합니다(받은 값: ${typeof v === 'string' ? v : '없음'}). ${USAGE}`);
      return key;
    });
    if (!quote) throw new Error('--allow를 쓰려면 kyle이 말한 그대로 --quote "<원문>"이 필요합니다: 누가 켜든 같습니다');
    allow = [...new Set(keys)];
  }

  // --wingman: Autopilot 단계의 Wingman 슈퍼감독. 이름은 --wingman <이름>, 안 쓰려면 --wingman 없음, 안 주면 저장된 기본 Wingman이다(자동 고르기 없음).
  const wingmanFlag = flags.wingman;
  if (wingmanFlag !== undefined) {
    if (typeof wingmanFlag !== 'string' || !wingmanFlag.trim()) throw new Error(`--wingman에는 슈퍼감독 이름 하나 또는 ${NO_WINGMAN}가 필요합니다. ${USAGE}`);
    if (wingmanFlag !== NO_WINGMAN && !auto) throw new Error('--wingman <이름>은 --level autopilot과 함께만 쓸 수 있습니다');
  }
  const explicit = typeof wingmanFlag === 'string' && wingmanFlag !== NO_WINGMAN ? wingmanFlag : null;

  const until = resolveEnd({until: flags.until, for: flags.for}, now);
  const works = deps.readWorks ? deps.readWorks() : new WorkStore(home).list();
  const {to, unreachable} = autopilotTargets({works, entries, by});
  let wingman = explicit, wingmanSource = 'flag', wingmanNote;
  if (!wingman && wingmanFlag === undefined && auto) {
    const saved = readDefaultWingman(home);
    wingman = saved.wingman; wingmanSource = 'default';
    if (saved.corrupt) wingmanNote = `기본 Wingman 파일을 읽지 못함(${saved.corrupt}) — Wingman 없음`;
  }
  if (wingman) {
    const why = !isSupervisorActor(wingman) ? '슈퍼감독 이름이 아님' : !to.includes(wingman) ? '이번 밤 문구를 받는 슈퍼감독이 아님(열린 업무 없음)' : null;
    if (why && explicit) throw new Error(`Wingman ${wingman}을(를) 쓸 수 없습니다(${why}): 켜지 않았습니다`);
    if (why) { wingmanNote = `기본 Wingman ${wingman} 못 씀(${why}) — Wingman 없음`; wingman = null; }
  }
  const send = deps.sendMail ?? sendAutopilotMail(home, by);
  const attempt = (role, isWingman) => {
    const message = buildAutopilotMessage({text, quote, viaChat, by, untilMs: Date.parse(until), level, allow, isWingman});
    // 던진 오류도 결과로 바꾼다. 전달 상태를 모르는 실패는 unknown(갔을 수 있음)이다.
    try { return {role, ...send(role, message)}; } catch (error) { return {role, ok: false, delivery: error.delivery ?? 'unknown', error: String(error.message).slice(0, 200)}; }
  };
  // Wingman에게 먼저 보낸다. 불변식: Wingman이 켜짐 우편을 받았을 수 있으면 원장은 켜짐이다(2026-11-10).
  // 확실히 안 간 경우(not-sent)만 지금처럼 멈춘다(명시면 아무에게도 알리지 않고 실패, 기본이면 Wingman 없이 켬).
  // 전달됨·기록 실패(sent)·불명확(unknown, 시간 초과·전달 상태 없는 실패 포함)은 켜고 Wingman을 유지하며 wingmanNote에 남긴다.
  const results = new Map();
  if (wingman) {
    const r = attempt(wingman, true);
    results.set(wingman, r);
    if (!r.ok) {
      const delivery = r.delivery ?? 'unknown';
      if (delivery === 'not-sent') {
        if (explicit) throw new Error(`Wingman ${wingman}에게 우편이 가지 않아 켜지 않았습니다(${r.error ?? '전달 실패'})`);
        wingmanNote = `기본 Wingman ${wingman} 못 씀(우편 전달 실패) — Wingman 없음`; wingman = null;
      } else {
        wingmanNote = `Wingman ${wingman} 우편 전달 불명확(${delivery === 'sent' ? '전달됨·기록 실패' : '갔는지 모름'}) — Wingman 유지`;
      }
    }
  }
  for (const role of to) if (!results.has(role)) results.set(role, attempt(role, false));
  const delivered = to.map(role => results.get(role));
  const wingmanFields = {wingman, wingmanSource: wingman ? wingmanSource : 'none', ...(wingmanNote ? {wingmanNote} : {})};
  const event = {
    kind: 'autopilot', phase: 'on', by, text, ...(quote ? {quote} : {}), viaChat,
    ...(flags['discord-message'] ? {discordMessageId: flags['discord-message']} : {}),
    level, ...(allow ? {allow} : {}), ...wingmanFields,
    until, to, delivered, ...(unreachable.length ? {unreachable} : {}), t: new Date(now).toISOString(),
  };
  (deps.record ?? (entry => appendLedger(entry, home)))(event);
  return {on: true, level, ...(auto ? {checklist: AUTO_CHECKLIST} : {}), ...(allow ? {allow} : {}), ...wingmanFields, until, untilLocal: clock(Date.parse(until)), to, delivered, ...(unreachable.length ? {unreachable} : {}), ...(settled ? {previousEnded: settled.phase} : {})};
}
