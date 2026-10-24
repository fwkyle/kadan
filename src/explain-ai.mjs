// 설명 AI: 발령·완료·막힘·결정 사건이 난 카드에만, 싼 AI를 한 번 불러 card brief 줄을 채운다(2026-10-15 [kyle] 승인).
// - 어떤 실행기를 쓰는지는 실행 모델 설정의 explain 칸과 실행기 표(runners.<실행기>.exec)가 정한다. 여기에는 실행기 이름이 없다.
// - 칸이 비었거나 1순위 실행기에 exec 틀이 없으면 아무것도 하지 않는다(실패 닫힘).
// - 칸을 처음 채운 시점(enabled 기록) 이후의 사건만 대상이다. 옛 카드를 한꺼번에 부르지 않는다.
// - 같은 입력 지문(inputHash)은 시도 한 차례(1순위 → 대체)만 한다. 시도 기록은 덧붙이기 전용 explain-ai.jsonl에 남고 입력이 바뀔 때만 다시 시도한다.
// - 감시 AI와 자리를 나누지 않는 별도 대기열(동시 1개, 시도당 상한)이며, 호출은 감시 순회를 기다리게 하지 않는다.
// 설명 AI는 감시 AI가 아니다. 판정·보고·알림을 하지 않고 brief 줄만 쓴다.
import fs from 'node:fs';
import {createExplainQueue} from './explain-queue.mjs';
import {createProcessCollections} from './process-collections.mjs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {CardStore} from './card-store.mjs';
import {buildCardCenter} from './card-center.mjs';
import {BriefStore, briefInput} from './human-brief.mjs';
import {readStream, appendStream} from './storage.mjs';
import {cardEvents} from './explain-events.mjs';
import {explainChain, readSettings} from './runner-settings.mjs';
import {execCommand} from './runner-table.mjs';
import {bindExec} from './exec-agent.mjs';
import {runJudgeProcess} from './watch-ai-process.mjs';
import {EXPLAIN_BY} from './actors.mjs';
import {answerText, buildExplainPrompt, decisionsByCard, envelopeState, parseBriefOutput} from './explain-input.mjs';
import {ATTEMPT_RESULTS, buildDiag, errnoOf, pick} from './explain-diag.mjs';

export const EXPLAIN_FILE = 'explain-ai.jsonl';
export const EXPLAIN_TIMEOUT_MS = 75_000;
export const EXPLAIN_MAX_PER_CYCLE = 3;
// 표준 출력·표준 오류를 모으는 바이트 상한. 넘으면 프로세스 묶음을 끝내고 사유만 남긴다(설명 AI 경로만).
export const EXPLAIN_MAX_OUTPUT_BYTES = 1024 * 1024;
// AI를 한 번이라도 부른 입력은 결과와 상관없이 "시도했다"로 센다(쓰기 성공 여부와 별개). 같은 입력으로 두 번 부르지 않는다.
const at = value => { const t = Date.parse(value); return Number.isFinite(t) ? t : 0; };
const handledKey = (key, id) => `${key}|${id}`;

export class ExplainAI {
  constructor({home, readSettings: read = () => readSettings(home), spawn = runJudgeProcess, now = Date.now,
    timeoutMs = EXPLAIN_TIMEOUT_MS, maxPerCycle = EXPLAIN_MAX_PER_CYCLE, print = () => {},
    collections = null}) {
    Object.assign(this, {home, read, spawn, now, timeoutMs, maxPerCycle, print});
    this.workDir = path.join(home, 'explain-ai-work');
    this.enabledAt = null;
    this.collections = collections ?? createProcessCollections();
    this.ownsCollections = !collections;
    this.handled = this.collections.set();
    this.attempted = this.collections.set();
    this.queue = createExplainQueue();
    this.staleQueued = 0;
    this.running = null;
    this.active = null;
    this.controller = new AbortController();
    this.context = null;
    this.loaded = false;
  }

  // 시작할 때 한 번만 시도 기록을 읽는다. 이후 기억은 이 프로세스 수명만 유지한다.
  load() {
    if (this.loaded) return;
    for (const row of readStream(this.home, EXPLAIN_FILE, {optional: true})) {
      if (row.kind === 'explain-state') this.enabledAt = row.state === 'enabled' ? at(row.at) : null;
      else if (row.kind === 'explain-call') {
        this.attempted.add(`${row.key}|${row.inputHash}`);
        for (const id of row.eventIds ?? []) this.handled.add(handledKey(row.key, id));
      }
    }
    this.loaded = true;
  }
  record(row) { appendStream(this.home, EXPLAIN_FILE, {by: EXPLAIN_BY, at: new Date(this.now()).toISOString(), ...row}); }
  chain() { try { return explainChain(this.read()); } catch { return null; } }

  // 원장·카드 읽기를 마친 감시 주기에서 부른다. 동기로 끝나고(대기열에 넣기까지), AI 호출은 뒤에서 따로 돈다.
  // cards: 카드 요약 목록(본문·이력 없음), entries: 카드 연결이 끝난 원장 사건, readEntries: 원장 원본, decisions: 결정 기록 목록.
  tick({cards, entries, readEntries, decisions = [], liveSessions = null, now = this.now()}) {
    this.load();
    const chain = this.chain();
    if (!chain) {
      // 칸을 비우면 대기열도 무효로 한다. 다시 켠 뒤 옛 사건이 실행되지 않게.
      this.queue.clear();
      if (this.enabledAt != null) { this.record({kind: 'explain-state', state: 'disabled'}); this.enabledAt = null; }
      return {state: 'off', queued: 0};
    }
    if (this.enabledAt == null) { this.record({kind: 'explain-state', state: 'enabled', chain: chain.map(({runner, model, effort}) => ({runner, model, effort}))}); this.enabledAt = now; }
    this.context = {readEntries, liveSessions};
    const grouped = decisionsByCard(decisions);
    const keys = new Set();
    for (const card of cards) if (at(card.at) >= this.enabledAt) keys.add(card.key);
    for (const e of entries.slice(-5000)) if (e.executionKey && ['send', 'done'].includes(e.kind) && at(e.t) >= this.enabledAt) keys.add(e.executionKey);
    for (const d of decisions) if (Math.max(at(d.at), at(d.answer?.at), at(d.cancelledAt)) >= this.enabledAt && typeof d.card === 'string') keys.add(d.card);
    let queued = 0;
    for (const card of this.center([...keys], now)) {
      // 대기열뿐 아니라 지금 호출 중인 카드도 다시 예약하지 않는다.
      if (queued >= this.maxPerCycle || this.active?.key === card.key) continue;
      const mine = grouped.get(card.key) ?? [];
      const events = cardEvents(card, mine, now).filter(e => e.at >= this.enabledAt && !this.handled.has(handledKey(card.key, e.id)));
      if (!events.length) continue;
      const {input, hash} = briefInput(card, mine, now);
      const ids = events.map(e => ({id: e.id, at: e.at}));
      let brief = null;
      try { brief = new BriefStore(this.home).read(card.key); } catch { /* 손상된 설명 기록은 건드리지 않고 이번엔 지나간다 */ continue; }
      if (this.attempted.has(`${card.key}|${hash}`) || (brief?.by === EXPLAIN_BY && brief.inputHash === hash)) {
        for (const {id} of ids) this.handled.add(handledKey(card.key, id));
        continue;
      }
      if (this.queue.enqueue({key: card.key, input, hash, ids, revision: card.revision,
        resultPath: card.result?.path ?? null, resultSha256: card.result?.sha256 ?? null})) queued++;
    }
    if (this.queue.length) this.pump();
    return {state: 'on', queued};
  }

  // 후보 카드 키 → 본문·이력이 있는 카드로 중앙 표시 상태(displayState·runs)까지 계산한다. 후보만 읽으므로 주기 비용이 작다.
  center(keys, now) {
    if (!keys.length) return [];
    const store = new CardStore(this.home), full = [];
    for (const key of keys) { try { full.push(store.get(key)); } catch { /* 없는 카드·손상은 건너뛴다 */ } }
    if (!full.length) return [];
    const {readEntries, liveSessions} = this.context;
    const tree = liveSessions ? [{roles: [...liveSessions].map(s => ({role: String(s).replace(/^kadan-/, ''), life: {state: 'alive', pidState: 'match'}}))}] : [];
    try { return buildCardCenter({cards: full, entries: readEntries(), tree, runtimeKnown: Boolean(liveSessions), now}).cards; }
    catch { return []; }
  }

  pump() {
    if (this.running) return this.running;
    this.running = (async () => {
      while (this.queue.length && !this.controller.signal.aborted) {
        let job = this.queue.take();
        // 꺼낼 때 지금 켜진 시점과 사건 시각을 다시 대조한다(그사이 꺼졌다 켜졌으면 옛 사건은 버린다).
        if (this.enabledAt == null) continue;
        job.ids = job.ids.filter(e => e.at >= this.enabledAt);
        if (!job.ids.length) continue;
        job = this.freshQueuedJob(job);
        if (!job) { this.staleQueued++; continue; }
        this.active = job;
        try { await this.run(job); } catch (error) { this.print(`[설명 AI] ${job.key} 처리 실패: ${error.message}`); }
        finally { this.active = null; }
      }
    })().finally(() => { this.running = null; });
    return this.running;
  }
  async drain() { while (this.running) await this.running; }
  async stop() {
    this.controller.abort();this.queue.clear();
    try {await this.drain();}
    finally {if (this.ownsCollections) this.collections.close();}
  }

  // 대기 중에 바뀐 입력에는 모델을 부르지 않는다. 다음 tick이 최신 입력을 예약한다.
  freshQueuedJob(job) {
    try {
      const now = this.now(), [card] = this.center([job.key], now);
      const decisions = decisionsByCard(readStream(this.home, 'decisions/events.jsonl', {optional: true}));
      if (!card) return null;
      const {input, hash} = briefInput(card, decisions.get(job.key) ?? [], now);
      if (hash !== job.hash) return null;
      return {...job, input, revision: card.revision,
        resultPath: card.result?.path ?? null, resultSha256: card.result?.sha256 ?? null};
    } catch { return null; } // 새 입력을 확인하지 못하면 오래된 입력을 실행하지 않는다.
  }

  async run(job) {
    const settings = this.read();
    const chain = explainChain(settings);
    if (!chain) return;
    // 호출 직전에 시도 기록을 다시 확인한다.
    if (this.attempted.has(`${job.key}|${job.hash}`)) return;
    // 결과 파일은 읽은 바이트의 sha256이 등록값과 같을 때만 발췌한다. 다르면 발췌를 빼고 그 사유를 입력에 적는다.
    let resultText = '', resultNote = '';
    if (job.resultPath) {
      try {
        const bytes = fs.readFileSync(job.resultPath);
        if (createHash('sha256').update(bytes).digest('hex') === job.resultSha256) resultText = bytes.toString('utf8');
        else resultNote = '결과 파일이 등록한 뒤에 바뀌어 발췌를 뺐다(등록 지문과 다름).';
      } catch { resultNote = '결과 파일을 읽을 수 없어 발췌를 뺐다.'; }
    }
    const prompt = buildExplainPrompt(job.input, resultText, resultNote);
    fs.mkdirSync(this.workDir, {recursive: true, mode: 0o700});
    const attempts = [];
    let parsed = null, outcome = 'failed', reason = null;
    for (const judge of chain) {
      if (this.controller.signal.aborted) return;
      const started = this.now();
      let seen = null;
      let attempt = {runner: judge.runner, model: judge.model, fallbackIndex: judge.fallbackIndex, result: 'call-failed'};
      try {
        // 도구 없는 에이전트로 묶어야 하는 실행기는 틀 검사와 에이전트 파일 쓰기가 끝난 뒤에만 부른다(실패하면 부르지 않고 다음 후보로).
        bindExec(settings, judge.runner, this.workDir);
        const {command, stdin, env, field} = execCommand(settings, judge.runner, {model: judge.model, effort: judge.effort ?? '', prompt, cwd: this.workDir});
        const res = await this.spawn(command, {input: stdin, timeout: this.timeoutMs, cwd: this.workDir, signal: this.controller.signal,
          reportComplete: () => false, maxBytes: EXPLAIN_MAX_OUTPUT_BYTES, env: {...process.env, ...env}});
        const stderr = String(res.stderr ?? '');
        seen = {stdout: res.stdout, stderr, exitCode: res.status, signal: res.signal};
        if (res.error?.code === 'ETIMEDOUT' || stderr.includes('KADAN_JUDGE_TIMEOUT=1')) attempt.result = 'timeout';
        else if (stderr.includes('KADAN_JUDGE_OUTPUT_LIMIT=1')) attempt.result = 'output-limit';
        else if (res.error || res.status !== 0) attempt.result = 'call-failed';
        else {
          const out = answerText(res.stdout, field);
          seen.envelope = envelopeState(res.stdout, field);
          seen.answer = out;
          parsed = parseBriefOutput(out);
          attempt.result = parsed.ok ? 'ok' : parsed.reason;
        }
      } catch { attempt.result = 'template-error'; }
      // 실패한 시도에는 출력 글자를 남기지 않고 구조만 남긴다(explain-diag.mjs). 성공 시도에는 아무것도 남기지 않는다.
      if (attempt.result !== 'ok' && seen) attempt.diag = buildDiag(seen);
      attempt.result = pick(ATTEMPT_RESULTS, attempt.result) ?? 'template-error';
      attempt.durationMs = this.now() - started;
      attempts.push(attempt);
      // 모델이 응답하지 못한 경우(시간 초과·호출 실패)와 형식 실패(not-json·field-rule:*)는 다음 대체 후보로 내려간다.
      // 체인을 한 바퀴만 돌고 같은 후보를 다시 부르지 않는다.
      const next = ['timeout', 'call-failed', 'template-error', 'not-json'].includes(attempt.result) || attempt.result.startsWith('field-rule:');
      if (!next) break;
    }
    if (parsed?.ok) {
      ({outcome, reason} = this.write(job, parsed.fields));
    } else reason = attempts.at(-1)?.result ?? 'no-attempt';
    this.record({kind: 'explain-call', key: job.key, inputHash: job.hash, eventIds: job.ids.map(e => e.id), outcome, ...(reason ? {reason} : {}), attempts});
    this.attempted.add(`${job.key}|${job.hash}`);
    for (const {id} of job.ids) this.handled.add(handledKey(job.key, id));
  }

  // revision이 어긋나면 오류가 아니라 생략이다. 카드를 다시 읽어 입력 지문이 그대로면 받은 답을 새 revision으로 쓰고(AI를 다시 부르지 않는다),
  // 달라졌으면 그 답을 버린다(stale). 어느 쪽이든 이 입력은 시도한 것으로 세고, 새 입력은 다음 사건 때 처리한다.
  write(job, fields) {
    const store = new BriefStore(this.home);
    const attempt = revision => store.write(job.key, {...fields, revision}, EXPLAIN_BY, {inputHash: job.hash});
    try { attempt(job.revision); return {outcome: 'written'}; }
    catch (error) {
      // 오류 메시지에는 읽던 글자가 섞일 수 있어 원장에 넣지 않는다. 고정 코드(와 시스템 오류 코드)만 남긴다.
      // 예외 객체는 칸마다 한 번씩만 읽고(접근 함수·Proxy가 읽을 때 던지거나 값이 바뀔 수 있다), 기록에는 목록 쪽 리터럴만 쓴다.
      let changed = false, errno;
      try { changed = typeof error?.message === 'string' && error.message.startsWith('카드 변경됨'); errno = changed ? undefined : errnoOf(error); } catch { changed = false; errno = undefined; }
      if (!changed) return {outcome: 'failed', reason: errno === undefined ? 'write-failed' : `write-failed:${errno}`};
    }
    try {
      const [card] = this.center([job.key], this.now());
      const decisions = decisionsByCard(readStream(this.home, 'decisions/events.jsonl', {optional: true})).get(job.key) ?? [];
      if (card && briefInput(card, decisions, this.now()).hash === job.hash) { attempt(card.revision); return {outcome: 'written', reason: 'rewrote-at-new-revision'}; }
    } catch { /* 다시 읽기 실패도 버림으로 둔다 */ }
    return {outcome: 'stale', reason: 'revision-changed'};
  }
}
