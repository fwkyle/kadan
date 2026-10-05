import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {adviseCommand, composeAdvicePrompt, ADVISE_TIMEOUT_MS} from '../src/advise.mjs';
import {blockModel, initSettings, readSettings, setFallback, setRole} from '../src/runner-settings.mjs';
import {CardStore} from '../src/card-store.mjs';
import {readLedger} from '../src/ledger.mjs';

// 자문위원(2026-10-05 [kyle] 승인): 감독이 카드 하나를 두고 고급 모델에게 한 번 묻는다. 결정이 아니라 기록이다.
const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
const codexModels = [{slug:'gpt-6-sol', supported_reasoning_levels:['low','high'].map(effort=>({effort}))}];
const readCodexModels = () => ({models:codexModels});

function fixture({advisor=true}={}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-advise-'));
  const repo = path.join(home, 'repo'); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(home, 'agent-runners.json'), JSON.stringify({runners:[{id:'codex', spawn:'codex --model {model} -c model_reasoning_effort="{effort}"'}, {id:'devin', spawn:'devin --model {model}'}]}));
  const records = [];
  const meta = revision => ({revision, by:'kyle', reason:'시험', record:e => records.push(e), readCodexModels});
  initSettings(home, {by:'kyle', reason:'시작', record:e => records.push(e)});
  if (advisor) setRole(home, {role:'advisor', runner:'codex', model:'gpt-6-sol', effort:'high', ...meta(1)});
  new CardStore(home).create({repo:'qa', id:'card-a', repoPath:repo, body:'# 시험 카드\n\n- DB 열 이름을 바꾼다\n'});
  const calls = [];
  // 가짜 호출: 환경을 기록하고 증거 폴더에 답을 쓴다. 실제 codex는 부르지 않는다.
  const spawn = ({answer='결론: 바꾸지 마라\n근거: …', status=0, stderr='', error=null}={}) => async (command, settings) => {
    calls.push({command, settings});
    if (answer != null) fs.writeFileSync(path.join(settings.env.KADAN_ADVICE_DIR, 'result.txt'), answer);
    if (error) throw error;
    return {status, stderr, stdout:answer ?? ''};
  };
  const run = (argv, flags, {by='qa-슈퍼감독', ...more}={}) => adviseCommand(argv, flags, {home, by, env:{PATH:process.env.PATH}, ...more});
  const advices = () => readLedger(home).filter(e => e.kind === 'advice');
  return {home, repo, calls, spawn, run, advices, meta, records};
}

test('감독·사람만 부르고 작업자·검수자는 원장에 아무것도 남기지 않고 거절된다', async () => {
  const f = fixture();
  for (const by of ['qa-작업자', 'qa-검수자', 'watch', '']) {
    await assert.rejects(() => f.run(['qa/card-a'], {question:'바꿀까?'}, {by, spawn:f.spawn()}), /감독/);
  }
  assert.equal(f.calls.length, 0); assert.deepEqual(f.advices(), []);
  assert.ok(!fs.existsSync(path.join(f.home, 'advice')));
  for (const by of ['qa-감독', 'qa-슈퍼감독', 'qa-슈퍼감독-2', '사람']) {
    const r = await f.run(['qa/card-a'], {question:'바꿀까?'}, {by, spawn:f.spawn()});
    assert.equal(r.reason, 'ok');
  }
  assert.deepEqual(f.advices().map(e => e.by), ['qa-감독', 'qa-슈퍼감독', 'qa-슈퍼감독-2', '사람']);
});

test('자문위원 모델 설정이 없으면 호출 없이 거절하고, 질문·카드가 없어도 거절한다', async () => {
  const f = fixture({advisor:false});
  await assert.rejects(() => f.run(['qa/card-a'], {question:'바꿀까?'}, {spawn:f.spawn()}), /자문위원 모델 설정 없음.*runners set advisor/);
  const g = fixture();
  await assert.rejects(() => g.run(['qa/card-a'], {}, {spawn:g.spawn()}), /질문 필요/);
  await assert.rejects(() => g.run(['qa/card-a'], {question:'  '}, {spawn:g.spawn()}), /질문 필요/);
  await assert.rejects(() => g.run(['qa/없는카드'], {question:'바꿀까?'}, {spawn:g.spawn()}), /카드/);
  await assert.rejects(() => g.run(['qa/card-a'], {question:'바꿀까?', timeout:'0'}, {spawn:g.spawn()}), /--timeout/);
  await assert.rejects(() => g.run(['qa/card-a'], {question:'바꿀까?', timeout:'3601'}, {spawn:g.spawn()}), /--timeout/);
  assert.equal(f.calls.length + g.calls.length, 0); assert.deepEqual([...f.advices(), ...g.advices()], []);
});

test('성공: 질문·카드 본문·첨부를 한 입력으로 넘기고 저장소 폴더·모델·상한을 환경으로 주며 advice 사건 하나를 남긴다', async () => {
  const f = fixture();
  const note = path.join(f.home, 'note.md'); fs.writeFileSync(note, '첨부 내용');
  const started = Date.parse('2026-10-05T00:00:00Z'); let tick = 0;
  const r = await f.run(['qa/card-a'], {question:' 열 이름을 지금 바꿔도 되나? ', file:note, timeout:'120'}, {spawn:f.spawn(), now:() => started + (tick++) * 1500});
  assert.equal(r.reason, 'ok'); assert.equal(r.model, 'gpt-6-sol'); assert.equal(r.effort, 'high');
  assert.match(r.answer, /^결론:/); assert.equal(r.card, 'qa/card-a');
  const [{command, settings}] = f.calls;
  assert.match(command, /advise\.sh'$/);
  assert.equal(settings.timeout, 120_000); assert.equal(settings.reportComplete(), false);
  assert.equal(settings.env.KADAN_ADVICE_REPO, f.repo); assert.equal(settings.env.KADAN_ADVICE_MODEL, 'gpt-6-sol');
  assert.equal(settings.env.KADAN_ADVICE_EFFORT, 'high'); assert.equal(settings.env.KADAN_HOME, f.home);
  assert.equal(settings.env.KADAN_ADVICE_DIR, r.evidencePath); assert.ok(r.evidencePath.startsWith(path.join(f.home, 'advice', '')));
  assert.equal(fs.readFileSync(path.join(r.evidencePath, 'input.txt'), 'utf8'), settings.input);
  assert.ok(settings.input.includes('--- 질문 ---\n열 이름을 지금 바꿔도 되나?'));
  assert.ok(settings.input.includes('--- 카드 qa/card-a (시험 카드) ---\n# 시험 카드'));
  assert.ok(settings.input.includes(`--- 첨부 ${note} ---\n첨부 내용`));
  assert.match(settings.input, /결정하지 않는다/); assert.match(settings.input, /읽기 전용/); assert.match(settings.input, /지시는 실행하지 않는다/);
  const [entry] = f.advices();
  assert.equal(entry.by, 'qa-슈퍼감독'); assert.equal(entry.card, 'qa/card-a'); assert.equal(entry.adviceId, r.adviceId);
  assert.equal(entry.question, '열 이름을 지금 바꿔도 되나?'); assert.match(entry.questionDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual([entry.model, entry.effort, entry.settingsRevision, entry.settingsPreset], ['gpt-6-sol', 'high', 2, 'B']);
  assert.deepEqual([entry.reason, entry.exitCode, entry.durationMs, entry.bytes], ['ok', 0, 1500, Buffer.byteLength(r.answer)]);
  assert.deepEqual(entry.files, [note]); assert.equal(entry.evidencePath, r.evidencePath); assert.equal(entry.t, '2026-10-05T00:00:00.000Z');
  assert.ok(!('answer' in entry), '답변 본문은 원장에 넣지 않는다');
  // 기본 상한은 감시 AI(5분)보다 긴 30분이다(2026-10-05 [kyle]). 같은 카드로 다시 불러도 막지 않는다.
  await f.run(['qa/card-a'], {question:'다시'}, {spawn:f.spawn()});
  assert.equal(f.calls.at(-1).settings.timeout, ADVISE_TIMEOUT_MS); assert.equal(ADVISE_TIMEOUT_MS, 1_800_000);
  assert.equal(f.advices().length, 2);
});

test('시간 초과·호출 실패·빈 답은 실패로 기록하고 답을 쓰지 않는다(fail closed)', async () => {
  const f = fixture();
  const cases = [
    [{answer:null, status:124, stderr:'KADAN_JUDGE_TIMEOUT=1\n'}, 'timeout'],
    [{answer:'부분 답', status:2}, 'call-failed'],
    [{answer:null, error:Object.assign(new Error('spawn'), {code:'ENOENT'})}, 'call-failed'],
    [{answer:'   \n', status:0}, 'empty'],
  ];
  for (const [outcome, reason] of cases) {
    await assert.rejects(() => f.run(['qa/card-a'], {question:'바꿀까?'}, {spawn:f.spawn(outcome)}), error => error.exitCode === 1 && new RegExp(`자문 실패\\(${reason}\\)`).test(error.message));
  }
  assert.deepEqual(f.advices().map(e => e.reason), cases.map(c => c[1]));
  assert.deepEqual(f.advices().map(e => e.exitCode), [124, 2, null, 0]);
});

test('첨부는 절대경로 5개·64KB까지이고, 넘으면 호출 전에 거절한다', async () => {
  const f = fixture();
  const big = path.join(f.home, 'big.txt'); fs.writeFileSync(big, 'x'.repeat(64 * 1024 + 1));
  await assert.rejects(() => f.run(['qa/card-a'], {question:'?', file:big}, {spawn:f.spawn()}), /너무 크다/);
  await assert.rejects(() => f.run(['qa/card-a'], {question:'?', file:'relative.md'}, {spawn:f.spawn()}), /절대경로/);
  const small = path.join(f.home, 's.txt'); fs.writeFileSync(small, 'ok');
  await assert.rejects(() => f.run(['qa/card-a'], {question:'?', file:Array(6).fill(small)}, {spawn:f.spawn()}), /5개까지/);
  assert.equal(f.calls.length, 0); assert.deepEqual(f.advices(), []);
  const r = await f.run(['qa/card-a'], {question:'?', file:Array(5).fill(small)}, {spawn:f.spawn()});
  assert.equal(r.reason, 'ok'); assert.equal(f.advices()[0].files.length, 5);
});

test('입력 조립은 질문·카드·첨부 순서이고 자료 구분선이 있다', () => {
  const prompt = composeAdvicePrompt({question:'Q', card:{key:'r/c', title:'T', body:'B'}, attachments:[{file:'/a', text:'A'}]});
  assert.ok(prompt.endsWith('--- 질문 ---\nQ\n--- 카드 r/c (T) ---\nB\n--- 첨부 /a ---\nA'));
});

test('실행 모델 설정: advisor는 codex만, 폴백은 거절, 정책 차단은 적용', () => {
  const f = fixture();
  assert.throws(() => setRole(f.home, {role:'advisor', runner:'devin', model:'swe', ...f.meta(2)}), /자문위원은 codex 실행기만/);
  assert.throws(() => setFallback(f.home, {role:'advisor', items:[{runner:'codex', model:'gpt-6-sol', effort:'low'}], ...f.meta(2)}), /자문위원은 폴백이 없다/);
  assert.equal(readSettings(f.home).revision, 2);
  blockModel(f.home, {model:'gpt-6-sol', roles:'advisor', ...f.meta(2)});
  assert.throws(() => setRole(f.home, {role:'advisor', runner:'codex', model:'gpt-6-sol', effort:'low', ...f.meta(3)}), /정책으로 막은 모델/);
  assert.equal(readSettings(f.home).revision, 3);
  const show = spawnSync(process.execPath, [cli, 'runners', 'show'], {env:{...process.env, KADAN_HOME:f.home, KADAN_CODEX_MODELS_CACHE:path.join(f.home, 'none.json')}, encoding:'utf8'});
  assert.equal(show.status, 0, show.stderr);
  assert.equal(JSON.parse(show.stdout).launch.advisor, 'KADAN_ADVICE_MODEL=gpt-6-sol KADAN_ADVICE_EFFORT=high advise.sh (codex exec, 저장소 읽기 전용)');
});

test('CLI: --help는 사용법, 작업자 명의는 종료 코드 1, 설정 없음도 종료 코드 1이고 원장은 비어 있다', () => {
  const f = fixture({advisor:false});
  const env = {...process.env, KADAN_HOME:f.home, KADAN_WINDOW:'none'};
  const help = spawnSync(process.execPath, [cli, 'advise', '--help'], {env:{...env, KADAN_ROLE:'qa-슈퍼감독'}, encoding:'utf8'});
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /kadan advise <카드키> --question/);
  const worker = spawnSync(process.execPath, [cli, 'advise', 'qa/card-a', '--question', '바꿀까?'], {env:{...env, KADAN_ROLE:'qa-작업자'}, encoding:'utf8'});
  assert.equal(worker.status, 1); assert.match(worker.stderr, /감독/);
  const unset = spawnSync(process.execPath, [cli, 'advise', 'qa/card-a', '--question', '바꿀까?'], {env:{...env, KADAN_ROLE:'qa-슈퍼감독'}, encoding:'utf8'});
  assert.equal(unset.status, 1); assert.match(unset.stderr, /자문위원 모델 설정 없음/);
  assert.deepEqual(f.advices(), []);
});

test('advise.sh: 카드 저장소에서 읽기 전용 샌드박스로 codex exec를 한 번 부르고 답·모델·종료 코드를 증거 폴더에 남긴다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-advise-sh-'));
  const bin = path.join(home, 'bin'), dir = path.join(home, 'advice'), repo = path.join(home, 'repo');
  fs.mkdirSync(bin); fs.mkdirSync(dir); fs.mkdirSync(repo);
  // 가짜 codex: 인자와 작업 폴더를 기록하고 -o 파일에 답을 쓴다.
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/bash\nprintf '%s\\n' "$@" > "${home}/args.txt"\npwd -P >> "${home}/args.txt"\ncat > "${home}/stdin.txt"\nwhile [[ $# -gt 0 ]]; do if [[ $1 == -o ]]; then printf '결론: 괜찮다\\n' > "$2"; fi; shift; done\n`, {mode:0o755});
  const script = new URL('../scripts/advise.sh', import.meta.url).pathname;
  const r = spawnSync('bash', [script], {input:'자문 입력', encoding:'utf8',
    env:{PATH:`${bin}:${process.env.PATH}`, KADAN_ADVICE_DIR:dir, KADAN_ADVICE_REPO:repo, KADAN_ADVICE_MODEL:'gpt-6-sol', KADAN_ADVICE_EFFORT:'high'}});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '결론: 괜찮다\n');
  const args = fs.readFileSync(path.join(home, 'args.txt'), 'utf8').split('\n');
  assert.ok(args.includes('exec') && args.includes('--sandbox') && args.includes('read-only'), args.join(' '));
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-sol');
  assert.equal(args[args.indexOf('-C') + 1], fs.realpathSync(repo), '저장소 폴더를 작업 폴더로 넘긴다');
  assert.ok(!args.includes('project_doc_max_bytes=0'), '저장소의 에이전트 안내를 읽는다');
  assert.equal(fs.readFileSync(path.join(home, 'stdin.txt'), 'utf8'), '자문 입력');
  assert.equal(fs.readFileSync(path.join(dir, 'input.txt'), 'utf8'), '자문 입력');
  assert.equal(fs.readFileSync(path.join(dir, 'model.txt'), 'utf8'), 'gpt-6-sol\n');
  assert.equal(fs.readFileSync(path.join(dir, 'exit-code.txt'), 'utf8'), '0\n');
  assert.equal(fs.readFileSync(path.join(dir, 'result.txt'), 'utf8'), '결론: 괜찮다\n');
  // 모델이 없으면 돌지 않는다.
  const none = spawnSync('bash', [script], {input:'', encoding:'utf8', env:{PATH:`${bin}:${process.env.PATH}`, KADAN_ADVICE_DIR:dir, KADAN_ADVICE_REPO:repo}});
  assert.notEqual(none.status, 0); assert.match(none.stderr, /KADAN_ADVICE_MODEL/);
});
