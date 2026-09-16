// 편지 본문은 원장이 아니라 옆 파일에 둔다 — 2026-09-06 [kyle] 승인.
// 원장은 append-only라 줄을 못 지운다. 본문에 비밀이 섞였을 때 지울 수 있어야 한다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { guardedSend, mailPreview, recentSends } from "../src/cli.mjs";
import { mailDir, readMailBody, saveMailBody } from "../src/ledger.mjs";

const fakeFloor = {
  name: "fake",
  alive: () => true,
  pid: () => "111",
  send: () => ({}),
};

test("보낸 본문은 지문 이름의 옆 파일로 남고 원장 줄에는 앞머리만 남는다 — 2026-09-06", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-mail-"));
  const message = `작업 카드: /repo/docs/cards/card-66.md — 읽고 그대로 수행해라. ${"긴 지시 ".repeat(20)}`;
  const lines = [];

  const entry = guardedSend({
    floor: fakeFloor,
    session: "kadan-b-작업자",
    role: "b-작업자",
    message,
    taskId: "card-66",
    recordedPid: "111",
    env: {KADAN_HOME:home},
    record: line => lines.push(line),
    readEntries: () => [],
    saveBody: (digestValue, body) => saveMailBody(digestValue, body, home),
  });

  // 원장에는 본문이 통째로 들어가지 않는다.
  assert.equal(entry.preview.length <= 101, true);
  assert.equal(entry.preview.includes("card-66.md"), true);
  assert.equal(JSON.stringify(entry).includes(message), false);

  // 본문은 옆 파일에 그대로 있다.
  const saved = readMailBody(entry.digest, home);
  assert.equal(saved, message);
  assert.equal(fs.existsSync(path.join(mailDir(home), `${entry.digest}.txt`)), true);

  // 본문을 보관 위치로 옮겨도 원장은 그대로다.
  fs.renameSync(path.join(mailDir(home), `${entry.digest}.txt`),path.join(mailDir(home), `${entry.digest}.saved`));
  assert.equal(readMailBody(entry.digest, home), null);
  assert.equal(lines.length, 1);
});

test("미리보기는 줄바꿈을 눕히고 한 줄로 자른다", () => {
  assert.equal(mailPreview("짧은 지시"), "짧은 지시");
  assert.equal(mailPreview("여러\n줄\t지시"), "여러 줄 지시");
  const long = mailPreview("가".repeat(200));
  assert.equal(long.length, 101);
  assert.equal(long.endsWith("…"), true);
  assert.equal(mailPreview(undefined), "");
});

test("우편함은 미리보기를 함께 넘긴다 — 본문이 없으면 본문 칸도 없다", () => {
  const entries = [
    { t: "2026-09-06T02:10:00.000Z", kind: "send", role: "b-작업자", taskId: "card-66", bytes: 30, digest: "없는지문", preview: "작업 카드: …", by: "슈퍼감독" },
  ];
  const mail = recentSends(entries);

  assert.equal(mail[0].preview, "작업 카드: …");
  assert.equal("body" in mail[0], false);
});
