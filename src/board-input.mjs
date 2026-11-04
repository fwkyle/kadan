// kadan board 터미널 칸의 입력 해석(순수 함수). 터미널이 주는 바이트를 tmux 키 이름·글자 묶음으로 옮기는 대응표를 한 곳에 둔다.
// 모르는 바이트·시퀀스는 보내지 않고 버린다(추측 금지). Ctrl-]만 board가 받아 목록으로 돌아온다.
import { HUMAN_KEYS_PASTE_MAX } from "./floor-tmux.mjs";

export const LEAVE_BYTE = "\x1d"; // Ctrl-]
const ESC = "\x1b", PASTE_START = `${ESC}[200~`, PASTE_END = `${ESC}[201~`;
const HOLD_MAX = 16; // 쪼개져 온 이스케이프 시퀀스를 다음 입력까지 쥐고 있는 상한
export const ESC_WAIT_MS = 50; // ESC로 시작하는 불완전한 순서를 이어질 조각을 기다리는 시간(넘으면 단독 Esc)
export const PASTE_IDLE_MS = 2000; // 붙여넣기 끝 표시 없이 이 시간 입력이 멎으면 버린다

const ARROWS = { A: "Up", B: "Down", C: "Right", D: "Left", H: "Home", F: "End" };
const TILDE = { 1: "Home", 2: "IC", 3: "DC", 4: "End", 5: "PPage", 6: "NPage", 7: "Home", 8: "End",
  11: "F1", 12: "F2", 13: "F3", 14: "F4", 15: "F5", 17: "F6", 18: "F7", 19: "F8", 20: "F9", 21: "F10", 23: "F11", 24: "F12" };
const SS3 = { ...ARROWS, P: "F1", Q: "F2", R: "F3", S: "F4" };
const MODIFIER = { 2: "S", 3: "M", 5: "C" };
const CSI = /^\x1b\[([0-9;?]*)([ -/]*)([@-~])/;
const CSI_PARTIAL = /^\x1b\[[0-9;?]*[ -/]*$/;

// 제어 문자 하나 → 키 이름 또는 null(버림). Ctrl-]는 호출 전에 가로챈다.
export function controlKey(code) {
  if (code === 0x0d) return "Enter";
  if (code === 0x09) return "Tab";
  if (code === 0x7f) return "BSpace";
  if (code === 0x00) return "C-Space";
  if (code >= 0x01 && code <= 0x1a) return `C-${String.fromCharCode(0x60 + code)}`;
  return null;
}

function csiKey(params, final) {
  if (params.includes("?")) return null; // 터미널 응답 찌꺼기
  const parts = params.split(";");
  const mod = parts.length > 1 ? MODIFIER[parts[1]] : undefined;
  if (parts.length > 1 && !mod) return null;
  let name = null;
  if (final === "Z" && parts.length === 1) return "BTab";
  if (final === "~") name = TILDE[parts[0]] ?? null;
  else if (ARROWS[final] && (parts.length === 1 || parts[0] === "1")) name = ARROWS[final];
  if (!name) return null;
  if (!mod) return name;
  return /^F\d/.test(name) ? null : `${mod}-${name}`;
}

// 상태 있는 해석기: 붙여넣기(ESC[200~ … ESC[201~)와 쪼개져 온 시퀀스가 입력 덩어리 경계를 넘을 수 있다.
// feed(chunk) → [{type:"text",text} | {type:"key",key} | {type:"paste",text,over} | {type:"leave"}]
// leave가 나오면 그 덩어리의 나머지 입력은 버린다(목록 키로 잘못 읽히지 않게).
export function createInputParser({ pasteMax = HUMAN_KEYS_PASTE_MAX } = {}) {
  let held = "";
  let paste = null; // 붙여넣기 중이면 모은 글자(상한을 넘기면 over)
  let over = false;
  let pasteBytes = 0; // 붙여넣기 UTF-8 바이트 수(상한은 글자 수가 아니라 바이트)
  const tokens = [];
  const pushText = (text) => {
    const last = tokens.at(-1);
    if (last?.type === "text") last.text += text; else tokens.push({ type: "text", text });
  };
  const pushKey = (key) => tokens.push({ type: "key", key });

  function feed(chunk) {
    tokens.length = 0;
    const s = held + String(chunk);
    held = "";
    let i = 0;
    while (i < s.length) {
      if (paste !== null) {
        const end = s.indexOf(PASTE_END, i);
        const stop = end === -1 ? s.length : end;
        let keep = stop;
        if (end === -1) { // 끝 표시가 쪼개져 올 수 있다
          for (let n = Math.min(PASTE_END.length - 1, stop - i); n > 0; n--) {
            if (PASTE_END.startsWith(s.slice(stop - n, stop))) { keep = stop - n; held = s.slice(keep); break; }
          }
        }
        const part = s.slice(i, keep);
        if (!over) {
          paste += part; pasteBytes += Buffer.byteLength(part);
          if (pasteBytes > pasteMax) { over = true; paste = ""; }
        }
        if (end === -1) break;
        tokens.push({ type: "paste", text: paste, over });
        paste = null; over = false; pasteBytes = 0;
        i = end + PASTE_END.length;
        continue;
      }
      const c = s[i];
      if (c === LEAVE_BYTE) { tokens.push({ type: "leave" }); return tokens.slice(); }
      if (c === ESC) {
        const rest = s.slice(i);
        if (rest.startsWith(PASTE_START)) { paste = ""; over = false; pasteBytes = 0; i += PASTE_START.length; continue; }
        if (rest.length === 1) { held = rest; break; } // 다음 조각이 이어질 수 있다: expire()가 시간 뒤 단독 Esc로 낸다
        if (rest[1] === "[") {
          const m = CSI.exec(rest);
          if (m) { const key = csiKey(m[1], m[3]); if (key) pushKey(key); i += m[0].length; continue; }
          if (rest.length <= HOLD_MAX && (CSI_PARTIAL.test(rest) || PASTE_START.startsWith(rest))) { held = rest; break; }
          i += 2; continue; // 모르는 시퀀스는 버린다
        }
        if (rest[1] === "O") {
          if (rest.length < 3) { held = rest; break; }
          const key = SS3[rest[2]]; if (key) pushKey(key);
          i += 3; continue;
        }
        if (rest.length > 1 && /^[A-Za-z0-9]$/.test(rest[1])) { pushKey(`M-${rest[1]}`); i += 2; continue; }
        pushKey("Escape"); i += 1; continue;
      }
      const code = c.codePointAt(0);
      if (code < 0x20 || code === 0x7f) {
        const key = code === 0x0a ? "C-j" : controlKey(code);
        if (key) pushKey(key);
        i += 1; continue;
      }
      if (code >= 0x80 && code <= 0x9f) { i += 1; continue; } // C1 제어 문자
      pushText(String.fromCodePoint(code));
      i += code > 0xffff ? 2 : 1;
    }
    return tokens.slice();
  }
  // 이어질 조각을 기다리는 중인지: "paste"(끝 표시 대기)·"esc"(불완전한 이스케이프 순서)·null.
  const waiting = () => (paste !== null ? "paste" : held ? "esc" : null);
  // 기다리던 시간이 지났을 때. 단독 ESC는 Esc 키로 내고, 다른 불완전한 순서·끝 없는 붙여넣기는 보내지 않고 버린다.
  function expire() {
    const kind = waiting();
    const out = { tokens: [], dropped: kind === "paste" };
    if (kind === "esc" && held === ESC) out.tokens.push({ type: "key", key: "Escape" });
    held = ""; paste = null; over = false; pasteBytes = 0;
    return out;
  }
  return { feed, expire, waiting, reset() { held = ""; paste = null; over = false; pasteBytes = 0; } };
}

// 해석 결과 → 바닥 전송 함수가 받는 {text}|{key} 목록. 붙여넣기가 상한을 넘으면 over를 알린다.
export function toSendTokens(parsed) {
  const out = [];
  let over = false;
  const pushText = (text) => { if (out.at(-1)?.text !== undefined) out.at(-1).text += text; else out.push({ text }); };
  for (const t of parsed) {
    if (t.type === "key") out.push({ key: t.key });
    else if (t.type === "text") pushText(t.text);
    else if (t.type === "paste") { if (t.over) over = true; else if (t.text) pushText(t.text); }
  }
  return { tokens: out, over };
}

const LIST_CHARS = { k: "up", j: "down", r: "r", q: "q", 1: "1", 2: "2", 3: "3" };
// 목록·설명 포커스의 키 이름 목록(터미널 포커스가 아닐 때). 붙여넣기·모르는 시퀀스는 버린다.
export function listKeys(parsed) {
  const keys = [];
  for (const t of parsed) {
    if (t.type === "key") keys.push({ Up: "up", Down: "down", Enter: "enter", Tab: "enter", "C-c": "ctrl-c" }[t.key] ?? null);
    else if (t.type === "text") for (const ch of t.text) keys.push(LIST_CHARS[ch] ?? null);
  }
  return keys.filter(Boolean);
}
