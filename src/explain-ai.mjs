// 설명 AI: 발령·완료·막힘·결정 사건이 난 카드에만, 싼 AI를 한 번 불러 card brief 줄을 채운다(2026-10-15 [kyle] 승인).
// - 어떤 실행기를 쓰는지는 실행 모델 설정의 explain 칸과 실행기 표(runners.<실행기>.exec)가 정한다. 여기에는 실행기 이름이 없다.
// - 칸이 비었거나 1순위 실행기에 exec 틀이 없으면 아무것도 하지 않는다(실패 닫힘).
// - 칸을 처음 채운 시점(enabled 기록) 이후의 사건만 대상이다. 옛 카드를 한꺼번에 부르지 않는다.
// - 같은 입력 지문(inputHash)은 시도 한 차례(1순위 → 대체)만 한다. 시도 기록은 덧붙이기 전용 explain-ai.jsonl에 남고 입력이 바뀔 때만 다시 시도한다.
// - 감시 AI와 자리를 나누지 않는 별도 대기열(동시 1개, 시도당 상한)이며, 호출은 감시 순회를 기다리게 하지 않는다.
// 설명 AI는 감시 AI가 아니다. 판정·보고·알림을 하지 않고 brief 줄만 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import {CardStore} from './card-store.mjs';
import {buildCardCenter} from './card-center.mjs';
import {BriefStore, briefInput} from './human-brief.mjs';
import {readStream, appendStream} from './storage.mjs';
import {cardEvents} from './explain-events.mjs';
import {explainChain, readSettings} from './runner-settings.mjs';
import {execCommand} from './runner-table.mjs';
import {runJudgeProcess} from './watch-ai-process.mjs';
import {EXPLAIN_BY} from './actors.mjs';
import {answerText, buildExplainPrompt, decisionsByCard, parseBriefOutput} from './explain-input.mjs';

export const EXPLAIN_FILE = 'explain-ai.jsonl';
export const EXPLAIN_TIMEOUT_MS = 75_000;
export const EXPLAIN_MAX_PER_CYCLE = 3;
// 이 결과만 "그 입력은 이미 시도했다"로 센다. 카드가 바뀌어 쓰지 못한 경우(revision-skip)는 다음 사건에 다시 본다.
const SETTLED = new Set(['written', 'failed']);
const at = value => { const t = Date.parse(value); return Number.isFinite(t) ? t : 0; };
const handledKey = (key, id) => `${key}|${id}`;

export class ExplainAI {
  constructor({home, readSettings: read = () => readSettings(home), spawn = runJudgeProcess, now = Date.now,
    timeoutMs = EXPLAIN_TIMEOUT_MS, maxPerCycle = EXPLAIN_MAX_PER_CYCLE, print = () => {}}) {
    Object.assign(this, {home, read, spawn, now, timeoutMs, maxPerCycle, print});
    this.workDir = path.join(home, 'explain-ai-work');
    this.enabledAt = null;
    this.handled = new Set();
    this.attempted = new Set();
    this.queue = [];
    this.running = null;
    this.controller = new AbortController();
    this.context = null;
    this.loaded = false;
  }

  // 시작할 때 한 번만 시도 기록을 읽는다. 이 프로세스만 쓰므로 이후는 메모리를 따른다.
  load() {
    if (this.loaded) return;
    for (const row of readStream(this.home, EXPLAIN_FILE, {optional: true})) {
      if (row.kind === 'explain-state') this.enabledAt = row.state === 'enabled' ? at(row.at) : null;
      else if (row.kind === 'explain-call' && SETTLED.has(row.outcome)) {
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
      if (this.enabledAt != null) { this.record({kind: 'explain-state', state: 'disabled'}); this.enabledAt = null; }
      return {state: 'off', queued: 0};
    }
    if (this.enabledAt == null) { this.record({kind: 'explain-state', state: 'enabled', chain: chain.map(({runner, model, effort}) => ({runner, model, effort}))}); this.enabledAt = now; }
    this.context = {readEntries, liveSessions};
    const grouped = decisionsByCard(decisions);
    const keys = new Set();
    for (const card of cards) if (at(card.at) >= this.enabledAt) keys.add(card.key);
    for (const e of entries.slice(-5000)) if (e.executionKey && ['send', 'done'].includes(e.kind) && at(e.t) >= this.enabledAt) keys.add(e.executionKey);
    for (const d of decisions) if (Math.max(at(d.at), at(d.answer?.at), at(d.cancelledAt)) >= this.enabledAt) keys.add(d.card);
    let queued = 0;
    for (const card of this.center([...keys], now)) {
      if (queued >= this.maxPerCycle || this.queue.some(j => j.key === card.key)) continue;
      const mine = grouped.get(card.key) ?? [];
      const events = cardEvents(card, mine, now).filter(e => e.at >= this.enabledAt && !this.handled.has(handledKey(card.key, e.id)));
      if (!events.length) continue;
      const {input, hash} = briefInput(card, mine, now);
      const ids = events.map(e => e.id);
      let brief = null;
      try { brief = new BriefStore(this.home).read(card.key); } catch { /* 손상된 설명 기록은 건드리지 않고 이번엔 지나간다 */ continue; }
      if (this.attempted.has(`${card.key}|${hash}`) || (brief?.by === EXPLAIN_BY && brief.inputHash === hash)) {
        for (const id of ids) this.handled.add(handledKey(card.key, id));
        continue;
      }
      this.queue.push({key: card.key, input, hash, ids, revision: card.revision, resultPath: card.result?.path ?? null});
      queued++;
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
        const job = this.queue.shift();
        try { await this.run(job); } catch (error) { this.print(`[설명 AI] ${job.key} 처리 실패: ${error.message}`); }
      }
    })().finally(() => { this.running = null; });
    return this.running;
  }
  async drain() { while (this.running) await this.running; }
  async stop() { this.controller.abort(); this.queue.length = 0; await this.drain(); }

  async run(job) {
    const settings = this.read();
    const chain = explainChain(settings);
    if (!chain) return;
    let resultText = '';
    if (job.resultPath) try { resultText = fs.readFileSync(job.resultPath, 'utf8'); } catch { /* 결과 파일이 없으면 발췌 없이 */ }
    const prompt = buildExplainPrompt(job.input, resultText);
    fs.mkdirSync(this.workDir, {recursive: true, mode: 0o700});
    const attempts = [];
    let parsed = null, outcome = 'failed', reason = null;
    for (const judge of chain) {
      if (this.controller.signal.aborted) return;
      const started = this.now();
      let attempt = {runner: judge.runner, model: judge.model, fallbackIndex: judge.fallbackIndex, result: 'call-failed'};
      try {
        const {command, stdin, field} = execCommand(settings, judge.runner, {model: judge.model, effort: judge.effort ?? '', prompt, cwd: this.workDir});
        const res = await this.spawn(command, {input: stdin, timeout: this.timeoutMs, cwd: this.workDir, signal: this.controller.signal,
          reportComplete: () => false, env: {...process.env}});
        const stderr = String(res.stderr ?? '');
        if (res.error?.code === 'ETIMEDOUT' || stderr.includes('KADAN_JUDGE_TIMEOUT=1')) attempt.result = 'timeout';
        else if (res.error || res.status !== 0) attempt.result = 'call-failed';
        else {
          const out = answerText(res.stdout, field);
          parsed = parseBriefOutput(out);
          attempt.result = parsed.ok ? 'ok' : parsed.reason;
          attempt.outputBytes = Buffer.byteLength(String(res.stdout ?? ''));
        }
      } catch (error) { attempt.result = 'template-error'; attempt.error = error.message; }
      attempt.durationMs = this.now() - started;
      attempts.push(attempt);
      // 모델이 응답하지 못한 경우(시간 초과·호출 실패)만 대체 후보로 내려간다. 응답이 JSON이 아니거나 규칙을 어기면 거기서 끝이다.
      if (!['timeout', 'call-failed', 'template-error'].includes(attempt.result)) break;
    }
    if (parsed?.ok) {
      ({outcome, reason} = this.write(job, parsed.fields));
    } else reason = attempts.at(-1)?.result ?? 'no-attempt';
    this.record({kind: 'explain-call', key: job.key, inputHash: job.hash, eventIds: job.ids, outcome, ...(reason ? {reason} : {}), attempts});
    if (SETTLED.has(outcome)) {
      this.attempted.add(`${job.key}|${job.hash}`);
      for (const id of job.ids) this.handled.add(handledKey(job.key, id));
    }
  }

  // revision이 어긋나면 오류가 아니라 생략이다. 다만 그사이 입력(지문)이 그대로면 새 revision으로 한 번 더 쓴다(AI를 다시 부르지 않는다).
  write(job, fields) {
    const store = new BriefStore(this.home);
    const attempt = revision => store.write(job.key, {...fields, revision}, EXPLAIN_BY, {inputHash: job.hash});
    try { attempt(job.revision); return {outcome: 'written'}; }
    catch (error) {
      if (!String(error.message).startsWith('카드 변경됨')) return {outcome: 'failed', reason: `write:${error.message}`};
    }
    try {
      const [card] = this.center([job.key], this.now());
      const decisions = decisionsByCard(readStream(this.home, 'decisions/events.jsonl', {optional: true})).get(job.key) ?? [];
      if (card && briefInput(card, decisions, this.now()).hash === job.hash) { attempt(card.revision); return {outcome: 'written', reason: 'rewrote-at-new-revision'}; }
    } catch { /* 다시 읽기 실패도 생략으로 둔다 */ }
    return {outcome: 'revision-skip', reason: 'revision-changed'};
  }
}
