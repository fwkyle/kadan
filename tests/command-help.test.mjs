import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../src/cli.mjs";
import { ALIASES, GROUPS, SHORT_LIST, coverageProblems, displayWidth } from "../src/command-help.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cliPath = path.join(root, "src", "cli.mjs");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const commandsDoc = fs.readFileSync(path.join(root, "docs", "commands.md"), "utf8");
const keys = Object.keys(COMMANDS);
const nameOf = row => row.replace(/^kadan /, "").split(/\s/)[0];

test("COMMANDS 키 전부가 help --all 줄이나 별칭 목록 중 정확히 한 곳에 있다", () => {
  assert.deepEqual(coverageProblems(keys), []);
});

test("명령 하나를 일부러 빼거나 겹치게 하면 위 검사가 실패한다", () => {
  const without = GROUPS.map(([title, rows]) => [title, rows.filter(([name]) => name !== "mail")]);
  assert.match(coverageProblems(keys, without).join("\n"), /mail: help --all에 없다/);
  const twice = [...GROUPS, ["겹침", [["mail", "또 한 번"]]]];
  assert.match(coverageProblems(keys, twice).join("\n"), /mail: 2곳에 있다/);
  assert.match(coverageProblems(keys, GROUPS, [...ALIASES, ["mail", "x", "y"]]).join("\n"), /mail: 2곳/);
  assert.match(coverageProblems(keys.filter(key => key !== "recovery")).join("\n"), /recovery: COMMANDS에 없는 이름/);
});

test("짧은 목록 9개의 명령 이름이 모두 COMMANDS에 있다", () => {
  assert.equal(SHORT_LIST.length, 9);
  for (const [command] of SHORT_LIST) assert.ok(keys.includes(nameOf(command)), command);
});

test("README의 표와 5분 시작 블록에 적힌 kadan 명령은 모두 COMMANDS에 있다", () => {
  const start = readme.indexOf("## 5분 시작하기");
  const end = readme.indexOf("## 데이터와 설정");
  const lines = readme.slice(start, end).split("\n").filter(line => /^(\||kadan )/.test(line));
  const found = new Set();
  for (const line of lines) for (const m of line.matchAll(/kadan ([a-z][a-z-]*)/g)) found.add(m[1]);
  assert.ok(found.size >= 9);
  for (const name of found) assert.ok(keys.includes(name), `README의 죽은 명령: kadan ${name}`);
});

test("짧은 목록 9개의 명령과 문구가 README에 그대로 있다", () => {
  for (const [command, text] of SHORT_LIST) assert.ok(readme.includes(`| \`${command}\` | ${text} |`), command);
});

test("5분 시작 블록이 docs/ai-install.md 3·4단계와 같은 순서로 runners init과 doctor를 둔다", () => {
  const block = readme.slice(readme.indexOf("## 5분 시작하기"), readme.indexOf("## 핵심 개념"));
  const order = ["kadan init", "kadan runners init --reason", "kadan up", "kadan attach 비서", "kadan doctor"];
  const at = order.map(piece => block.indexOf(piece));
  assert.ok(at.every(i => i >= 0), at.join());
  assert.deepEqual([...at].sort((a, b) => a - b), at);
});

test("docs/commands.md에 별칭을 뺀 최상위 명령이 모두 나온다", () => {
  const aliasNames = new Set(ALIASES.map(([name]) => name));
  for (const key of keys.filter(key => !aliasNames.has(key))) {
    assert.ok(new RegExp(`\`kadan ${key}[ \`\\[|]`).test(commandsDoc), `commands.md에 없는 명령: ${key}`);
  }
});

test("묶음 목록 줄은 정렬된 두 칸이다 — 한글을 2칸으로 센다", () => {
  assert.equal(displayWidth("비서 abc"), 8);
  const lines = run(["help", "--all"]).stdout.split("\n").filter(line => line.startsWith("  kadan "));
  assert.ok(lines.length >= keys.length - 1);
  const columns = lines.map(line => displayWidth(line.match(/^(.*?\S)( {3,})(?=\S)/)[0]));
  assert.equal(new Set(columns).size, 1, columns.join());
});

function run(args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-help-"));
  const env = { ...process.env, KADAN_HOME: home, KADAN_WINDOW: "none", KADAN_NOTIFY: "off" };
  delete env.KADAN_ROLE;
  const result = spawnSync(process.execPath, [cliPath, ...args], { env, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("종료 코드와 출력 경로: help·--help·인자 없음은 stdout 0, --all도 stdout 0", () => {
  const shortLines = SHORT_LIST.map(([command]) => command);
  for (const args of [["help"], ["--help"], []]) {
    const result = run(args);
    assert.equal(result.status, 0, args.join(" "));
    assert.equal(result.stderr, "");
    for (const command of shortLines) assert.ok(result.stdout.includes(command), command);
    assert.match(result.stdout, /전체: `kadan help --all` · 명령어 사전: docs\/commands\.md/);
    assert.doesNotMatch(result.stdout, /kadan dispatch/);
  }
  const all = run(["help", "--all"]);
  assert.equal(all.status, 0);
  assert.equal(all.stderr, "");
  for (const [, rows] of GROUPS) for (const [name] of rows) assert.ok(all.stdout.includes(`kadan ${name}`), name);
  for (const [name] of ALIASES) assert.ok(all.stdout.includes(`kadan ${name}`), name);
});

test("종료 코드와 출력 경로: 모르는 명령은 stderr에 안내와 짧은 목록, stdout 비어 있고 1", () => {
  const result = run(["없는명령"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^모르는 명령: 없는명령\n/);
  for (const [command] of SHORT_LIST) assert.ok(result.stderr.includes(command), command);
});
