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
import {launchIdentityOf, matchesAiProcess} from './ai-identity.mjs';
import {executorChain} from './process-tree.mjs';
import {conversationOf} from './conversation-ref.mjs';
import {runnerTemplate, rebuildResumeCommand, findConversation, checkConversationSpec} from './runner-table.mjs';
import {buildStartLedgerEntry, buildStopLedgerEntry} from './cli-start-support.mjs';

const SECRETARY = '비서';
const fail = message => { throw new Error(message); };

// 이 세션의 현재 세대 시작 기록. 마지막 start 뒤에 stop이 있으면(restart가 남긴 stop 제외) 이미 끝난 역할이다.
function currentStart(entries, session) {
  const events = entries.filter(e => e.session === session);
  const index = events.findLastIndex(e => e.kind === 'start');
  if (index < 0) fail(`${session}의 시작 기록이 없다`);
  if (events.slice(index + 1).some(e => e.kind === 'stop')) fail(`${session}은 이미 종료된 역할이다 — restart는 살아 있는 역할만 다시 띄운다`);
  return events[index];
}

function ensureReady({role, session, floor, entries, deps}) {
  if (floor.name !== 'tmux') fail('restart는 tmux 바닥에서만 쓴다');
  if (process.env.KADAN_ROLE === role) fail('자기 자신은 restart할 수 없다 — 다른 역할이나 사람이 실행한다(끄는 순간 이 명령도 같이 끝난다)');
  if (!floor.alive(session)) fail(`세션 없음: ${session} — 죽은 역할은 restart가 아니라 start/recovery로 되살린다`);
  const start = currentStart(entries, session);
  if ((start.floor && start.floor !== 'tmux') || !start.panePid) fail('tmux 역할 시작 기록이 불완전하다');
  if (String(floor.pid(session)) !== String(start.panePid)) fail('지금 pane과 마지막 시작 기록의 PID가 다르다 — 다른 프로세스일 수 있어 중단한다');
  return start;
}

function guardRunning({role, entries, force, deps}) {
  const pending = deps.pendingCards(entries, role);
  if (pending.length && !force) {
    fail(`${role}에 끝나지 않은 카드 ${pending.length}건이 있다: ${pending.join(', ')} — 사람이 확인했으면 --force로 다시 실행한다`);
  }
  return pending;
}

// 끄기 → stop 원장. restart가 낸 stop은 표시를 달아 "사용자가 직접 끈 역할"로 읽히지 않게 한다.
function stopForRestart({role, session, floor, entries, deps, forced}) {
  floor.stop(session);
  const windowFields = deps.closeWindow(entries, session) ?? {};
  deps.record({...buildStopLedgerEntry({role, session}), restart: true, ...(forced ? {forced: true, forcedTasks: forced} : {}), ...windowFields});
  return windowFields;
}

export function restartRole({home, role, session, flags = {}, floor, settings, deps}) {
  // 비서는 resumeSecretary가 같은 잠금을 스스로 잡으므로 겹쳐 잡지 않는다.
  if (role === SECRETARY) return restartSecretary({home, role, session, floor, force: flags.force === true, deps});
  return withRecoveryLock(home, session, () => restartLocked({home, role, session, flags, floor, settings, deps}));
}

function restartLocked({home, role, session, flags, floor, settings, deps}) {
  const force = flags.force === true;
  const entries = deps.read();
  const start = ensureReady({role, session, floor, entries, deps});
  const pending = guardRunning({role, entries, force, deps});

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

  // 1) 지금 이 pane이 실제로 연 대화를 표의 방식으로 확정한다. 확정 못 하면 끄지 않고 거절한다.
  const pane = deps.paneInfo(session);
  if (String(pane.panePid) !== String(start.panePid)) fail('tmux pane PID가 시작 기록과 다르다');
  // 실행기 본체 사슬(뿌리 1개 + 그 아래로 하나씩 이어지는 맞는 프로세스)이 연 파일만 후보다. 자식 도구나 같은 실행기의
  // 하위 에이전트가 연 대화를 집지 않는다. 뿌리가 둘이거나 사슬이 갈리거나 못 찾으면 거절한다.
  const chain = executorChain(deps.processTree(start.panePid), args => matchesAiProcess(args, harness, model));
  if (!chain) fail(`${harness} 실행기 본체 프로세스를 하나의 사슬로 정할 수 없다(없거나 여러 개·갈림) — 대화 파일의 주인을 확인할 수 없어 거절한다`);
  // pid-json은 뿌리 본체의 PID 파일만, open-file은 사슬 전체가 연 파일을 본다.
  const conversation = findConversation(spec, {pids: [chain.root], openFiles: () => deps.openFiles(chain.pids),
    readJson: deps.readJson, tmuxLocation: pane.location, homeDir: deps.homeDir, exists: deps.exists});
  // 2) 마지막 시작 명령에서 대화 인자만 바꾼다. 실행기·모델이 그대로이고 같은 대화(resume)로 읽혀야 한다.
  const command = rebuildResumeCommand(settings, harness, start.cmd, conversation);
  const again = launchIdentityOf(command), mode = conversationOf(command);
  if (!again.ok || again.harness !== harness || again.model !== model) fail('다시 만든 명령의 실행기·모델이 원본과 다르다');
  if (mode.conversationMode !== 'resume' || mode.conversationRef !== conversation) fail('다시 만든 명령이 같은 대화 resume으로 읽히지 않는다');

  // 3) 여기까지 거절 사유가 없다. 이제 끄고 같은 정체로 다시 띄운다.
  stopForRestart({role, session, floor, entries, deps, forced: force ? pending : null});
  let evidence;
  try { evidence = floor.create({session, role, cwd: start.cwd, cmd: command}); }
  catch (error) {
    fail(`기존 ${session}은 종료됐고 새 세션을 만들지 못했다: ${error.message} — 직접 복구: cd ${start.cwd} && ${command}`);
  }
  const window = deps.openWindow({session, role, panePid: evidence.panePid ?? evidence.rottiePid}) ?? {};
  deps.record({
    ...buildStartLedgerEntry({floorName: floor.name, role, session, evidence, window: window.method ?? 'hidden',
      rottieTerminalId: window.rottieTerminalId, orcaTerminalHandle: window.orcaTerminalHandle, reused: window.reused,
      cmd: command, cwd: start.cwd}),
    ...(window.rottieBundleId ? {rottieBundleId: window.rottieBundleId, rottieConnect: window.rottieConnect, rottieConnectError: window.rottieConnectError} : {}),
    ...(start.roleProfile ? {roleProfile: start.roleProfile} : {}),
    restartOf: startDigest(start), restartConversation: conversation,
    ...(force ? {forced: true, forcedTasks: pending} : {}),
  });
  return {role, session, conversation, command, harness, model, panePid: evidence.panePid ?? null, forced: force, pending,
    window: window.method ?? 'hidden'};
}

// 비서는 일반 찾기를 쓰지 않는다 — kadan up과 같은 체크포인트(secretary-resume.json) 경로로 같은 start 사건을 만든다.
function restartSecretary({home, role, session, floor, force, deps}) {
  // 확인·체크포인트·끄기는 잠금 안에서, 다시 열기는 resumeSecretary의 잠금 안에서 한다(둘 사이에 kadan up이 끼어들어도 한 번만 열린다).
  const {pending, previous} = withRecoveryLock(home, session, () => {
    const entries = deps.read();
    const start = ensureReady({role, session, floor, entries, deps});
    const open = guardRunning({role, entries, force, deps});
    const checkpoint = checkpointSecretary({home, floor, read: deps.read, ...(deps.findTranscript ? {findTranscript: deps.findTranscript} : {})});
    // 복원 정보를 못 만들면(codex가 아닌 비서·래퍼 명령 등) 지원하지 않는 역할을 끄지 않는다.
    if (!checkpoint) fail('이 비서는 기억 유지 restart를 지원하지 않는다 — 복원 정보(secretary-resume.json)를 만들 수 없다(codex 비서만 지원). 기존 세션은 그대로 둔다');
    stopForRestart({role, session, floor, entries, deps, forced: force ? open : null});
    return {pending: open, previous: startDigest(start)};
  });
  // 새 start에도 restartOf(·forced)를 남겨 감시 발령·우편·책임이 일반 역할과 같게 이어진다(kadan up 복원 경로는 그대로).
  const result = resumeSecretary({home, floor, read: deps.read, record: deps.record,
    startExtra: {restartOf: previous, ...(force ? {forced: true, forcedTasks: pending} : {})}, startNew: () => fail('비서 대화 정보가 없어 새로 만들지 않는다')});
  if (result !== 'restored') fail(`비서 복원 결과가 예상과 다르다: ${result}`);
  const latest = deps.read().findLast(e => e.kind === 'start' && e.session === session);
  return {role, session, conversation: latest?.secretaryConversation ?? null, command: latest?.cmd ?? null, harness: latest?.harness ?? null,
    model: latest?.model ?? null, panePid: latest?.panePid ?? null, forced: force, pending, window: latest?.window ?? 'hidden'};
}
