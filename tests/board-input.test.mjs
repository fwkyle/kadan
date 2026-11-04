import test from "node:test";
import assert from "node:assert/strict";
import { createInputParser, listKeys, toSendTokens, ESC_WAIT_MS, PASTE_IDLE_MS } from "../src/board-input.mjs";

const parse = (chunk) => createInputParser().feed(chunk);
const send = (chunk) => toSendTokens(parse(chunk));

test("키 대응표: 글자·한글·특수키·Ctrl 문자를 tmux 키 이름으로 옮긴다", () => {
  assert.deepEqual(parse("ab한글🌙"), [{ type: "text", text: "ab한글🌙" }]);
  assert.deepEqual(parse("\r\t\x7f").map((t) => t.key), ["Enter", "Tab", "BSpace"]);
  const lone = createInputParser();
  assert.deepEqual(lone.feed("\x1b"), []); // 단독 ESC는 다음 조각을 기다리고, 시간이 지나야(expire) Esc 키가 된다
  assert.deepEqual(lone.expire().tokens.map((t) => t.key), ["Escape"]);
  assert.deepEqual(parse("\x1b[A\x1b[B\x1b[C\x1b[D").map((t) => t.key), ["Up", "Down", "Right", "Left"]);
  assert.deepEqual(parse("\x1bOA\x1bOH\x1bOF").map((t) => t.key), ["Up", "Home", "End"]);
  assert.deepEqual(parse("\x1b[H\x1b[F\x1b[5~\x1b[6~\x1b[3~\x1b[2~\x1b[Z").map((t) => t.key), ["Home", "End", "PPage", "NPage", "DC", "IC", "BTab"]);
  assert.deepEqual(parse("\x03\x01\x1a\x00\n").map((t) => t.key), ["C-c", "C-a", "C-z", "C-Space", "C-j"]);
  assert.deepEqual(parse("\x1b[1;5C\x1b[1;2A\x1b[1;3D").map((t) => t.key), ["C-Right", "S-Up", "M-Left"]);
  assert.deepEqual(parse("\x1bOP\x1b[15~\x1b[24~").map((t) => t.key), ["F1", "F5", "F12"]);
  assert.deepEqual(parse("\x1bx").map((t) => t.key), ["M-x"]);
});

test("글자와 키는 순서대로 섞여 나오고 이어진 글자는 한 묶음이다", () => {
  assert.deepEqual(parse("ab\rcd"), [{ type: "text", text: "ab" }, { type: "key", key: "Enter" }, { type: "text", text: "cd" }]);
});

test("모르는 바이트·시퀀스는 버린다(보내지 않는다)", () => {
  assert.deepEqual(parse("\x1c\x1e\x1f"), []); // 대응표에 없는 Ctrl 문자
  assert.deepEqual(parse("\x1b[?1;2c"), []); // 터미널 응답
  assert.deepEqual(parse("\x1b[99~\x1b[1;9A"), []);
  assert.deepEqual(parse("\x1b[I\x1b[O"), []); // 포커스 보고
  assert.deepEqual(parse("\x80\x9f"), []); // C1 제어
  assert.deepEqual(parse("\x1b[1;5P"), []);
});

test("Ctrl-]는 board가 가로채고 그 덩어리의 나머지 입력은 버린다", () => {
  assert.deepEqual(parse("ab\x1dq\r"), [{ type: "text", text: "ab" }, { type: "leave" }]);
  assert.deepEqual(parse("\x1d"), [{ type: "leave" }]);
  assert.deepEqual(parse("\x03").map((t) => t.key), ["C-c"]); // Ctrl-C는 가로채지 않는다
});

test("괄호 붙여넣기는 한 덩어리 글자이고 줄바꿈·제어 문자를 키로 읽지 않는다", () => {
  const out = parse("\x1b[200~hello\nworld\r!\x1b[201~");
  assert.deepEqual(out, [{ type: "paste", text: "hello\nworld\r!", over: false }]);
  assert.deepEqual(toSendTokens(out), { tokens: [{ text: "hello\nworld\r!" }], over: false });
  assert.deepEqual(send("x\x1b[200~a\x1b[Ab\x1b[201~y").tokens, [{ text: "xa\x1b[Aby" }]);
});

test("붙여넣기와 이스케이프 시퀀스가 입력 덩어리 경계에서 쪼개져도 이어 붙인다", () => {
  const p = createInputParser();
  assert.deepEqual(p.feed("\x1b[20"), []);
  assert.deepEqual(p.feed("0~ab"), []);
  assert.deepEqual(p.feed("c\x1b[20"), []);
  assert.deepEqual(p.feed("1~"), [{ type: "paste", text: "abc", over: false }]);
  const q = createInputParser();
  assert.deepEqual(q.feed("\x1b["), []);
  assert.deepEqual(q.feed("A").map((t) => t.key), ["Up"]);
  const r = createInputParser();
  assert.deepEqual(r.feed("\x1bO"), []);
  assert.deepEqual(r.feed("B").map((t) => t.key), ["Down"]);
});

test("붙여넣기가 상한을 넘으면 보내지 않고 알린다", () => {
  const p = createInputParser({ pasteMax: 10 });
  const out = p.feed(`\x1b[200~${"a".repeat(11)}\x1b[201~z`);
  assert.deepEqual(out, [{ type: "paste", text: "", over: true }, { type: "text", text: "z" }]);
  assert.deepEqual(toSendTokens(out), { tokens: [{ text: "z" }], over: true });
  const split = createInputParser({ pasteMax: 10 });
  split.feed("\x1b[200~aaaaaa"); split.feed("bbbbbb");
  assert.equal(split.feed("\x1b[201~")[0].over, true);
});

test("목록 포커스 키: 화살표·jk·Enter/Tab·1 2 3·r·q·Ctrl-C만 읽고 붙여넣기·나머지는 버린다", () => {
  assert.deepEqual(listKeys(parse("\x1b[A\x1b[Bjk\r\t123rq\x03")), ["up", "down", "down", "up", "enter", "enter", "1", "2", "3", "r", "q", "ctrl-c"]);
  assert.deepEqual(listKeys(parse("hello\x1b[Cxyz한글")), []);
  assert.deepEqual(listKeys(parse("\x1b[200~qqq\x1b[201~")), []);
});

test("ESC 단독 → 이어진 괄호 붙여넣기는 하나의 붙여넣기이고 Esc 키는 나오지 않는다", () => {
  const p = createInputParser();
  assert.deepEqual(p.feed("\x1b"), []);
  assert.equal(p.waiting(), "esc");
  assert.deepEqual(p.feed("[200~payload\x1b[201~"), [{ type: "paste", text: "payload", over: false }]);
  assert.equal(p.waiting(), null);
});

test("시작·끝 표시가 각각 여러 조각으로 쪼개져도 한 덩어리로 모은다", () => {
  const p = createInputParser();
  const out = ["\x1b", "[2", "00", "~ab", "한", "\x1b", "[20", "1~z"].flatMap((c) => p.feed(c));
  assert.deepEqual(out, [{ type: "paste", text: "ab한", over: false }, { type: "text", text: "z" }]);
});

test("ESC 단독 뒤 시간이 지나면 단독 Esc이고, 쪼개진 화살표는 하나의 키다", () => {
  const p = createInputParser();
  p.feed("\x1b");
  assert.deepEqual(p.expire(), { tokens: [{ type: "key", key: "Escape" }], dropped: false });
  assert.equal(p.waiting(), null);
  assert.deepEqual(p.feed("\x1b").concat(p.feed("[").concat(p.feed("A"))).map((t) => t.key), ["Up"]);
  assert.deepEqual(p.feed("\x1b").concat(p.feed("OB")).map((t) => t.key), ["Down"]);
  assert.deepEqual(p.feed("a\x1b").map((t) => t.text ?? t.key), ["a"]);
  assert.deepEqual(p.feed("[C").map((t) => t.key), ["Right"]);
});

test("불완전한 순서(ESC[)는 시간이 지나면 보내지 않고 버린다", () => {
  const p = createInputParser();
  p.feed("\x1b[");
  assert.deepEqual(p.expire(), { tokens: [], dropped: false });
  assert.deepEqual(p.feed("x"), [{ type: "text", text: "x" }]);
});

test("끝 표시 없는 붙여넣기는 시간이 지나면 버리고 알리며, 이후 입력은 정상이다", () => {
  const p = createInputParser();
  p.feed("\x1b[200~abc");
  assert.equal(p.waiting(), "paste");
  assert.deepEqual(p.expire(), { tokens: [], dropped: true });
  assert.deepEqual(p.feed("q"), [{ type: "text", text: "q" }]);
  assert.ok(ESC_WAIT_MS < PASTE_IDLE_MS);
});

test("붙여넣기 상한은 UTF-8 바이트: 한글 21,845자(65,535바이트) 통과, 21,846자 거절, 65,536바이트 ASCII 통과", () => {
  const paste = (text) => createInputParser().feed(`\x1b[200~${text}\x1b[201~`)[0];
  assert.equal(paste("가".repeat(21_845)).over, false);
  assert.equal(paste("가".repeat(21_846)).over, true);
  assert.equal(paste("a".repeat(65_536)).over, false);
  assert.equal(paste("a".repeat(65_537)).over, true);
  const split = createInputParser();
  split.feed("\x1b[200~"); split.feed("가".repeat(20_000));
  assert.equal(split.feed("가".repeat(1_846) + "\x1b[201~")[0].over, true);
});
