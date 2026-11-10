// Why: 끝난 작업자·검수자 세션을 꺼도, 필요하면 같은 대화로 다시 열 수 있어야 안심하고 끈다.
// `kadan stop`(·restart·handover)이 stop 사건에 남긴 대화 번호와 그 세대의 start 기록(실행기·모델·작업 폴더·프로필)으로
// 같은 대화 resume 명령을 다시 만들어 연다. 사람이나 감독이 명령으로만 연다 — 자동으로 깨우지 않는다.
//
// restart와 같은 원칙: 거절할 수 있는 확인은 모두 세션을 만들기 *전에* 끝낸다. 명령 재조립도 restart의 것을 쓴다.
// 새 대화가 아니므로 시작 안내 우편·비교 모드 예약·프로필·모델 변경은 없다(start 경로를 지나지 않는다).
// start 사건이 같은 대화 resume으로 읽혀 우편·책임 세대가 이어진다(mail-generation.mjs, docs/hierarchy.md).
// 감시 발령도 이어진다: start의 reopenOf가 그 세션의 마지막 start 사건의 지문과 같고 지금 세대가 꺼져 있으면 감시기가
// 그 세대의 발령을 잇는다(watch-roles.mjs·watch-role-state.mjs). 그래서 reopenOf에는 stop 직전의 마지막 start 사건을 적는다
// (보통 그 세대를 띄운 start이고, 살아 있는 세션을 다시 연 start가 있었으면 그 start다). 세대를 띄운 start의 지문은 stop의
// conversationStart에 있다. restartOf는 붙이지 않는다 — 로티 탭 계보와 재시작 집계에 섞지 않는다.
// 비용: 원장 읽기 2번(처음 고를 때·세션을 만들기 직전 다시 확인), 설정 읽기 1번. 한 번 돌고 끝나는 명령이다.
// 원장이 10배면 이 두 번의 읽기가 각각 10배가 된다. 일반 start·stop은 이 명령의 잠금을 쓰지 않으므로, 잠금이 아니라
// 다시 읽기로 "확인하는 사이 다른 세대가 떴다 꺼진" 경우를 막는다.
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
import {generationDistinct} from './watch-role-state.mjs';
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
  // lastStart: stop 직전의 마지막 start 사건(start와 같거나, 같은 pane을 다시 연 start). 감시기가 대조하는 사건이다.
  return {stop, start, lastStart: events[lastStart], conversation: stop.conversation};
}

// 우편 안내용: 지금 꺼져 있고 다시 열 번호가 있는 역할이면 true. 원장을 새로 읽지 않는다.
export function canReopen(entries, session, role) {
  if (TARGETS.includes(role)) return false;
  try { reopenSource(entries, session, role); return true; } catch { return false; }
}

// 처음 고른 세대(start·stop)가 지금도 그 역할의 마지막 세대인가. 다시 읽은 원장에서 같은 판정을 돌려 지문으로 대조한다.
function sameSource(latest, session, role, {start, stop}) {
  let again;
  try { again = reopenSource(latest, session, role); } catch { return false; }
  return startDigest(again.start) === startDigest(start) && startDigest(again.stop) === startDigest(stop);
}

// deps: read() 원장, record(사건), windowPolicy({roleProfile}) 창 사전 점검(거절이면 던짐, 돌려준 값은 start 사건에 더한다),
// pendingCards(원장, 역할) 끝나지 않은 카드 목록(안내용),
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
    const {stop, start, lastStart, conversation} = reopenSource(entries, session, role);
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
    // 여기까지의 확인(설정·대화 파일·창 점검)은 시간이 걸린다. 그사이 일반 start·stop으로 새 세대가 떴다 꺼졌으면
    // 처음 고른 번호는 옛 세대의 것이다. 원장을 다시 읽어 같은 start·같은 stop이 여전히 마지막인지 확인한다.
    // 원장 읽기는 느릴 수 있어 생존 확인 *앞*에 두고, 생존 확인과 세션 만들기 사이에는 아무 단계도 두지 않는다.
    const latest = deps.read();
    if (!sameSource(latest, session, role, {start, stop}))
      fail(`확인하는 사이 ${session}의 역할 세대가 바뀌었다 — 다른 세대의 대화로 열지 않는다. 지금 상태를 확인하고 다시 시도하라`);
    let pending = [];
    try { pending = deps.pendingCards?.(latest, role) ?? []; } catch { /* 안내용이다. 못 세어도 다시 열기를 막지 않는다 */ }
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
        ...(start.difficulty ? {difficulty: start.difficulty} : {}),
        ...windowFields,
        // 무엇으로 열었는지: reopen, 어느 세대(그 세대의 마지막 start 사건 지문)·어느 stop(시각)의 번호인지.
        reopenOf: startDigest(lastStart), reopenStopAt: stop.t ?? null, reopenConversation: conversation,
      });
    } catch (error) {
      // 시작 기록이 없는 세션은 다음 start에서 재사용으로 읽혀 막히고 감시에도 잡히지 않는다. 그래서 방금 만든 것을 닫는다.
      // 다만 이름만 보고 끄지 않는다(카단은 자기가 만든 것만 끈다): 창을 여는 사이 방금 만든 프로세스가 사라지고 같은 이름에
      // 다른 세션이 떴을 수 있다. 끄기 직전의 실제 pane PID가 이번에 만든 것과 같을 때만 끄고, 다르거나 확인할 수 없으면 두고 알린다.
      const createdPid = evidence.panePid ?? evidence.rottiePid;
      let currentPid, known = true;
      try { currentPid = floor.pid(session); } catch { known = false; }
      let outcome;
      if (!known) outcome = `방금 만든 ${session}인지 확인하지 못해 닫지 않았다(직접 확인: kadan read ${role})`;
      else if (createdPid == null || currentPid == null || String(currentPid) !== String(createdPid)) {
        outcome = `${session}은 이번 호출이 만든 프로세스(pane PID ${createdPid ?? '?'})가 아니라서(지금 ${currentPid ?? '없음'}) 닫지 않았다(직접 확인)`;
      } else {
        try { floor.stop(session); outcome = `방금 만든 ${session}을 닫았다`; }
        catch { outcome = `방금 만든 ${session}을 닫지 못했다(직접 확인)`; }
      }
      fail(`시작 기록 실패 — ${outcome}: ${error.message}`);
    }
    let registration = null;
    try { registration = deps.register({role, cmd: command, roleProfile: start.roleProfile ?? null}); } catch { /* 등록 실패는 다시 열기를 막지 않는다 */ }
    return {role, session, conversation, command, harness, model, cwd: start.cwd, roleProfile: start.roleProfile ?? null,
      panePid: evidence.panePid ?? null, window: window.method ?? 'hidden', storedChecked: stored !== null, registration, pending,
      // 감시기가 이 start로 발령을 이을 수 있는가(감시기와 같은 함수). 아니면 명령이 "감시가 이어진다"고 말하지 않는다.
      watchContinues: generationDistinct(lastStart)};
  });
}
