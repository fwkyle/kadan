// Why: 새 저장소에서 역할을 띄우면 Claude Code의 폴더 신뢰 화면에서 멈추고, 카단은 키를 안 보내고 KADAN_TRUST_PROMPT로 멈춘다
// (2026-10-23 Enter가 기본 선택 "No, exit"를 눌러 작업자 3명 소실 뒤 생긴 보호). 사용자 승인(안 B)으로, `kadan start`가 이번 호출에서
// 새로 만든 claude 세션에 한해 모든 조건이 맞을 때만 Yes를 골라 통과한다. 하나라도 어긋나면 키를 더 보내지 않고 지금처럼 멈춘다.
//
// 이 모듈은 start 안에서만 부른다. 공용 sendTmux(우편·알림·발령)에는 키 절차를 넣지 않는다.
// 판정은 floor-tmux.mjs의 hasTrustPrompt를 그대로 쓰고, 여기서는 그 창의 경로와 선택 표시만 읽는다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONTROL_SEQUENCES, hasTrustPrompt } from "./floor-tmux.mjs";

export const AUTO_TRUST_OFF = "auto-trust.off";
const MAX_DOWN_KEYS = 2; // 화살표가 순환할 수 있어 최대 두 번까지만 옮긴다
const squash = text => text.replace(/\s+/gu, "");
const ENTER_TO_CONFIRM = "Entertoconfirm", YES = "Yes,Itrustthisfolder", NO = "No,exit";
const QUESTION = "Isthisaprojectyoucreatedoroneyoutrust", WORKSPACE = "Accessingworkspace:";
const SELECT_MARK = /^\s*❯/u;

// 신뢰 창의 마지막 묶음에서 경로와 선택 상태를 읽는다. hasTrustPrompt가 참인 화면에만 부른다.
// selected: 'yes' | 'no' | null(선택 표시가 정확히 하나가 아니거나 두 선택지 줄이 아닌 곳에 있음). path: 문자열 | null.
export function readTrustSelection(screen) {
  const rows = String(screen).replace(CONTROL_SEQUENCES, "").split("\n").filter(line => squash(line));
  const confirm = rows.findLastIndex(line => squash(line).includes(ENTER_TO_CONFIRM));
  if (confirm < 0) return { path: null, pathAmbiguous: false, selected: null };
  let from = 0;
  for (let i = confirm - 1; i >= 0; i--) {
    const flat = squash(rows[i]);
    if (flat === "❯" || flat === ">" || flat.includes(ENTER_TO_CONFIRM)) { from = i + 1; break; }
  }
  const yes = rows.findLastIndex((line, i) => i >= from && i < confirm && squash(line).replace(/^❯/u, "").startsWith(YES));
  const no = yes < 0 ? -1 : rows.findLastIndex((line, i) => i >= from && i < yes && squash(line).replace(/^❯/u, "").startsWith(NO));
  const question = no < 0 ? -1 : rows.findLastIndex((line, i) => i >= from && i < no && squash(line).includes(QUESTION));
  if (question < 0) return { path: null, pathAmbiguous: false, selected: null };
  const marked = rows.map((line, i) => (i > question && i < confirm && SELECT_MARK.test(line) ? i : -1)).filter(i => i >= 0);
  const selected = marked.length === 1 ? (marked[0] === yes ? "yes" : marked[0] === no ? "no" : null) : null;
  const workspace = rows.findLastIndex((line, i) => i >= from && i < question && squash(line) === WORKSPACE);
  // `Accessing workspace:`와 질문 사이의 비지 않은 줄이 정확히 한 줄일 때만 그 줄이 경로다. 두 줄 이상이면 모호한 것이라
  // 줄을 이어 붙여 맞추지 않는다(이어 붙이기는 정확 일치를 흐린다). 앞뒤 공백만 걷고, 일부만 보이면 실경로 비교에서 다르다고 나온다.
  const between = workspace < 0 ? 0 : question - workspace - 1;
  return { path: between === 1 ? rows[workspace + 1].trim() : null, pathAmbiguous: between > 1, selected };
}

// 화면의 경로와 start의 작업 폴더가 실제 경로(realpath)로 정확히 같을 때만 true. `~` 축약은 이 계정의 홈으로만 푼다.
export function sameWorkspace(screenPath, workdir, { realpath = fs.realpathSync, home = os.homedir() } = {}) {
  if (typeof screenPath !== "string" || !screenPath || typeof workdir !== "string" || !workdir) return false;
  let shown = screenPath;
  if (shown === "~" || shown.startsWith("~/")) shown = path.join(home, shown.slice(1));
  if (!path.isAbsolute(shown)) return false;
  try { return realpath(shown) === realpath(workdir); } catch { return false; }
}

const sleepMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// 반환: 신뢰 창을 못 봤으면 null(원장에 아무것도 남기지 않는다). 봤으면 { result: accepted|skipped|failed, reason, keys, path? }.
// keys는 실제로 보낸 키 목록이다. deps: read(화면 문자열, 실패하면 던짐) · key(키 이름) · paneLive()(같은 세션·같은 pane PID·pane_dead=0이면 true, 조회 실패·종료면 false) — 모두 이번 세션 하나에 묶여 있다.
export function autoAcceptTrust({ workdir, home, read, key, paneLive, sleep = sleepMs,
  tries = 10, intervalMs = 500, enterTries = 8, realpath, homeDir } = {}) {
  // 1. 창이 뜰 때까지 기다린다. 신뢰 창이 보이면 바로, 신뢰 창이 아닌 화면이 두 번 연속 같으면 신뢰 창이 없는 것으로 보고 끝낸다.
  let screen = null, last = null;
  for (let i = 0; i < tries; i++) {
    let text = null;
    try { text = read(); } catch { return null; }
    if (typeof text === "string" && hasTrustPrompt(text)) { screen = text; break; }
    if (typeof text === "string" && text.trim() && text === last) return null;
    last = text;
    sleep(intervalMs);
  }
  if (screen === null) return null;

  const keys = [];
  let shownPath = null;
  const outcome = (result, reason) => ({ result, reason, keys, ...(shownPath ? { path: shownPath } : {}) });
  const parsed = readTrustSelection(screen);
  shownPath = parsed.path;

  if (fs.existsSync(path.join(home, AUTO_TRUST_OFF))) return outcome("skipped", "switch-off");
  if (parsed.pathAmbiguous) return outcome("skipped", "path-ambiguous");
  if (!parsed.path) return outcome("skipped", "path-unreadable");
  if (!sameWorkspace(parsed.path, workdir, { ...(realpath ? { realpath } : {}), ...(homeDir ? { home: homeDir } : {}) })) {
    return outcome("skipped", "path-mismatch");
  }
  if (!parsed.selected) return outcome("skipped", "selection-unknown");

  const send = name => {
    try { key(name); keys.push(name); return null; }
    catch (error) {
      const human = error?.code === "KADAN_HUMAN_ACTIVE" || error?.code === "KADAN_HUMAN_ACTIVITY_UNKNOWN";
      return outcome(keys.length === 0 && human ? "skipped" : "failed", human ? "human-active" : "key-refused");
    }
  };
  // 다시 읽어 신뢰 창이 맨 끝에 그대로 있고, 같은 경로이고, 선택 표시가 정확히 하나일 때만 그 선택을 돌려준다.
  const reread = () => {
    let text;
    try { text = read(); } catch { return null; }
    if (typeof text !== "string" || !hasTrustPrompt(text)) return null;
    const next = readTrustSelection(text);
    return next.path === parsed.path && next.selected ? next.selected : null;
  };

  // 2. Yes가 아니면 아래 화살표를 보내고 다시 읽는다. 숫자 키는 선택과 확정을 한 번에 할 수 있어 쓰지 않는다.
  let selected = parsed.selected, downs = 0;
  while (selected !== "yes") {
    if (downs >= MAX_DOWN_KEYS) return outcome("failed", "select-failed");
    const refused = send("Down");
    if (refused) return refused;
    downs += 1;
    sleep(200);
    selected = reread();
    if (selected === null) return outcome("failed", "screen-changed");
  }

  // 3. Yes가 처음부터 선택돼 있었든 Down으로 옮겼든, Enter 직전에 화면을 한 번 더 읽어 같은 경로·맨 끝 신뢰 창·단일 Yes를 확인한다.
  if (reread() !== "yes") return outcome("failed", "screen-changed");
  const refused = send("Enter");
  if (refused) return refused;
  for (let i = 0; i < enterTries; i++) {
    sleep(300);
    let text;
    try { text = read(); } catch { return outcome("failed", "screen-unreadable"); }
    // 마지막 화면을 읽은 뒤에도 같은 세션·같은 PID·살아 있는 pane인지 본다(remain-on-exit로 죽은 pane이 같은 PID로 남을 수 있다).
    let live = false;
    try { live = paneLive() === true; } catch { live = false; }
    if (!live) return outcome("failed", "pane-dead");
    if (typeof text === "string" && text.trim() && !hasTrustPrompt(text)) return outcome("accepted", downs > 0 ? "down-enter" : "enter");
  }
  return outcome("failed", "prompt-remains");
}
