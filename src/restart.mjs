// Why: 실행기를 업데이트하거나 설정을 바꾼 뒤, 역할의 대화 기억은 그대로 두고 프로그램만 다시 띄운다(2026-10-14 [kyle]).
// 같은 이름·같은 대화(resume)·같은 작업 폴더·같은 모델 옵션이라 우편·책임 세대·관계표가 끊기지 않는다(docs/hierarchy.md).
//
// recovery.mjs(restoreRecovery)를 그대로 쓰지 않은 이유: 그 경로는 Rottie 탭 ID와 --rottie-bin을 전제로 한 "죽은 역할 복원"이라
// KADAN_WINDOW=none이나 살아 있는 pane의 의도적 재시작에는 쓸 수 없다. 대신 같은 조각(withRecoveryLock·launchIdentityOf·
// buildStartLedgerEntry/buildStopLedgerEntry·closeStartedWindow·startDigest)과 같은 "근거를 원장에 남기는" 규칙을 재사용한다.
//
// 순서가 안전의 전부다: 거절할 수 있는 모든 확인(대화 ID·저장 여부·명령 재조립·실행 중 보호)을 기존 세션을 끄기 *전에* 끝낸다.
import fs from 'node:fs';
import {startDigest, withRecoveryLock, checkpointSecretary, resumeSecretary} from './secretary-resume.mjs';
import {commandWords, launchIdentityOf, matchesAiProcess} from './ai-identity.mjs';
import {executorChain} from './process-tree.mjs';
import {conversationOf} from './conversation-ref.mjs';
import {runnerTemplate, rebuildResumeCommand, findConversation, checkConversationSpec, resumeTail,
  modelSwapLeftover} from './runner-table.mjs';
import {launchFor} from './runner-settings.mjs';
import {withInlineScreen, INLINE_FLAG} from './inline-screen.mjs';
import {withStopHook, wordsWithoutStopHook} from './stop-hook-settings.mjs';
import {buildStartLedgerEntry, buildStopLedgerEntry, workdirInsideHome, workdirInsideHomeMessage} from './cli-start-support.mjs';
import {sessionOwner, assertSessionOwner} from './session-ownership.mjs';

const SECRETARY = '비서';
export const MODEL_FROM_SETTINGS = 'model-from-settings';
// 계정 전환 재시작에서 끄기 직전 재확인이 "상태가 바뀌었다"며 막았다는 표시. 실패가 아니라 건너뜀이다(claude-refresh가 읽는다).
export const STATE_CHANGED_CODE = 'KADAN_REFRESH_STATE_CHANGED';
const fail = message => { throw new Error(message); };

// 이 세션의 현재 세대 시작 기록. 마지막 start 뒤에 stop이 있으면(restart가 남긴 stop 제외) 이미 끝난 역할이다.
function currentStart(entries, session) {
  const events = entries.filter(e => e.session === session);
  const index = events.findLastIndex(e => e.kind === 'start');
  if (index < 0) fail(`${session}의 시작 기록이 없다`);
  if (events.slice(index + 1).some(e => e.kind === 'stop')) fail(`${session}은 이미 종료된 역할이다 — restart는 살아 있는 역할만 다시 띄운다`);
  return events[index];
}

function ensureReady({role, session, floor, entries, deps, expectPid}) {
  if (floor.name !== 'tmux') fail('restart는 tmux 바닥에서만 쓴다');
  if (process.env.KADAN_ROLE === role) fail('자기 자신은 restart할 수 없다 — 다른 역할이나 사람이 실행한다(끄는 순간 이 명령도 같이 끝난다)');
  if (!floor.alive(session)) fail(`세션 없음: ${session} — 죽은 역할은 restart가 아니라 start/recovery로 되살린다`);
  const start = currentStart(entries, session);
  if ((start.floor && start.floor !== 'tmux') || !start.panePid) fail('tmux 역할 시작 기록이 불완전하다');
  // 화면(대시보드 '다시 띄우기')이 본 세대와 원장의 최신 시작을 대조한다. 그 사이 다시 띄워졌거나 멈췄으면
  // 두 번 재시작하지 않도록 거절한다(2026-10-15 [kyle] — 화면과 CLI가 같은 검사를 쓰게 --expect-pid로 둔다).
  if (expectPid != null && String(start.panePid) !== String(expectPid))
    fail(`화면이 본 세대와 다르다(받은 pane PID ${expectPid}, 최신 시작의 pane PID ${start.panePid}) — 이미 다시 띄웠거나 멈췄을 수 있다. 화면을 새로 읽고 다시 시도하라`);
  if (String(floor.pid(session)) !== String(start.panePid)) fail('지금 pane과 마지막 시작 기록의 PID가 다르다 — 다른 프로세스일 수 있어 중단한다');
  return start;
}

// 끝나지 않은 카드가 있어도 거절하지 않는다(2026-11-10 [kyle] "카드있을때 리스타트할수도있자나"). restart는 같은 대화·우편 세대·
// 카드 책임·감시 발령을 이어받아 카드가 끊기지 않는다. 대신 끄기 바로 앞에서 화면이 쉬는 중인지 확인한다(confirmBeforeStop).
// 목록은 원장 stop·start의 pendingTasks로 남기려고 돌려주기만 한다.
function guardRunning({role, entries, deps}) {
  return deps.pendingCards(entries, role);
}

// append-only 원장에서는 같은 PID·내용의 새 start도 역할 내 순번으로 구별한다.
function restartGeneration(entries, role) {
  let count = 0, start = null;
  for (const entry of entries) {
    if (entry.role !== role) continue;
    if (entry.kind === 'start') { count++; start = entry; }
    if (entry.kind === 'stop') start = null;
  }
  return start ? {count, digest: startDigest(start), pid: String(start.panePid)} : null;
}

// 끄기 → stop 원장. restart:true·restartOf로 우편·책임 세대를 이어간다.
// 순서: 원장 다시 읽기 → 세대·PID·소유 검사 → 안전 지점 확인(confirm) → floor.stop.
// 원장 읽기는 원장 크기에 비례해 오래 걸릴 수 있어 확인 **앞**에 둔다(PR #360 검수 F1: 확인 뒤에 읽으면 그 사이 응답을 시작한 역할을 껐다).
// 확인과 floor.stop 사이에는 아무 단계도 두지 않는다. 남는 틈은 확인이 끝나고 floor.stop이 실제로 세션을 죽이기까지뿐이며 없앨 수 없다.
function stopForRestart({role, session, floor, entries, deps, generation, forced, pending = [], reason, refresh, confirm = null}) {
  const latest = deps.read();
  const current = restartGeneration(latest, role);
  if (!generation || !current || current.count !== generation.count
      || current.digest !== generation.digest || current.pid !== generation.pid) {
    fail('대화를 확인한 뒤 역할 세대가 바뀌었습니다 — 새 상태를 확인하고 다시 시도하세요');
  }
  assertSessionOwner(sessionOwner(latest, session, role), floor.pid(session));
  if (confirm) confirm();
  floor.stop(session);
  const windowFields = deps.closeWindow(entries, session) ?? {};
  deps.record({...buildStopLedgerEntry({role, session}), restart: true, ...(reason ? {reason} : {}), ...(forced ? {forced: true, forcedTasks: forced} : {}),
    ...(!refresh && pending.length ? {pendingTasks: pending} : {}),
    ...(refresh ? {accountRefresh: true, pendingTasks: refresh.pending, ...(refresh.reasonNote ? {reasonNote: refresh.reasonNote} : {}), ...(refresh.accountSlot != null ? {accountSlot: refresh.accountSlot} : {})} : {}), ...windowFields});
  return windowFields;
}

// 끄기 직전 안전 지점 확인. 모든 restart가 쓴다(--force만 건너뜀). 계정 전환 재시작은 기존 '건너뜀' 코드·문구를 그대로 쓴다.
function confirmBeforeStop(session, deps, accountRefresh) {
  if (typeof deps.beforeStop !== 'function') fail(`끄기 직전 재확인 장치(deps.beforeStop)가 없어 ${accountRefresh ? '계정 전환 ' : ''}재시작을 하지 않는다`);
  try { deps.beforeStop(session); }
  catch (error) {
    if (!accountRefresh) fail(`응답 생성 중(또는 최근 사람 입력)이라 끄지 않았다 — 잠시 뒤 다시 하거나, 사람이 확인했으면 --force (확인 결과: ${error?.message ?? error})`);
    const stale = new Error(`건너뜀: 확인 뒤 상태 바뀜(${error?.message ?? error})`);
    stale.code = STATE_CHANGED_CODE;
    throw stale;
  }
}

export function restartRole({home, role, session, flags = {}, floor, settings, deps}) {
  // 비서는 resumeSecretary가 같은 잠금을 스스로 잡으므로 겹쳐 잡지 않는다.
  // 이유(--reason)는 stop·start 두 사건에 같은 값으로 남긴다. 세대 표시(--expect-pid)는 화면의 두 번 재시작 방지다.
  const given = typeof flags.reason === 'string' && flags.reason.trim() ? flags.reason.trim() : null;
  // 계정 전환 재시작이면 reason은 고정 코드, 사람이 준 이유는 reasonNote 칸으로 간다.
  const accountRefresh = flags.accountRefresh === true;
  const reason = accountRefresh ? 'account-refresh' : given;
  const reasonNote = accountRefresh ? given : null;
  const expectPid = flags['expect-pid'] ?? flags.expectPid ?? null;
  if (accountRefresh && role === SECRETARY) fail('비서는 계정 전환 재시작 대상이 아니다');
  // --model-from-settings(2026-11-10 [kyle]): 값 없는 옵션이다. 비서(체크포인트 경로)·계정 전환 재시작과는 함께 쓰지 않는다.
  const fromSettings = flags[MODEL_FROM_SETTINGS];
  if (fromSettings !== undefined && fromSettings !== true) fail(`--${MODEL_FROM_SETTINGS}는 값을 받지 않는다`);
  if (fromSettings && accountRefresh) fail(`계정 전환 재시작과 --${MODEL_FROM_SETTINGS}는 함께 쓸 수 없다`);
  if (fromSettings && role === SECRETARY)
    fail(`비서는 --${MODEL_FROM_SETTINGS} 대상이 아니다 — 비서는 실행 모델 설정의 역할이 아니고 별도 체크포인트 경로로 다시 열린다`);
  if (role === SECRETARY) return restartSecretary({home, role, session, floor, force: flags.force === true, reason, expectPid, deps});
  return withRecoveryLock(home, session, () => restartLocked({home, role, session, flags, floor, settings, deps, reason, reasonNote, expectPid}));
}

function restartLocked({home, role, session, flags, floor, settings, deps, reason, reasonNote, expectPid}) {
  const force = flags.force === true;
  const accountRefresh = flags.accountRefresh === true;
  const entries = deps.read();
  const start = ensureReady({role, session, floor, entries, deps, expectPid});
  const generation = restartGeneration(entries, role);
  const pending = guardRunning({role, entries, deps});

  const identity = launchIdentityOf(start.cmd);
  if (!identity.ok) fail(`마지막 시작 명령에서 등록 실행기·모델을 읽지 못했다(${identity.reason})`);
  const {harness, model} = identity;
  if (!settings) fail('실행 모델 설정이 없다 — kadan runners init 먼저');
  if (!settings.runners?.[harness]) fail(`이 실행기(${harness})는 runner-settings.json에 등록되지 않았다`);
  runnerTemplate(settings, harness, 'resume');
  const spec = settings.runners[harness].conversation;
  if (!spec) fail(`이 실행기(${harness})는 conversation 미지원 — runner-settings.json의 runners.${harness}.conversation 칸이 비어 있다`);
  checkConversationSpec(spec);
  if (!fs.statSync(start.cwd).isDirectory()) fail('역할 작업 폴더를 찾을 수 없다');
  const insideHome = workdirInsideHome(start.cwd, home);
  if (insideHome) fail(workdirInsideHomeMessage(insideHome));
  const launch = flags[MODEL_FROM_SETTINGS] === true ? settingsLaunch({start, settings, harness}) : null;

  // 1) 지금 이 pane이 실제로 연 대화를 표의 방식으로 확정한다. 확정 못 하면 끄지 않고 거절한다.
  const pane = deps.paneInfo(session);
  if (String(pane.panePid) !== String(start.panePid)) fail('tmux pane PID가 시작 기록과 다르다');
  // 실행기 본체 사슬(뿌리 1개 + 그 아래로 하나씩 이어지는 맞는 프로세스)이 연 파일만 후보다. 자식 도구나 같은 실행기의
  // 하위 에이전트가 연 대화를 집지 않는다. 뿌리가 둘이거나 사슬이 갈리거나 못 찾으면 거절한다.
  const chain = executorChain(deps.processTree(start.panePid), args => matchesAiProcess(args, harness, model));
  if (!chain) fail(`${harness} 실행기 본체 프로세스를 하나의 사슬로 정할 수 없다(없거나 여러 개·갈림) — 대화 파일의 주인을 확인할 수 없어 거절한다`);
  // pid-json은 뿌리 본체의 PID 파일만, open-file은 사슬 전체가 연 파일을 본다.
  const conversation = findConversation(spec, {pids: [chain.root], openFiles: () => deps.openFiles(chain.pids),
    readJson: deps.readJson, processStartedAt: deps.processStartedAt,
    tmuxLocation: pane.location, homeDir: deps.homeDir, exists: deps.exists});
  // 2) 마지막 시작 명령에서 대화 인자만 바꾼다. 실행기·모델이 그대로이고 같은 대화(resume)로 읽혀야 한다.
  // --model-from-settings면 바탕 명령만 설정 명령으로 바꾼다. 위 프로세스·대화 찾기는 옛 모델 기준(프로세스 인자는 옛 명령 그대로),
  // 아래 다시 만든 명령의 확인은 새 모델 기준이다.
  const kept = rebuildResumeCommand(settings, harness, start.cmd, conversation);
  const swap = launch ? settingsSwap({settings, harness, model, launch, kept}) : null;
  const expectedModel = swap?.changed ? launch.model : model;
  const rebuilt = swap?.changed ? rebuildResumeCommand(settings, harness, launch.cmd, conversation) : kept;
  const command = withStopHook(withInlineScreen(rebuilt));
  const again = launchIdentityOf(command), mode = conversationOf(command);
  if (!again.ok || again.harness !== harness || again.model !== expectedModel)
    fail(swap?.changed ? '다시 만든 명령의 실행기·모델이 설정값과 다르다' : '다시 만든 명령의 실행기·모델이 원본과 다르다');
  if (mode.conversationMode !== 'resume' || mode.conversationRef !== conversation) fail('다시 만든 명령이 같은 대화 resume으로 읽히지 않는다');

  // 3) 여기까지 거절 사유가 없다. 안전 지점 확인(화면 idle + 사람 입력 보호)은 stopForRestart 안에서, 원장 다시 읽기와
  // 세대·PID·소유 검사가 끝난 뒤 floor.stop 바로 앞에서 한다. 위 확인(대화 찾기 등)과 원장 읽기가 오래 걸려 그 사이
  // 응답이 시작되거나 사람이 입력했을 수 있어서다. 모든 restart가 확인하고 --force만 건너뛴다(계정 전환은 --force여도 확인한다).
  const confirm = accountRefresh || !force ? () => confirmBeforeStop(session, deps, accountRefresh) : null;
  // 이제 끄고 같은 정체로 다시 띄운다.
  const slot = Number.isInteger(flags.accountSlot) ? flags.accountSlot : null;
  const refresh = accountRefresh ? {pending, reasonNote, accountSlot: slot} : null;
  stopForRestart({role, session, floor, entries, deps, generation,
    forced: force ? pending : null, pending, reason, refresh, confirm});
  let evidence;
  try { evidence = floor.create({session, role, cwd: start.cwd, cmd: command}); }
  catch (error) {
    fail(`기존 ${session}은 종료됐고 새 세션을 만들지 못했다: ${error.message} — 직접 복구: cd ${start.cwd} && ${command}`);
  }
  const window = deps.openWindow({session, role, cwd: start.cwd, panePid: evidence.panePid ?? evidence.rottiePid}) ?? {};
  deps.record({
    ...buildStartLedgerEntry({floorName: floor.name, role, session, evidence, window: window.method ?? 'hidden',
      rottieTerminalId: window.rottieTerminalId, orcaTerminalHandle: window.orcaTerminalHandle, reused: window.reused,
      cmd: command, cwd: start.cwd}),
    ...(window.rottieBundleId ? {rottieBundleId: window.rottieBundleId, rottieConnect: window.rottieConnect, rottieConnectError: window.rottieConnectError} : {}),
    ...(start.roleProfile ? {roleProfile: start.roleProfile} : {}),
    // 설정에서 온 재시작: kadan start --profile의 설정 칸과 같은 이름으로 남겨 발령 기록·발령 경계가 그대로 읽는다.
    // 모델·강도가 이미 같아 옛 명령을 유지했는데 다른 옵션이 설정 명령과 다르면 설정 명령 그대로가 아니라 launchSource를 적지 않는다.
    ...(swap ? {
      ...(swap.differs ? {} : {launchSource: 'settings'}),
      modelFromSettings: true, settingsRevision: launch.revision, settingsPreset: launch.preset,
      runnerChoice: {runner: launch.runner, model: launch.model, ...(launch.effort ? {effort: launch.effort} : {})},
      ...(swap.previousModel ? {previousModel: swap.previousModel} : {}),
      ...(swap.previousEffort ? {previousEffort: swap.previousEffort} : {}),
    } : {}),
    restartOf: startDigest(start), restartConversation: conversation,
    ...(reason ? {reason} : {}),
    ...(force ? {forced: true, forcedTasks: pending} : {}),
    ...(refresh ? {accountRefresh: true, pendingTasks: pending, ...(reasonNote ? {reasonNote} : {})} : pending.length ? {pendingTasks: pending} : {}),
  });
  return {role, session, conversation, command, harness, model: expectedModel, panePid: evidence.panePid ?? null,
    forced: force, accountRefresh, pending, window: window.method ?? 'hidden',
    ...(swap ? {modelFromSettings: {changed: swap.changed, model: launch.model, effort: launch.effort ?? null,
      previousModel: model, previousEffort: swap.oldEffort, revision: launch.revision, preset: launch.preset}} : {})};
}

// --model-from-settings의 바탕 명령: 마지막 start의 프로필 + 지금 활성 프리셋(kadan start --profile이 띄우는 것과 같은 명령).
// 프로필을 추측하지 않고, 대화를 이어 열 수 없는 실행기 교체와 비교 보고서 귀속이 바뀌는 비교 모드 세션은 거절한다.
function settingsLaunch({start, settings, harness}) {
  const option = `--${MODEL_FROM_SETTINGS}`;
  const profile = start.roleProfile;
  if (start.compareMode) fail(`비교 모드로 띄운 역할은 ${option}로 모델을 바꾸지 않는다 — 비교 보고서의 귀속(프리셋·예약)이 중간에 바뀐다`);
  if (!profile)
    fail(`이 역할은 시작 기록에 프로필이 없어 설정에서 모델을 정할 수 없다 — ${option} 없이 다시 띄우거나 kadan start --profile로 새로 띄운다`);
  const launch = launchFor(settings, profile);
  if (!launch) fail(`실행 모델 설정(활성 프리셋 ${settings.activePreset})에 ${profile} 역할 값이 없다 — 설정에서 모델을 정할 수 없다`);
  const want = launchIdentityOf(launch.cmd);
  if (!want.ok) fail(`설정 명령에서 등록 실행기·모델을 읽지 못했다(${want.reason})`);
  if (want.harness !== harness)
    fail(`설정의 ${profile} 실행기(${want.harness})가 이 역할의 실행기(${harness})와 다르다 — 실행기가 바뀌면 같은 대화를 이어 열 수 없다`);
  return {...launch, model: want.model};
}

// 옛 명령을 설정 명령으로 바꿔도 되는지 본다. 모델·강도 자리를 빼고 양쪽을 대조해, 옛 명령에만 있는 낱말(조용히 버려짐)이나
// 설정 명령에만 있는 낱말(조용히 붙음 — 권한 옵션 등)이 하나라도 있으면 거절한다. kept는 옛 명령에 현재 대화 꼬리를 붙인
// 평소 restart 명령이다. 모델·강도가 이미 설정과 같으면 옛 명령을 그대로 쓰므로 버려지거나 붙는 낱말이 없다. 그때는 거절하지 않는다.
function settingsSwap({settings, harness, model, launch, kept}) {
  const strip = words => wordsWithoutStopHook(words.filter(word => word !== INLINE_FLAG));
  const oldWords = strip(commandWords(kept).slice(0, -resumeTail(settings, harness).length));
  const {previous, leftover, added} = modelSwapLeftover(settings, harness, oldWords, strip(commandWords(launch.cmd)));
  const oldEffort = previous.effort ?? null, newEffort = launch.effort ?? null;
  const changed = launch.model !== model || oldEffort !== newEffort;
  const differs = leftover.length + added.length > 0;
  if (changed && differs) {
    const sides = [added.length ? `설정 명령에만 있는 옵션: ${added.join(' ')}` : null,
      leftover.length ? `옛 명령에만 있는 옵션: ${leftover.join(' ')}` : null].filter(Boolean).join(' / ');
    fail(`${sides} — 권한·옵션이 달라 설정 명령으로 바꾸지 않는다(설정 명령: ${launch.cmd})`);
  }
  return {changed, oldEffort, differs, previousModel: launch.model !== model ? model : null,
    previousEffort: oldEffort !== newEffort ? oldEffort : null};
}

// 비서는 일반 찾기를 쓰지 않는다 — kadan up과 같은 체크포인트(secretary-resume.json) 경로로 같은 start 사건을 만든다.
function restartSecretary({home, role, session, floor, force, reason, expectPid, deps}) {
  // 확인·체크포인트·끄기는 잠금 안에서, 다시 열기는 resumeSecretary의 잠금 안에서 한다(둘 사이에 kadan up이 끼어들어도 한 번만 열린다).
  const {pending, previous} = withRecoveryLock(home, session, () => {
    const entries = deps.read();
    const start = ensureReady({role, session, floor, entries, deps, expectPid});
    const generation = restartGeneration(entries, role);
    const open = guardRunning({role, entries, deps});
    const checkpoint = checkpointSecretary({home, floor, read: deps.read, ...(deps.findTranscript ? {findTranscript: deps.findTranscript} : {})});
    // 복원 정보를 못 만들면(codex가 아닌 비서·래퍼 명령 등) 지원하지 않는 역할을 끄지 않는다.
    if (!checkpoint) fail('이 비서는 기억 유지 restart를 지원하지 않는다 — 복원 정보(secretary-resume.json)를 만들 수 없다(codex 비서만 지원). 기존 세션은 그대로 둔다');
    // 비서도 같은 안전 지점 확인을 같은 자리(stopForRestart 안, floor.stop 바로 앞)에서 한다 — confirmIdleBeforeStop은
    // 화면 상태 줄(claude·codex 둘 다 읽음)만 보고 실행기에 묶이지 않는다. 거절되면 위에서 만든 체크포인트 파일만 남는다.
    stopForRestart({role, session, floor, entries, deps, generation, forced: force ? open : null, pending: open, reason,
      confirm: force ? null : () => confirmBeforeStop(session, deps, false)});
    return {pending: open, previous: startDigest(start)};
  });
  // 새 start에도 restartOf(·forced)를 남겨 감시 발령·우편·책임이 일반 역할과 같게 이어진다(kadan up 복원 경로는 그대로).
  const result = resumeSecretary({home, floor, read: deps.read, record: deps.record,
    startExtra: {restartOf: previous, ...(reason ? {reason} : {}), ...(force ? {forced: true, forcedTasks: pending} : {}), ...(pending.length ? {pendingTasks: pending} : {})}, startNew: () => fail('비서 대화 정보가 없어 새로 만들지 않는다')});
  if (result !== 'restored') fail(`비서 복원 결과가 예상과 다르다: ${result}`);
  const latest = deps.read().findLast(e => e.kind === 'start' && e.session === session);
  return {role, session, conversation: latest?.secretaryConversation ?? null, command: latest?.cmd ?? null, harness: latest?.harness ?? null,
    model: latest?.model ?? null, panePid: latest?.panePid ?? null, forced: force, pending, window: latest?.window ?? 'hidden'};
}
