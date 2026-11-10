// Why: 끝난 작업자·검수자 세션을 꺼도, 필요하면 같은 대화로 다시 열 수 있어야 안심하고 끈다.
// `kadan stop`(·restart·handover)이 stop 사건에 남긴 대화 번호와 그 세대의 start 기록(실행기·모델·작업 폴더·프로필)으로
// 같은 대화 resume 명령을 다시 만들어 연다. 사람이나 감독이 명령으로만 연다 — 자동으로 깨우지 않는다.
//
// restart와 같은 원칙: 거절할 수 있는 확인은 모두 세션을 만들기 *전에* 끝낸다. 명령 재조립도 restart의 것을 쓴다.
// 새 대화가 아니므로 시작 안내 우편·비교 모드 예약·프로필·모델 변경은 없다(start 경로를 지나지 않는다).
// start 사건이 같은 대화 resume으로 읽혀 우편·책임 세대가 이어진다(mail-generation.mjs, docs/hierarchy.md).
// 비용: 원장 읽기 1번, 설정 읽기 1번. 한 번 돌고 끝나는 명령이다.
import fs from 'node:fs';
import {startDigest, withRecoveryLock} from './secretary-resume.mjs';
import {launchIdentityOf} from './ai-identity.mjs';
import {conversationOf} from './conversation-ref.mjs';
import {runnerTemplate, rebuildResumeCommand, conversationStored} from './runner-table.mjs';
import {withInlineScreen} from './inline-screen.mjs';
import {withStopHook} from './stop-hook-settings.mjs';
import {buildStartLedgerEntry, workdirInsideHome, workdirInsideHomeMessage} from './cli-start-support.mjs';
import {sessionOwner} from './session-ownership.mjs';
import {launchStart} from './role-conversation.mjs';
import {TARGETS} from './revive.mjs';

const fail = message => { throw new Error(message); };

// 원장에 번호가 없을 때(옛 기록·못 찾음) 사람이 직접 찾는 길. 실행기마다 고르기 화면이 다르므로 흔한 둘만 예로 든다.
function pickerGuide(start, role) {
  const where = start?.cwd ? `cd ${start.cwd} 뒤 ` : '';
  const profile = start?.roleProfile ? ` --profile ${start.roleProfile}` : '';
  return `${where}실행기의 이어 열기 고르기 화면(claude --resume, codex resume)에서 대화를 찾은 다음 ` +
    `kadan start ${role} --cmd '<같은 실행 명령 + 그 대화 번호>'${profile} --no-prompt 로 연다`;
}

// 다시 열 재료: 마지막 stop과 그 세대를 띄운 start. 열 수 없으면 이유를 던진다. 우편 안내(reopenHint)도 같은 판정을 쓴다.
export function reopenSource(entries, session, role) {
  const events = entries.filter(e => e.session === session);
  const lastStart = events.findLastIndex(e => e.kind === 'start');
  if (lastStart < 0) fail(`${session}의 시작 기록이 없다`);
  const stopAt = events.findLastIndex(e => e.kind === 'stop');
  if (stopAt < lastStart) {
    fail(`${session}의 마지막 기록이 stop이 아니다(카단이 끈 기록 없이 사라진 세션) — 원장에 대화 번호가 없다. ${pickerGuide(events[lastStart], role)}`);
  }
  const stop = events[stopAt];
  const start = launchStart(events.slice(0, stopAt));
  if (stop.handoverId) {
    fail(`${session}은 인계로 종료된 역할이다 — 맡은 일은 후임이 이어받았으므로 다시 열지 않는다` +
      (stop.conversation ? `(대화 번호 ${stop.conversation}는 stop 기록에 있다)` : ''));
  }
  if (!stop.conversation) {
    const why = stop.conversationSkipped ? '기반 프로세스' : stop.conversationMissing ? `끌 때 못 찾음: ${stop.conversationMissing}` : '이 기능 이전의 기록';
    fail(`${session}의 stop 기록에 대화 번호가 없다(${why}). ${pickerGuide(start ?? events[lastStart], role)}`);
  }
  if (!start) fail(`${session}을 실제로 띄운 시작 기록(실행 명령)을 찾지 못했다`);
  if (stop.conversationStart !== startDigest(start)) fail(`${session}의 stop 기록에 적힌 대화가 마지막 시작 세대의 것이 아니다 — 다른 세대의 번호로 열지 않는다`);
  return {stop, start, conversation: stop.conversation};
}

// 우편 안내용: 지금 꺼져 있고 다시 열 번호가 있는 역할이면 true. 원장을 새로 읽지 않는다.
export function canReopen(entries, session, role) {
  if (TARGETS.includes(role)) return false;
  try { reopenSource(entries, session, role); return true; } catch { return false; }
}

// deps: read() 원장, record(사건), windowPolicy({roleProfile}) 창 사전 점검(거절이면 던짐, 돌려준 값은 start 사건에 더한다),
// openWindow({session, role, cwd, panePid}), register({role, cmd, roleProfile}) 관계표 등록, modelChoices(settings, 실행기) 모델 목록,
// exists(패턴)·homeDir 대화 파일 확인(시험 주입).
export function reopenRole({home, role, session, floor, settings, deps, hidden = false}) {
  if (floor.name !== 'tmux') fail('reopen은 tmux 바닥에서만 쓴다');
  if (TARGETS.includes(role)) fail(`${role}는 기반 프로세스다 — reopen 대상이 아니다. kadan up으로 띄운다`);
  return withRecoveryLock(home, session, () => {
    const entries = deps.read();
    // 다른 역할의 주소를 정규화 충돌로 여는 일을 막는다(start와 같은 검사).
    sessionOwner(entries, session, role);
    if (floor.alive(session)) fail(`이미 살아 있다: ${session} — 살아 있는 역할은 kadan attach로 열고, 프로그램만 다시 띄우려면 kadan restart를 쓴다`);
    const {stop, start, conversation} = reopenSource(entries, session, role);
    if (start.floor && start.floor !== 'tmux') fail('tmux 역할 시작 기록이 아니다');

    const identity = launchIdentityOf(start.cmd);
    if (!identity.ok) fail(`마지막 시작 명령에서 등록 실행기·모델을 읽지 못했다(${identity.reason})`);
    const {harness, model} = identity;
    if (!settings) fail('실행 모델 설정이 없다 — kadan runners init 먼저');
    if (!settings.runners?.[harness]) fail(`이 실행기(${harness})는 runner-settings.json에 등록되지 않았다`);
    runnerTemplate(settings, harness, 'resume');
    let models;
    try { models = deps.modelChoices(settings, harness); }
    catch (error) { fail(`${harness}의 모델 목록을 읽지 못해 다시 열지 않는다: ${error.message}`); }
    if (!models.has(model)) fail(`이 모델(${model})은 지금 설정의 ${harness} 모델 목록에 없다 — 같은 모델로 다시 열 수 없다`);

    let isDirectory = false;
    try { isDirectory = fs.statSync(start.cwd).isDirectory(); } catch { /* 없으면 아래에서 거절 */ }
    if (!isDirectory) fail(`역할 작업 폴더가 없다: ${start.cwd} — 머지 뒤 지운 worktree일 수 있다. 같은 폴더가 있어야 같은 대화를 이어 연다`);
    const insideHome = workdirInsideHome(start.cwd, home);
    if (insideHome) fail(workdirInsideHomeMessage(insideHome));

    // 대화 파일이 남아 있는지: 표의 stored 칸이 있는 실행기만 확인할 수 있다. 없으면 확인 못 함(null)으로 알린다.
    const stored = conversationStored(settings.runners[harness].conversation, conversation,
      {...(deps.homeDir ? {homeDir: deps.homeDir} : {}), ...(deps.exists ? {exists: deps.exists} : {})});
    if (stored === false) fail(`대화 ${conversation}의 저장 파일이 없다 — 실행기의 보존 기간이 지났을 수 있다. 다시 열 수 없다`);

    // 마지막 시작 명령에서 대화 인자만 바꾼다. 실행기·모델이 그대로이고 같은 대화(resume)로 읽혀야 한다.
    const command = withStopHook(withInlineScreen(rebuildResumeCommand(settings, harness, start.cmd, conversation)));
    const again = launchIdentityOf(command), mode = conversationOf(command);
    if (!again.ok || again.harness !== harness || again.model !== model) fail('다시 만든 명령의 실행기·모델이 원본과 다르다');
    if (mode.conversationMode !== 'resume' || mode.conversationRef !== conversation) fail('다시 만든 명령이 같은 대화 resume으로 읽히지 않는다');

    // 창 설정(KADAN_WINDOW·로티 숨김 금지)은 kadan start와 같은 규칙이다. 거절이면 여기서 던진다.
    const windowFields = deps.windowPolicy({roleProfile: start.roleProfile ?? null, hidden}) ?? {};
    // 여기까지 거절 사유가 없다. 확인하는 사이 누가 같은 이름을 띄웠는지만 한 번 더 본다.
    if (floor.alive(session)) fail(`이미 살아 있다: ${session}`);
    let evidence;
    try { evidence = floor.create({session, role, cwd: start.cwd, cmd: command}); }
    catch (error) { fail(`새 세션을 만들지 못했다: ${error.message}`); }
    const window = hidden ? {method: 'hidden'}
      : deps.openWindow({session, role, cwd: start.cwd, panePid: evidence.panePid ?? evidence.rottiePid}) ?? {};
    try {
      deps.record({
        ...buildStartLedgerEntry({floorName: floor.name, role, session, evidence, window: window.method ?? 'hidden',
          rottieTerminalId: window.rottieTerminalId, orcaTerminalHandle: window.orcaTerminalHandle, reused: window.reused,
          cmd: command, cwd: start.cwd}),
        ...(window.rottieBundleId ? {rottieBundleId: window.rottieBundleId, rottieConnect: window.rottieConnect, rottieConnectError: window.rottieConnectError} : {}),
        ...(start.roleProfile ? {roleProfile: start.roleProfile} : {}),
        ...windowFields,
        // 무엇으로 열었는지: reopen, 어느 세대(start 지문)·어느 stop(시각)의 번호인지.
        reopenOf: startDigest(start), reopenStopAt: stop.t ?? null, reopenConversation: conversation,
      });
    } catch (error) {
      // 시작 기록이 없는 세션은 다음 start에서 재사용으로 읽혀 막히고 감시에도 잡히지 않는다(start와 같은 처리). 방금 만든 것만 닫는다.
      let closed = true;
      try { floor.stop(session); } catch { closed = false; }
      fail(`시작 기록 실패 — ${closed ? `방금 만든 ${session}을 닫았다` : `방금 만든 ${session}을 닫지 못했다(직접 확인)`}: ${error.message}`);
    }
    let registration = null;
    try { registration = deps.register({role, cmd: command, roleProfile: start.roleProfile ?? null}); } catch { /* 등록 실패는 다시 열기를 막지 않는다 */ }
    return {role, session, conversation, command, harness, model, cwd: start.cwd, roleProfile: start.roleProfile ?? null,
      panePid: evidence.panePid ?? null, window: window.method ?? 'hidden', storedChecked: stored !== null, registration};
  });
}
