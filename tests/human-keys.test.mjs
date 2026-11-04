import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { markHumanInput, sendHumanKeys } from "../src/floor-tmux.mjs";

// 가짜 tmux: 명령을 기록하고 상태 질문에만 답한다. 실제 tmux는 부르지 않는다.
function fake({ pid = "100", dead = "0", mode = "0", clients = "1000 1000", failSend = false, hasSession = true } = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === "has-session") { if (!hasSession) throw new Error("no session"); return ""; }
    if (args[0] === "display-message") return args.at(-1) === "#{pane_in_mode}" ? `${mode}\n` : `${pid}|${dead}\n`;
    if (args[0] === "list-clients") return `${clients}\n`;
    if (args[0] === "send-keys" && failSend) throw new Error("tmux 실패");
    return "";
  };
  return { calls, run, names: () => calls.map((c) => c[0]), sends: () => calls.filter((c) => c[0] === "send-keys") };
}
const S = "kadan-슈퍼";
const base = (f, extra = {}) => ({ allowed: new Set([S]), expectedPid: "100", run: f.run, clock: () => 100_000_500, markState: new Map(), ...extra });

test("목록 밖 세션·카단 아닌 이름은 tmux를 한 번도 부르지 않고 거절한다", () => {
  const f = fake();
  assert.throws(() => sendHumanKeys("kadan-다른역할", [{ text: "a" }], base(f)), { code: "KADAN_BOARD_TARGET_DENIED" });
  assert.throws(() => sendHumanKeys("my-session", [{ text: "a" }], { ...base(f), allowed: new Set(["my-session"]) }), { code: "KADAN_BOARD_TARGET_DENIED" });
  assert.throws(() => sendHumanKeys("kadan-a:b", [{ text: "a" }], { ...base(f), allowed: new Set(["kadan-a:b"]) }), { code: "KADAN_BOARD_TARGET_DENIED" });
  assert.throws(() => sendHumanKeys(S, [{ text: "a" }], { ...base(f), allowed: undefined }), { code: "KADAN_BOARD_TARGET_DENIED" });
  assert.throws(() => sendHumanKeys(S, [{ text: "a" }], { ...base(f), expectedPid: undefined }), { code: "KADAN_PID_MISMATCH" });
  assert.deepEqual(f.calls, []);
});

test("다른 창에 붙은 client가 최근 30초 안에 키를 쳤으면 보내지 않는다", () => {
  const f = fake({ clients: "99990 99999" }); // 생성보다 활동이 뒤 = 키 입력, 지금(100000.5초)보다 1초 전
  assert.throws(() => sendHumanKeys(S, [{ text: "a" }], base(f)), { code: "KADAN_OTHER_CLIENT_ACTIVE" });
  assert.deepEqual(f.sends(), []);
  assert.ok(!f.names().includes("set-option"), "거절하면 입력 표시도 남기지 않는다");
  const old = fake({ clients: "99000 99100" }); // 오래전 입력
  assert.deepEqual(sendHumanKeys(S, [{ text: "a" }], base(old)), { sent: 1 });
  const justAttached = fake({ clients: "99999 99999" }); // 붙기만 한 client는 입력이 아니다
  assert.deepEqual(sendHumanKeys(S, [{ text: "a" }], base(justAttached)), { sent: 1 });
  assert.throws(() => sendHumanKeys(S, [{ text: "a" }], base(fake({ clients: "이상한 값" }))), { code: "KADAN_HUMAN_ACTIVITY_UNKNOWN" });
});

test("pane PID가 포커스 때와 다르거나 죽은 화면이면 보내지 않는다", () => {
  const changed = fake({ pid: "999" });
  assert.throws(() => sendHumanKeys(S, [{ text: "a" }], base(changed)), { code: "KADAN_PID_MISMATCH" });
  assert.deepEqual(changed.sends(), []);
  const dead = fake({ dead: "1" });
  assert.throws(() => sendHumanKeys(S, [{ text: "a" }], base(dead)), { code: "KADAN_PID_MISMATCH" });
  const gone = fake({ hasSession: false });
  assert.throws(() => sendHumanKeys(S, [{ text: "a" }], base(gone)), { code: "KADAN_SESSION_GONE" });
  assert.deepEqual(gone.sends(), []);
});

test("기록보기(복사모드) 중이면 보내지 않고 모드를 끄지도 않는다", () => {
  const f = fake({ mode: "1" });
  assert.throws(() => sendHumanKeys(S, [{ key: "Enter" }], base(f)), { code: "KADAN_PANE_IN_MODE" });
  assert.deepEqual(f.sends(), []);
  assert.ok(!f.calls.some((c) => c.includes("-X") || c.includes("cancel")), "release 하지 않는다");
});

test("글자는 -l 한 묶음, 키는 이름으로, 정확 대상 =세션:만 쓴다", () => {
  const f = fake();
  const result = sendHumanKeys(S, [{ text: "ab한글" }, { key: "Enter" }, { key: "C-c" }, { text: "-x" }, { key: "Up" }], base(f));
  assert.deepEqual(result, { sent: 4 });
  assert.deepEqual(f.sends(), [
    ["send-keys", "-t", `=${S}:`, "-l", "--", "ab한글"],
    ["send-keys", "-t", `=${S}:`, "Enter", "C-c"],
    ["send-keys", "-t", `=${S}:`, "-l", "--", "-x"],
    ["send-keys", "-t", `=${S}:`, "Up"],
  ]);
  assert.ok(f.calls.every((c) => !c.some((a) => /^%\d|^@\d/.test(a))), "자동 번호 ID를 주소로 쓰지 않는다");
});

test("글자 끝의 세미콜론은 tmux 명령 구분자로 읽히지 않게 따로 보낸다", () => {
  const f = fake();
  sendHumanKeys(S, [{ text: "a;b;;" }, { text: ";" }], base(f));
  assert.deepEqual(f.sends(), [
    ["send-keys", "-t", `=${S}:`, "-l", "--", "a;b"],
    ["send-keys", "-t", `=${S}:`, "-N", "2", "\\;"],
    ["send-keys", "-t", `=${S}:`, "-N", "1", "\\;"],
  ]);
});

test("긴 붙여넣기는 상한 안에서 여러 명령으로 나누고, 64KB를 넘으면 아무것도 보내지 않는다", () => {
  const f = fake();
  const result = sendHumanKeys(S, [{ text: "가".repeat(4500) }], base(f));
  assert.equal(result.sent, 7); // 한 명령은 UTF-8 2,000바이트 이하(한글 666자)
  assert.ok(f.sends().every((c) => Buffer.byteLength(c.at(-1)) <= 2000));
  assert.equal(f.sends().map((c) => c.at(-1)).join(""), "가".repeat(4500));
  const big = fake();
  assert.throws(() => sendHumanKeys(S, [{ text: "a".repeat(64 * 1024 + 1) }], base(big)), { code: "KADAN_BOARD_PASTE_TOO_LARGE" });
  assert.deepEqual(big.calls, []);
  assert.deepEqual(sendHumanKeys(S, [{ text: "a".repeat(64 * 1024) }], base(fake())).sent > 0, true);
});

test("모르는 키 이름은 아무것도 보내기 전에 거절한다", () => {
  for (const key of ["Delete", "C-;", "M-;", "x", "Enter;", "-l", "C-A", ""]) {
    const f = fake();
    assert.throws(() => sendHumanKeys(S, [{ text: "ok" }, { key }], base(f)), { code: "KADAN_BOARD_KEY_UNKNOWN" }, key);
    assert.deepEqual(f.calls, [], key);
  }
});

test("@kadan_human_input에 epoch 초를 남기고 1초에 1번 이하로만 쓴다", () => {
  const f = fake();
  let now = 100_000_500;
  const opts = { ...base(f), clock: () => now };
  sendHumanKeys(S, [{ text: "a" }], opts);
  now += 300; sendHumanKeys(S, [{ text: "b" }], opts);
  now += 300; sendHumanKeys(S, [{ text: "c" }], opts);
  assert.deepEqual(f.calls.filter((c) => c[0] === "set-option"), [["set-option", "-t", `=${S}:`, "@kadan_human_input", "100000"]]);
  now += 1000; sendHumanKeys(S, [{ text: "d" }], opts);
  assert.deepEqual(f.calls.filter((c) => c[0] === "set-option").at(-1), ["set-option", "-t", `=${S}:`, "@kadan_human_input", "100002"]);
  // 읽는 쪽(relayedHumanInputRecent)과 같은 값 형식: 숫자 1~12자리 epoch 초
  assert.match(f.calls.find((c) => c[0] === "set-option")[4], /^\d{1,12}$/);
  const state = new Map();
  assert.equal(markHumanInput(S, { run: f.run, clock: () => 5000, state }), true);
  assert.equal(markHumanInput(S, { run: f.run, clock: () => 5999, state }), false);
  assert.equal(markHumanInput(S, { run: f.run, clock: () => 6000, state }), true);
});

test("생존·PID·다른 client 확인은 마지막 확인이 1초를 넘었을 때만 다시 하고, 기록보기 확인은 매번 한다", () => {
  const f = fake();
  let now = 100_000_500;
  const opts = { ...base(f), clock: () => now, guard: {} };
  sendHumanKeys(S, [{ text: "a" }], opts);
  const first = f.calls.length;
  now += 400; sendHumanKeys(S, [{ text: "b" }], opts);
  const second = f.calls.slice(first).map((c) => c[0] + (c[3] ?? ""));
  assert.ok(!second.includes("has-session") && !second.includes("list-clients"), `1초 안에는 다시 확인하지 않음: ${second}`);
  assert.ok(f.calls.slice(first).some((c) => c.at(-1) === "#{pane_in_mode}"), "복사모드는 매번 확인");
  now += 700; sendHumanKeys(S, [{ text: "c" }], opts);
  assert.ok(f.calls.slice(first).some((c) => c[0] === "list-clients"), "1초가 지나면 다시 확인");
  // 그 사이 PID가 바뀌었으면 거절
  const changed = fake({ pid: "555" });
  assert.throws(() => sendHumanKeys(S, [{ text: "x" }], { ...opts, run: changed.run, guard: { checkedAt: now - 2000 } }), { code: "KADAN_PID_MISMATCH" });
});

test("send-keys가 실패하면 전달 미확인(delivery unknown)으로 던진다", () => {
  const f = fake({ failSend: true });
  assert.throws(() => sendHumanKeys(S, [{ text: "a" }], base(f)), (error) => error.delivery === "unknown");
});

test("기존 checkHumanIdle 동작은 그대로다(client 최근 입력이면 KADAN_HUMAN_ACTIVE)", async () => {
  const { tmuxFloor } = await import("../src/floor-tmux.mjs");
  assert.equal(typeof tmuxFloor.assertHumanIdle, "function");
  const text = fs.readFileSync(new URL("../src/floor-tmux.mjs", import.meta.url), "utf8");
  assert.ok(text.includes('deny("KADAN_HUMAN_ACTIVE", "전송 보류: 사람이 이 창에서 최근 입력함'));
  assert.ok(text.includes('deny("KADAN_HUMAN_ACTIVITY_UNKNOWN", "전송 보류: 사람 입력 시각 미확인'));
});

test("상한은 글자 수가 아니라 UTF-8 바이트이고, 넘으면 tmux 호출 전에 거절하며, 조각은 문자 중간에서 자르지 않는다", () => {
  const over = fake();
  assert.throws(() => sendHumanKeys(S, [{ text: "가".repeat(21_846) }], base(over)), { code: "KADAN_BOARD_PASTE_TOO_LARGE" });
  assert.deepEqual(over.calls, []);
  const ok = fake();
  assert.ok(sendHumanKeys(S, [{ text: "가".repeat(21_845) }], base(ok)).sent > 0);
  assert.equal(ok.sends().map((c) => c.at(-1)).join(""), "가".repeat(21_845));
  const emoji = fake();
  sendHumanKeys(S, [{ text: "🌙".repeat(1_001) }], base(emoji)); // 4바이트 글자: 경계에서도 깨지지 않는다
  assert.equal(emoji.sends().map((c) => c.at(-1)).join(""), "🌙".repeat(1_001));
  assert.ok(emoji.sends().every((c) => Buffer.byteLength(c.at(-1)) <= 2000));
});
