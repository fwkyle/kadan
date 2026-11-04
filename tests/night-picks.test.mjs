import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {nightCommand} from '../src/commands/night.mjs';
import {CardStore} from '../src/card-store.mjs';
import {buildNightMessage} from '../src/night.mjs';

// 가짜 TODO 파일·격리 홈만 쓴다. 서버·tmux·운영 홈에 닿지 않는다.
const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
const TODO = [
  '# TODO', // 1
  '', // 2
  '## 지금 할 일', // 3
  '- [ ] **좋은 일감** [밤 허용] (2026-11-03 [kyle]) — Why: 불편을 줄인다', // 4
  '  - 확인: `npm test` 통과', // 5
  '- [ ] **Why 없음** [밤 허용]', // 6
  '  - 확인: 파일 존재', // 7
  '- [ ] **확인 없음** [밤 허용] — Why: 이유', // 8
  '- [ ] **열린 질문** [밤 허용] — Why: 이유', // 9
  '  - 확인: 명령 결과', // 10
  '  - 확인할 것: 어느 쪽으로 할지', // 11
  '- [ ] **시작 조건** [밤 허용] — Why: 이유', // 12
  '  - 확인: 명령 결과', // 13
  '  - 시작 조건: HW-1 머지 뒤', // 14
  '- [ ] **후보만** [밤 허용 후보] — Why: 이유', // 15
  '- [x] **끝난 것** [밤 허용] — Why: 이유', // 16
  '  - 확인: 끝', // 17
  '- [ ] **태그 없음** — Why: 이유', // 18
  '  - 확인: 끝', // 19
  '- [ ] **본문 중간** 설명 [밤 허용] — Why: 이유', // 20
  '  - 확인: 끝', // 21
  '', // 22
  '## 나중에 검토 · 카드 아님', // 23
  '- [ ] **구역 제외** [밤 허용] — Why: 이유', // 24
  '  - 확인: 끝', // 25
  '', // 26
  '```', // 27
  '- [ ] **예시 울타리** [밤 허용] — Why: 이유', // 28
  '```', // 29
].join('\n');

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-night-picks-'));
  const todo = path.join(home, 'TODO.md');
  fs.writeFileSync(todo, TODO);
  const run = (flags, deps = {}) => nightCommand(['picks'], flags, {home, by: '사람', deps});
  return {home, todo, run};
}
const titles = rows => rows.map(r => r.title);

test('1. Why·확인이 있는 [밤 허용] 항목은 후보로 나오고 줄 번호가 맞다', () => {
  const f = fixture();
  const r = f.run({todo: f.todo, json: true});
  assert.deepEqual(r.picks, [{file: f.todo, line: 4, title: '좋은 일감'}]);
});

test('2. 흐린 항목은 건너뜀과 이유가 나온다', () => {
  const f = fixture();
  const {skipped} = f.run({todo: f.todo, json: true});
  const by = t => skipped.find(s => s.title === t);
  assert.match(by('Why 없음').reasons.join(), /Why: 없음/);
  assert.match(by('확인 없음').reasons.join(), /확인: 없음/);
  assert.match(by('열린 질문').reasons.join(), /확인할 것: 열린 질문/);
  assert.doesNotMatch(by('열린 질문').reasons.join(), /확인: 없음/); // "확인할 것:"은 확인 방법이 아니다
  assert.match(by('시작 조건').reasons.join(), /시작 조건 있음, 슈퍼감독이 확인/);
  assert.match(by('구역 제외').reasons.join(), /일감 구역이 아님/);
  assert.equal(by('Why 없음').line, 6);
});

test('3. [밤 허용 후보]는 후보 묶음에만 나온다', () => {
  const f = fixture();
  const r = f.run({todo: f.todo, json: true});
  assert.deepEqual(titles(r.candidates), ['후보만']);
  assert.equal(r.candidates[0].line, 15);
  assert.ok(![...r.picks, ...r.skipped].some(x => x.title === '후보만'));
});

test('4. 끝난 항목·태그 없음·본문 중간 글자·코드 울타리 안 예시는 나오지 않는다', () => {
  const f = fixture();
  const r = f.run({todo: f.todo, json: true});
  const all = titles([...r.picks, ...r.skipped, ...r.candidates]);
  for (const t of ['끝난 것', '태그 없음', '본문 중간', '예시 울타리']) assert.ok(!all.includes(t), t);
});

test('5. ready·미배정 카드만 나오고 assigned·draft는 나오지 않는다', () => {
  const f = fixture();
  const store = new CardStore(f.home);
  const mk = (id, title) => store.create({repo: 'r', id, repoPath: f.home, title, body: `# ${title}`, by: '사람'});
  const ready = mk('c-ready', '준비됨'), assigned = mk('c-assigned', '배정됨'); mk('c-draft', '초안');
  const r1 = store.update(ready.key, {status: 'ready', scope: '로컬만'}, {revision: 1, note: '승인'});
  assert.ok(r1);
  const r2 = store.update(assigned.key, {status: 'ready', scope: '로컬만'}, {revision: 1, note: '승인'});
  store.update(assigned.key, {status: 'assigned', role: 'x', board: 'b', rallyId: 'r1', rallyTitle: 't', rallyRound: '1', rallyStep: 'implementation'}, {revision: r2.revision, note: '배정'});
  const r = f.run({todo: f.todo, json: true});
  assert.deepEqual(r.readyCards, [{key: 'r/c-ready', title: '준비됨', repo: 'r'}]);
});

test('6. --todo 없음·상대경로는 종료 코드 2, 없는 파일은 읽지 못함으로 나오고 나머지는 계속 읽는다', () => {
  const f = fixture();
  assert.throws(() => f.run({}), e => e.exitCode === 2 && /--todo가 필요/.test(e.message));
  assert.throws(() => f.run({todo: true}), e => e.exitCode === 2);
  assert.throws(() => f.run({todo: 'TODO.md'}), e => e.exitCode === 2 && /절대경로/.test(e.message));
  const missing = path.join(f.home, 'none.md');
  const r = f.run({todo: [missing, f.todo], json: true});
  assert.equal(r.unreadable.length, 1);
  assert.equal(r.unreadable[0].file, missing);
  assert.equal(r.picks.length, 1);
  assert.match(f.run({todo: [missing, f.todo]}), /읽지 못함 1건/);
});

test('7. 명령 전후로 TODO 내용·수정 시각과 홈 파일 목록이 그대로다(읽기 전용)', () => {
  const f = fixture();
  const before = {text: fs.readFileSync(f.todo, 'utf8'), mtime: fs.statSync(f.todo).mtimeMs, files: fs.readdirSync(f.home).sort()};
  const text = f.run({todo: f.todo});
  assert.match(text, /읽기 전용, 쓰지 않음/);
  assert.match(text, /슈퍼감독이 판단/);
  assert.equal(fs.readFileSync(f.todo, 'utf8'), before.text);
  assert.equal(fs.statSync(f.todo).mtimeMs, before.mtime);
  assert.deepEqual(fs.readdirSync(f.home).sort(), before.files);
});

test('8. 자동 단계 지침에 night picks가 있고 --only-running에서는 없다', () => {
  const args = {text: '밤', quote: '', viaChat: false, by: '사람', untilMs: Date.parse('2026-11-04T22:00:00Z'), level: '자동'};
  assert.match(buildNightMessage({...args, onlyRunning: false}), /\(10\) 새 일감은 `kadan night picks --todo/);
  const only = buildNightMessage({...args, onlyRunning: true});
  assert.doesNotMatch(only, /night picks/);
  assert.match(only, /\(10\) 새 일감을 시작하지 않습니다/);
});

test('CLI: 꺼진 상태에서도 동작하고 --json은 네 묶음 키를 낸다, --todo 없으면 종료 2', () => {
  const f = fixture();
  const env = {...process.env, KADAN_HOME: f.home, KADAN_WINDOW: 'none'};
  delete env.TMUX;
  const ok = spawnSync(process.execPath, [CLI, 'night', 'picks', '--todo', f.todo, '--json'], {env, encoding: 'utf8'});
  assert.equal(ok.status, 0, ok.stderr);
  const json = JSON.parse(ok.stdout);
  assert.deepEqual(Object.keys(json).sort(), ['candidates', 'picks', 'readyCards', 'skipped', 'unreadable']);
  assert.equal(json.picks.length, 1);
  const bad = spawnSync(process.execPath, [CLI, 'night', 'picks'], {env, encoding: 'utf8'});
  assert.equal(bad.status, 2);
});
