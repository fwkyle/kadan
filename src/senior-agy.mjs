// 시니어 agy(gemini) 대화창 갈래(설계 2026-11-18 v2.1). agy는 대화창으로만 부른다 — 헤드리스(`--print`) 호출은 이 길 어디에도 없다.
// codex 갈래(src/senior-session.mjs)와 같은 것: 전용 소켓·세션 기록·예약 종료·자기 것만 끄기·자리 상한·키 두 단계·제출 뒤 로티 탭.
// 다른 것:
//  - 작업 폴더는 홈마다 고정 하나(`$KADAN_HOME/senior-agy`)다. 호출마다 새 폴더를 쓰면 호출마다 신뢰 창이 뜨고 사용자 agy 신뢰 목록이
//    호출 수만큼 늘어난다. 고정 폴더면 처음 한 번만 늘어난다.
//  - 도구 없는 에이전트(`--agent kadan-noexec`, 파일은 고정 폴더에)로 띄우고 저장소는 `--add-dir`로 읽기만 한다.
//  - 답 파일을 쓸 수 없어, 답은 화면에 쓰게 하고 tmux 스크롤 기록에서 회수한다(src/senior-agy-screen.mjs).
//  - 첫 화면이 그 고정 폴더의 신뢰 창이면 Enter 한 번으로 지난다. 다른 경로·다른 선택·다른 창이면 키 0회로 실패한다.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {NOEXEC_AGENT, ensureAgentFile, ensureRealDir, isReadDirValue} from './exec-agent.mjs';
import {checkHumanIdle, checkPaneMode} from './floor-tmux.mjs';
import {splitGhostText} from './ghost-text.mjs';
import {AUTO_TRUST_OFF, sameWorkspace} from './trust-accept.mjs';
import {agyComposerHolds, agyComposerReady, agyScreenWorking, findAgyBoundary, readAgyAnswer,
  readAgyTrust} from './senior-agy-screen.mjs';
import {SESSION_TIMING, outsideGit, paneAlive, sendLine, signalOf} from './senior-session.mjs';

export const AGY_WORKDIR = 'senior-agy';
// 전체 스크롤 기록을 뜰 때의 출력 상한. 넘으면 잘린 캡처이므로 답으로 읽지 않는다(spawnSync 기본값 1MiB는 5만 줄에 모자란다).
export const AGY_CAPTURE_MAX_BYTES = 32 * 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), {code});
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 실행 꼴은 코드에 고정한다(실행기 표의 틀을 쓰지 않는다). `--print`·`-p`·`--effort`는 넣지 않는다:
// 강도는 모델 이름이 정한다(조사: `gemini-4-argon-medium` + `--effort low`는 경고만 내고 medium으로 돌았다).
export function agyArgv({model, readDir = null}) {
  if (!/^[A-Za-z0-9._\/\-\[\]]+$/u.test(String(model))) throw new Error(`시니어 모델 형식 오류: ${model}`);
  if (readDir != null && !isReadDirValue(readDir)) throw new Error(`시니어 읽기 폴더 형식 오류: ${readDir}`);
  return ['agy', '--model', model, '--agent', NOEXEC_AGENT, ...(readDir ? ['--add-dir', readDir] : [])];
}

// 화면에 넣는 한 줄. `/`로 시작하면 agy가 명령 완성 목록을 띄우므로(조사: `/permissions`) 글로 시작한다.
export const agyAskLine = askFile => `다음 파일을 끝까지 읽고 거기 적힌 대로 수행하라: ${askFile}`;

// 고정 작업 폴더 준비(자리 준비 잠금 안에서 부른다). 순서: git 밖 확인 → 에이전트 파일 → (그 뒤에 세션).
// git 저장소 안이면 폴더도 파일도 만들지 않고 던진다(아무도 부르지 않는다). 반환: 고정 폴더의 실제 경로.
export function prepareAgyWorkdir(home, {spawn = spawnSync} = {}) {
  const dir = path.join(home, AGY_WORKDIR);
  const refuse = why => fail('KADAN_SENIOR_AGY_WORKDIR', `agy 시니어 작업 폴더를 쓸 수 없다(${why}): ${dir} — 아무도 부르지 않는다`);
  const exists = fs.lstatSync(dir, {throwIfNoEntry: false}) != null;
  // 아직 없으면 홈에서 먼저 본다: git 안이면 빈 폴더조차 만들지 않는다.
  const before = outsideGit(exists ? dir : home, {spawn});
  if (!before.ok) throw refuse(before.why);
  try { ensureRealDir(dir); ensureRealDir(path.join(dir, 'asks')); }
  catch (error) { throw refuse(error.message); }
  const real = fs.realpathSync(dir);
  const after = exists ? before : outsideGit(real, {spawn});
  if (!after.ok) throw refuse(after.why);
  ensureAgentFile(real);
  return real;
}

// 자리별 질문 파일(`asks/<askId>-<자리 번호>.txt`). 모델이 읽어야 하므로 고정 폴더 안에 둔다. 이미 있으면 쓰지 않고 던진다.
export function writeAgyAsk(workdir, askId, index, prompt) {
  const file = path.join(workdir, 'asks', `${askId}-${index + 1}.txt`);
  fs.writeFileSync(file, prompt, {mode: 0o600, flag: 'wx'});
  return file;
}

// 카단이 만든 그 질문 파일만 지운다: 기록의 경로가 고정 폴더의 asks/ 바로 아래이고 이름이 이번 호출·이번 자리의 것이며 일반 파일일 때만.
export function removeAgyAsk(record) {
  const {askFile, workdir, askId} = record ?? {};
  if (typeof askFile !== 'string' || typeof workdir !== 'string') return false;
  if (path.dirname(askFile) !== path.join(workdir, 'asks') || !path.basename(askFile).startsWith(`${askId}-`)) return false;
  try {
    if (!fs.lstatSync(askFile).isFile()) return false;
    fs.unlinkSync(askFile);
    return true;
  } catch { return false; }
}

// 판정용 화면(지금 보이는 화면만): 색 포함(-e)으로 떠서 입력칸의 흐린 글을 빼고 감긴 줄을 잇는다(-J).
export function captureAgy(run, session) {
  return splitGhostText(run(['capture-pane', '-e', '-p', '-J', '-t', `=${session}:`])).judge;
}
const plainScreen = (run, session) => String(run(['capture-pane', '-p', '-J', '-t', `=${session}:`]));

// 전체 스크롤 기록. 실패·출력 상한 초과·신호는 던진다(잘린 캡처를 답으로 읽지 않는다).
export function captureAgyHistory(run, session, {maxBuffer = AGY_CAPTURE_MAX_BYTES} = {}) {
  const result = run.try(['capture-pane', '-p', '-J', '-S', '-', '-E', '-', '-t', `=${session}:`], undefined, {maxBuffer});
  if (result.error || result.status !== 0) {
    const why = result.error?.code === 'ENOBUFS' ? 'capture-too-big' : 'capture-failed';
    throw Object.assign(fail('KADAN_SENIOR_CAPTURE', `시니어 세션의 스크롤 기록을 읽지 못했다(${why})`),
      {why, signal: result.signal ?? null});
  }
  return String(result.stdout);
}

function historyState(run, session) {
  const result = run.try(['display-message', '-p', '-t', `=${session}:`, '#{history_size}|#{history_limit}']);
  const [size, limit] = String(result.stdout ?? '').trim().split('|').map(Number);
  return result.status === 0 && Number.isFinite(size) && Number.isFinite(limit) ? {size, limit} : null;
}

export const AGY_JUDGE = {ready: agyComposerReady, holds: agyComposerHolds, capture: captureAgy};
// 신뢰 창 Enter 직전의 복사 모드·사람 입력 확인이 막았을 때의 이유 낱말(바닥 확인 함수의 오류 코드 → 관문 이유).
const TRUST_HOLD = {KADAN_PANE_IN_MODE: 'trust-pane-in-mode', KADAN_PANE_MODE_UNKNOWN: 'trust-pane-mode-unknown',
  KADAN_HUMAN_ACTIVE: 'trust-human-active', KADAN_HUMAN_ACTIVITY_UNKNOWN: 'trust-human-unknown'};

// 질문 넣기 전 관문. 고정 폴더가 git 밖인지는 자리 준비에서 이미 봤다. 여기서는 문을 열고(agy가 뜬다) 빈 입력칸까지 기다린다.
// 첫 화면이 이 세션 작업 폴더의 신뢰 창이면 조건을 모두 확인한 뒤 Enter를 한 번 보낸다(이 길에서 질문 밖에 나가는 유일한 키).
// 반환: {ok, why?, note?, timeout?, trust?}. 던지지 않는다.
export async function passGateAgy(seat, {run, now = Date.now, sleep = defaultSleep, timing = SESSION_TIMING}) {
  const evidence = {};
  const done = verdict => {
    const text = JSON.stringify({...verdict, ...evidence}, null, 1) + '\n';
    try { fs.writeFileSync(path.join(seat.dir, 'gate.json'), text, {mode: 0o600}); }
    catch { /* 근거 기록 실패가 판정을 바꾸지 않는다 */ }
    return verdict;
  };
  const expired = () => now() >= seat.deadlineAt;
  const late = during => ({ok: false, why: 'deadline', timeout: true, note: `시간 상한이 끝났다(${during})`});
  let trust = null;
  // 신뢰 창 한 번 판정: 통과 조건이 모두 맞으면 {ok: true}, 아니면 끝내는 이유.
  const trustVerdict = shown => {
    if (fs.existsSync(path.join(seat.home, AUTO_TRUST_OFF))) return {ok: false, why: 'trust-switch-off'};
    if (!shown.path) return {ok: false, why: 'trust-path-unreadable'};
    if (!sameWorkspace(shown.path, seat.workdir)) return {ok: false, why: 'trust-path-mismatch'};
    if (shown.selected !== 'yes') return {ok: false, why: 'trust-not-yes'};
    return {ok: true};
  };
  try {
    fs.writeFileSync(seat.gate, '', {mode: 0o600});
    const until = Math.min(now() + timing.startupMs, seat.deadlineAt);
    let why = 'no-composer', settled = false;
    for (;;) {
      const pane = paneAlive(run, seat);
      if (!pane.alive) return done({ok: false, why: `startup:${pane.signal ? 'interrupted' : 'pane-dead'}`});
      let screen, plain;
      try { screen = captureAgy(run, seat.session); plain = plainScreen(run, seat.session); }
      catch (error) { return done({ok: false, why: `startup:${signalOf(error) ? 'interrupted' : 'pane-dead'}`}); }
      evidence.screen = plain;
      const ready = agyComposerReady(screen);
      if (ready.ok) {
        // 빈 입력칸을 한 번 더 확인한다(그리는 중인 화면을 받지 않는다).
        if (settled) break;
        settled = true;
        await sleep(timing.settleMs);
        continue;
      }
      settled = false;
      why = ready.why;
      const shown = readAgyTrust(plain);
      if (shown.found && trust) why = 'trust-remains';
      else if (shown.found) {
        const verdict = trustVerdict(shown);
        if (!verdict.ok) return done({...verdict, why: `startup:${verdict.why}`, note: 'agy 폴더 신뢰 창을 지나지 못했다 — 키를 보내지 않았다'});
        // Enter 직전 재확인: 같은 pane·PID가 살아 있고, 화면을 다시 읽어 같은 경로·단일 Yes이며, 상한이 남아 있다.
        const again = readAgyTrust(plainScreen(run, seat.session));
        if (!again.found || again.path !== shown.path || !trustVerdict(again).ok) return done({ok: false, why: 'startup:trust-screen-changed'});
        if (!paneAlive(run, seat).alive) return done({ok: false, why: 'startup:pane-dead'});
        // 바닥의 키 전송(sendTmux)·Claude 신뢰 키(sendTmuxTrustKey)와 같은 확인을 같은 순서로 한다: pane PID·생존 → 기록보기(복사) 모드 →
        // 사람 입력. 기록보기 중이거나 붙은 사람이 최근에 키를 쳤으면 Enter를 보내지 않고 끝낸다(다시 시도하지 않는다).
        try { checkPaneMode(seat.session, run); checkHumanIdle(seat.session, run); }
        catch (error) {
          if (signalOf(error) || signalOf(error.cause)) return done({ok: false, why: 'startup:interrupted'});
          return done({ok: false, why: `startup:${TRUST_HOLD[error.code] ?? 'trust-check-failed'}`,
            note: `agy 폴더 신뢰 창에 키를 보내지 않았다 — ${error.message}`});
        }
        if (expired()) return done(late('startup:trust'));
        run(['send-keys', '-t', `=${seat.session}:`, 'Enter']);
        trust = evidence.trust = {result: 'accepted', path: shown.path, keys: ['Enter'], at: new Date(now()).toISOString()};
        why = 'trust-remains';
      }
      if (now() >= until) break;
      await sleep(Math.min(timing.pollMs, 500));
    }
    if (expired()) return done(late(settled ? 'before-ask' : `startup:${why}`));
    if (!settled) return done({ok: false, why: `startup:${why}`});
    return done({ok: true, ...(trust ? {trust} : {})});
  } catch (error) {
    return done({ok: false, why: signalOf(error) ? 'startup:interrupted' : 'gate-error', note: String(error?.message ?? error)});
  }
}

// 질문 한 줄을 넣고 끝을 기다린다. 반환: {reason: ok|empty|timeout|call-failed|interrupted, detail?, answer?}. 던지지 않는다.
// ok는 (1) 질문을 넣은 뒤 화면이 일하는 표시를 거쳐 (2) 다시 빈 입력칸으로 쉬고 (3) 전체 스크롤 기록에서 이번 질문의 시작 경계 뒤
// 답 구간이 답 후보일 때만이다. 생성 중에는 지금 화면만 읽고, 끝 판정 때만 전체 스크롤을 한 번 읽는다.
// 한도 화면의 모양은 관찰한 적이 없어 따로 판정하지 않는다 — 표지 없는 화면은 ok가 아니다(empty).
export async function askSeatAgy(seat, {run, now = Date.now, sleep = defaultSleep, timing = seat.timing ?? SESSION_TIMING,
  spawn = spawnSync, onSubmitted = () => {}, captureMaxBytes = seat.captureMaxBytes ?? AGY_CAPTURE_MAX_BYTES}) {
  if (now() >= seat.deadlineAt) return {reason: 'timeout', detail: 'deadline:before-ask'};
  const broken = error => signalOf(error) ? {reason: 'interrupted', detail: signalOf(error)}
    : {reason: 'call-failed', detail: error.why ?? 'pane-dead'};
  const history = () => captureAgyHistory(run, seat.session, {maxBuffer: captureMaxBytes});
  // 시작 경계 고정(앞쪽): 넣기 전에는 이 질문 줄이 스크롤 어디에도 없어야 한다. 그래야 뒤에 보이는 한 번이 이번 제출이다.
  try {
    const before = history().split('\n');
    if (findAgyBoundary(before, seat.line).length) return {reason: 'call-failed', detail: 'boundary-preexists'};
  } catch (error) { return broken(error); }
  try { sendLine(seat, seat.line, {run, keyGapS: timing.keyGapS, spawn, now, judge: AGY_JUDGE}); }
  catch (error) {
    if (error.why === 'deadline') return {reason: 'timeout', detail: `deadline:${error.stage}`};
    if (signalOf(error)) return {reason: 'interrupted', detail: signalOf(error)};
    return {reason: 'call-failed', detail: `key:${error.why ?? error.code ?? 'send-failed'} — ${error.message}`};
  }
  const submittedAt = now();
  // 시작 경계 고정(뒤쪽): 제출 직후의 스크롤 길이를 근거로 남긴다. 이 뒤로는 이 세션에 키를 보내지 않는다.
  const atSubmit = historyState(run, seat.session);
  try { fs.writeFileSync(path.join(seat.dir, 'boundary.json'), JSON.stringify({line: seat.line, submittedAt: new Date(submittedAt).toISOString(), history: atSubmit}, null, 1) + '\n', {mode: 0o600}); }
  catch { /* 근거 기록 실패가 판정을 바꾸지 않는다 */ }
  try { onSubmitted(); } catch { /* 알림은 꾸밈이다 */ }
  let sawWorking = false, idle = 0;
  for (;;) {
    const pane = paneAlive(run, seat);
    if (pane.signal) return {reason: 'interrupted', detail: pane.signal};
    if (!pane.alive) return {reason: 'call-failed', detail: 'pane-dead'};
    let screen;
    try { screen = captureAgy(run, seat.session); }
    catch (error) { return broken(error); }
    if (agyScreenWorking(screen)) { sawWorking = true; idle = 0; }
    else if (agyComposerReady(screen).ok) {
      idle += 1;
      if (idle >= timing.idleConfirm && sawWorking) {
        // 스크롤이 한도까지 찼으면 앞줄이 밀려났을 수 있다. 경계가 남아 있어도 받지 않는다.
        const state = historyState(run, seat.session);
        if (!state) return {reason: 'call-failed', detail: 'scrollback-unknown'};
        if (state.size >= state.limit) return {reason: 'call-failed', detail: 'scrollback-limit'};
        let capture;
        try { capture = history(); } catch (error) { return broken(error); }
        const read = readAgyAnswer(capture, {line: seat.line, marker: seat.marker});
        if (read.ok) return {reason: 'ok', answer: read.answer};
        return {reason: read.lost ? 'call-failed' : 'empty', detail: read.why};
      }
      if (idle >= timing.idleConfirm && now() - submittedAt > timing.submitGraceMs) return {reason: 'empty', detail: 'no-work-seen'};
    } else idle = 0;
    if (now() >= seat.deadlineAt) return {reason: 'timeout', detail: 'deadline'};
    await sleep(timing.pollMs);
  }
}
