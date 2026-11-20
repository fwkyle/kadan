import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {WorkStore} from '../src/work-store.mjs';
import {workCommand, WORK_FLAGS} from '../src/work-command.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const ctx = (home, extra = {}) => ({home, by: '감독', ...extra});
const KEY = 'repo-a/work1';

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-work-flags-'));
  workCommand(['create', KEY], {
    title: '업무', goal: '결과', scope: '범위', acceptance: '완료 조건', owner: '감독', 'repo-path': '/tmp', board: '시험판',
  }, ctx(home));
  return home;
}

// 홈 아래 모든 파일의 내용을 한 해시로 묶는다. 거절된 명령이 무엇이든 쓰지 않았다는 근거.
function snapshot(home) {
  const hash = crypto.createHash('sha256');
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else hash.update(`${path.relative(home, full)}\0${fs.readFileSync(full)}\0`);
    }
  };
  walk(home);
  return hash.digest('hex');
}

const attempt = async (args, flags, context) => {
  try { return {result: await workCommand(args, flags, context)}; } catch (error) { return {error}; }
};

test('하위 명령마다 모르는 플래그 하나는 이름과 함께 종료 2로 거절하고 아무것도 쓰지 않는다', async () => {
  const home = fixture();
  const before = snapshot(home), revision = new WorkStore(home).get(KEY).revision;
  for (const action of Object.keys(WORK_FLAGS)) {
    const valid = Object.fromEntries(['revision', 'note'].filter(name => WORK_FLAGS[action].includes(name)).map(name => [name, name === 'note' ? '시험' : String(revision)]));
    const {error} = await attempt([action, KEY], {...valid, next: 'x'}, ctx(home));
    assert.equal(error?.exitCode, 2, `${action}: ${error?.message}`);
    assert.match(error.message, new RegExp(`^work ${action}가 모르는 플래그: --next \\(쓸 수 있는 것: `, 'u'), action);
  }
  assert.equal(new WorkStore(home).get(KEY).revision, revision, '업무 revision이 그대로여야 한다');
  assert.equal(snapshot(home), before, '원장·카드·업무 파일이 그대로여야 한다');
});

test('모르는 플래그가 여럿이면 모두 적고, 쓸 수 있는 것을 보여 준다', async () => {
  const {error} = await attempt(['update', KEY], {revision: '1', note: 'x', next: 'a', json: true}, ctx(fixture()));
  assert.equal(error.exitCode, 2);
  assert.match(error.message, /--next, --json/u);
  assert.match(error.message, /--next-action/u);
});

test('--help는 모르는 플래그가 같이 있어도 지금처럼 통과한다', async () => {
  const home = fixture();
  for (const action of ['update', 'create', 'auto-report']) {
    const {result, error} = await attempt([action], {help: true, next: 'x'}, ctx(home));
    assert.equal(error, undefined, action);
    assert.match(result, /^kadan work /u);
  }
});

test('모르는 플래그 거절은 객체 기본 이름에도 걸린다', async () => {
  for (const name of ['__proto__', 'constructor', 'toString']) {
    const flags = {revision: '1', note: 'x'};
    Object.defineProperty(flags, name, {value: true, enumerable: true, configurable: true, writable: true});
    const {error} = await attempt(['update', KEY], flags, ctx(fixture()));
    assert.equal(error?.exitCode, 2, name);
    assert.match(error.message, new RegExp(`--${name}`, 'u'));
  }
});

test('하위 명령마다 쓸 수 있는 플래그 전부는 거절 문구를 거치지 않는다', async () => {
  const home = fixture();
  const full = {revision: '1', note: '시험', result: 'r', interval: '1'};
  for (const [action, allowed] of Object.entries(WORK_FLAGS)) {
    const flags = Object.fromEntries(allowed.map(name => [name, full[name] ?? 'x']));
    flags['keep-roles'] = flags['keep-roles'] === undefined ? undefined : true;
    flags['next-block'] = flags['next-block'] === undefined ? undefined : true;
    for (const key of Object.keys(flags)) if (flags[key] === undefined) delete flags[key];
    // 업무를 실제로 바꾸지 않도록 없는 업무 키로 부른다. 어떤 오류든 상관없고, 플래그 거절만 아니면 통과다.
    const {error} = await attempt([action, 'repo-z/없음'], flags, ctx(home));
    assert.doesNotMatch(error?.message ?? '', /모르는 플래그/u, action);
  }
});

test('감독이 쓰는 긴 발령 꼴(execute --assign --dispatch)이 그대로 통과한다', async () => {
  const home = fixture();
  const body = path.join(home, 'body.md');
  fs.writeFileSync(body, `# card\n\n## 읽고 시작할 것\n- ${path.join(root, 'CLAUDE.md')} — 규칙\n`);
  const sent = [];
  const {result, error} = await attempt(['execute', KEY], {
    revision: '1', phase: 'implementation', round: '1', title: '실행', 'body-file': body, note: '시험',
    difficulty: 'hard', assign: '작업자', dispatch: '카드를 읽고 수행하라',
  }, ctx(home, {send: message => { sent.push(message); return {sent: true}; }}));
  assert.equal(error, undefined, error?.message);
  assert.equal(result.card.role, '작업자');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].role, '작업자');
});

// ---- docs·skills·코드가 보여 주는 `kadan work <동작> …` 플래그가 전부 허용 목록에 있어야 한다 ----

const SKIP_DIRS = new Set(['daily', 'node_modules', '.git']);
function sources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('phase-history')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (/\.(md|mjs|js|jsx|ts|tsx|sh)$/u.test(entry.name)) out.push(full);
  }
  return out;
}

// JS 보간식 `${…}`은 안에 `)`·`|`·따옴표가 있어 아래 줄 단위 자르기를 깬다(`quote(workKey)` 뒤 옵션, 삼항 안 `' --result-file …'`).
// 균형 잡힌 `${…}`를 그 안에서 보이는 `--플래그`만 남긴 공백 조각으로 바꾼다. 안의 따옴표·괄호·`|`는 버린다.
// 한 호출은 다음 `kadan work`에서도 끝난다(한 줄에 두 호출이 있을 때 앞 호출이 뒤 플래그를 가져가지 않게).
// 남은 한계: 보간식이 아닌 곳의 `)`·`|`·`;`·백틱은 여전히 한 호출의 끝으로 본다(그 뒤 플래그는 못 본다. 허용 목록은 코드 기준이라 영향 작음).
function flattenInterpolations(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '$' || text[i + 1] !== '{') { out += text[i]; continue; }
    let depth = 0, j = i + 1;
    for (; j < text.length; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}' && --depth === 0) break;
    }
    if (j >= text.length) { out += text[i]; continue; } // 닫히지 않은 `${`는 그대로 둔다
    out += ` X${[...text.slice(i, j + 1).matchAll(/(?<=^|[\s'"`[])--([a-z][a-z-]*)/gu)].map(m => ` --${m[1]}`).join('')} `;
    i = j;
  }
  return out;
}

export function workFlagsMentioned(text) {
  const found = [];
  const joined = flattenInterpolations(text.replace(/\\\r?\n\s*/gu, ' '));
  for (const match of joined.matchAll(/kadan work ([a-z][a-z-]*)((?:(?!kadan work )[^\n`|;)])*)/gu)) {
    const segment = match[2].replace(/"[^"]*"|'[^']*'|<[^>]*>/gu, ' ').replace(/["'].*$/u, ' ');
    for (const flag of segment.matchAll(/(?:^|[\s[])--([a-z][a-z-]*)/gu)) found.push({action: match[1], flag: flag[1]});
  }
  return found;
}

test('추출기 자체: 줄 이음·따옴표·꺾쇠 안 플래그는 세지 않는다', () => {
  const text = "kadan work update k --revision 2 \\\n  --note '--가짜 이유' --next-action <--꺾쇠>\n`kadan work show k` --repo x";
  assert.deepEqual(workFlagsMentioned(text), [
    {action: 'update', flag: 'revision'}, {action: 'update', flag: 'note'}, {action: 'update', flag: 'next-action'},
  ]);
});

test('추출기 자체: 보간식 안 `|`·`quote(…)` 뒤와 삼항 안 `--result-file`도 센다', () => {
  const source = "lines.push(`kadan work auto-report ${work.key} --execution ${card.key} --outcome ${a==='review'?'pass|changes':'implemented'}${card.resultPath?'':' --result-file <경로>'}`);\n"
    + "`kadan work update ${quote(workKey)} --revision ${revision} --turn-owner ${quote(sender)} --note '차례'`";
  assert.deepEqual(workFlagsMentioned(source), [
    {action: 'auto-report', flag: 'execution'}, {action: 'auto-report', flag: 'outcome'}, {action: 'auto-report', flag: 'result-file'},
    {action: 'update', flag: 'revision'}, {action: 'update', flag: 'turn-owner'}, {action: 'update', flag: 'note'},
  ]);
  // 한 줄에 두 호출: 앞 호출(show)이 뒤 호출(update)의 플래그를 가져가면 안 된다.
  assert.deepEqual(workFlagsMentioned("확인: kadan work show ${quote(k)} — 직접: kadan work update ${quote(k)} --revision 2"), [
    {action: 'update', flag: 'revision'},
  ]);
});

// 결과 경로가 없는 이전 실행의 자동 보고 안내(src/role-instructions.mjs, docs/automatic-review.md)가 쓰는 옵션. 허용 목록을 거치지 않는 고정 기대값이다.
test('auto-report의 --execution·--outcome·--result-file은 고정 기대값으로 허용되고, 안내문 원문에서도 뽑힌다', async () => {
  for (const flag of ['execution', 'outcome', 'result-file']) assert.ok(WORK_FLAGS['auto-report'].includes(flag), flag);
  const {error} = await attempt(['auto-report', 'repo-z/없음'], {execution: 'repo-z/e', outcome: 'implemented', 'result-file': '/tmp/r.md'}, ctx(fixture()));
  assert.doesNotMatch(error?.message ?? '', /모르는 플래그/u);
  const bad = await attempt(['auto-report', 'repo-z/없음'], {execution: 'repo-z/e', outcome: 'implemented', 'result-fil': '/tmp/r.md'}, ctx(fixture()));
  assert.equal(bad.error?.exitCode, 2);
  const mentioned = workFlagsMentioned(fs.readFileSync(path.join(root, 'src/role-instructions.mjs'), 'utf8'));
  assert.ok(mentioned.some(x => x.action === 'auto-report' && x.flag === 'result-file'), 'role-instructions.mjs 안내문에서 --result-file을 못 뽑았다');
});

test('docs·skills·src·gui·scripts에 적힌 kadan work 플래그는 모두 허용 목록에 있다', () => {
  const files = ['docs', 'skills', 'src', 'gui', 'scripts'].filter(d => fs.existsSync(path.join(root, d)))
    .flatMap(d => sources(path.join(root, d)));
  files.push(path.join(root, 'README.md'));
  let seen = 0;
  const missing = [];
  for (const file of files) {
    for (const {action, flag} of workFlagsMentioned(fs.readFileSync(file, 'utf8'))) {
      if (!Object.hasOwn(WORK_FLAGS, action)) continue;
      seen++;
      if (flag !== 'help' && !WORK_FLAGS[action].includes(flag)) missing.push(`${path.relative(root, file)}: work ${action} --${flag}`);
    }
  }
  assert.ok(seen > 30, `대조한 플래그가 너무 적다(${seen}) — 추출이 깨졌을 수 있다`);
  assert.deepEqual(missing, []);
});

// ---- CLI 실물 ----

test('CLI: work update --next는 종료 2와 이름, 업무는 그대로이고 --next-action은 통과한다', () => {
  const home = fixture();
  const cli = (...args) => spawnSync(process.execPath, [path.join(root, 'src/cli.mjs'), 'work', ...args], {
    encoding: 'utf8', env: {...process.env, KADAN_HOME: home, KADAN_SOCKET: `t-${process.pid}`, KADAN_WINDOW: 'none', KADAN_NOTIFY: 'off'},
  });
  const before = snapshot(home);
  const bad = cli('update', KEY, '--revision', '1', '--next', 'x', '--note', '시험');
  assert.equal(bad.status, 2, bad.stdout);
  assert.match(bad.stderr, /--next /u);
  assert.equal(bad.stdout, '');
  assert.equal(snapshot(home), before);
  const ok = cli('update', KEY, '--revision', '1', '--next-action', 'x', '--note', '시험');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).nextAction, 'x');
});
