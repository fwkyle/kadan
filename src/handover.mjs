import {CardStore} from './card-store.mjs';
import {taskIdentity} from './task-identity.mjs';
import {storagePath,assertWritable} from './storage.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseHierarchy } from './hierarchy.mjs';
import { openTaskIds } from './handover-state.mjs';
import {startRoleProfile} from './role-instructions.mjs';
import { withHierarchyLock } from './hierarchy-lock.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const session = role => `kadan-${role}`;
const validRole = role => typeof role === 'string' && /^[\p{L}\p{N}_-]+$/u.test(role);
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// 관계표는 모든 판이 함께 쓰는 파일이다. 인계는 자기 줄만 대조하고 바꾼다:
// 선임 줄, 준비 때 선임 아래 있던 하위 줄, 후임 줄. 다른 판이 붙이거나 정리한 줄은 보지도 고치지도 않는다.
// 준비 때 선임의 상위·하위는 준비 스냅샷(originalHierarchy)에서 읽는다. 옛 상태 파일에도 있는 칸이다.
function preparedRoutes(s) {
  const original = JSON.parse(s.originalHierarchy);
  return { fromParent: original[s.from],
    children: Object.keys(original).filter(role => original[role] === s.from) };
}

// 쓰기 전 대조: 전환해도 되면 null, 안 되면 이유를 돌려준다.
// 선임의 하위가 정리로 빠진 것, 후임 자신의 줄(상위가 무엇이든), 후임 아래 새 하위는 막지 않는다.
export function routeBlock(table, s) {
  const { fromParent, children } = preparedRoutes(s);
  if (!Object.hasOwn(table, s.from)) return '선임 줄이 없음';
  if (table[s.from] !== fromParent) return `선임 상위가 ${fromParent}에서 ${table[s.from]}(으)로 바뀜`;
  const prepared = new Set(children);
  for (const [role, parent] of Object.entries(table)) {
    if (prepared.has(role)) {
      if (parent !== s.from) return `선임 하위 ${role}의 상위가 ${parent}(으)로 바뀜`;
    } else if (parent === s.from && role !== s.to) return `준비 뒤 선임 아래 새 하위 ${role}`;
  }
  return null;
}

// 전환: 선임 줄 자리에 후임 줄 하나(상위 = 선임의 상위)를 두고, 선임을 상위로 둔 줄만 후임으로 바꾼다.
// 후임이 시작할 때 등록된 줄은 먼저 뺀다. 남기면 같은 이름이 두 번 나오고, 선임 아래 등록됐다면 자기 자신을 가리킨다.
// routes는 abort가 이 줄들만 되돌릴 때 쓰는 쓰기 직전 값이다.
export function transferRoutes(table, s) {
  const routes = { fromParent: table[s.from], toBefore: table[s.to] ?? null, children: [] };
  const next = {};
  for (const [role, parent] of Object.entries(table)) {
    if (role === s.to) continue;
    if (role === s.from) { next[s.to] = routes.fromParent; continue; }
    if (parent === s.from) routes.children.push(role);
    next[role] = parent === s.from ? s.to : parent;
  }
  return { next, routes };
}

// 쓰기 뒤 대조: 이 인계의 줄이 전환된 그대로면 null, 누가 되돌렸거나 바꿨으면 이유를 돌려준다.
export function transferredBlock(table, s, routes) {
  if (Object.hasOwn(table, s.from)) return '선임 줄이 다시 생김';
  if (table[s.to] !== routes.fromParent) return `후임 상위가 ${routes.fromParent}이(가) 아님`;
  const moved = routes.children.find(role => Object.hasOwn(table, role) && table[role] !== s.to);
  return moved ? `옮긴 하위 ${moved}의 상위가 바뀜` : null;
}

// 원복: 전환 때 바꾼 줄만 되돌린다. 전환 뒤 후임 아래 새로 생긴 줄과 다른 판의 줄은 그대로 둔다.
export function revertRoutes(table, s, routes) {
  const moved = new Set(routes.children), next = {};
  for (const [role, parent] of Object.entries(table)) {
    if (role === s.to) {
      next[s.from] = routes.fromParent;
      if (routes.toBefore != null) next[s.to] = routes.toBefore;
    } else next[role] = moved.has(role) && parent === s.to ? s.from : parent;
  }
  return next;
}

// 관계표 잠금을 기다리는 횟수와 간격. 남의 등록은 수 ms만 쥐므로 잠깐이면 된다(등록 쪽도 2초를 기다린다).
const ROUTE_LOCK_TRIES = 20;
const ROUTE_LOCK_POLL_MS = 100;

export class Handover {
  // stopFields(역할): 선임을 끄기 직전에 stop 사건에 더할 칸(대화 번호 등)을 돌려준다. 던지지 않아야 한다.
  constructor({ home, floor, readEntries, record, start, send, closeWindow = () => ({}), stopFields = () => ({}),
    env = process.env, now = Date.now, sleep = pause, watchAlive = pid => { try { process.kill(Number(pid), 0); return true; } catch { return false; } } }) {
    Object.assign(this, { home, floor, readEntries, record, start, send, closeWindow, stopFields, env, now, sleep, watchAlive });
    this.dir = path.join(home, 'handovers');
  }
  entries() {
    const rows = this.readEntries();
    if (rows.some(e => e?.broken)) throw new Error('원장 손상: 인계 중단');
    return taskIdentity(new CardStore(this.home).list()).project(rows);
  }
  file(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('잘못된 인계 ID');
    return path.join(this.dir, `${id}.json`);
  }
  save(state) {
    const tmp = `${this.file(state.id)}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file(state.id));
  }
  status(id) { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')); }
  locked(fn) {
    assertWritable(this.home);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const lock = path.join(this.dir, '.lock');
    try { fs.mkdirSync(lock); } catch (cause) {
      if (cause.code !== 'EEXIST') throw cause;
      const error = new Error('인계 잠금 중: 다른 호출 또는 남은 잠금을 확인하라');
      error.code = 'HANDOVER_LOCKED'; throw error;
    }
    try { return fn(); }
    finally {
      // 실패 증거를 지우지 않고 빈 잠금도 보관한다. stale lock 자동 회수는 없다.
      fs.renameSync(lock, path.join(this.dir, `.released-${randomUUID()}`));
    }
  }
  identity(role, expected) {
    if (!this.floor.alive(session(role)) || String(this.floor.pid(session(role))) !== String(expected))
      throw new Error(`역할 생존/PID 불일치: ${role}`);
  }
  sourceIdentity(s) {
    if (!s.sourceEnded) return this.identity(s.from, s.oldPid);
    if (this.floor.alive(session(s.from))) throw new Error('종료된 선임이 다시 나타남: 인계 중단');
    const start = this.lastStart(s.from);
    if (String(start?.panePid ?? start?.rottiePid) !== String(s.oldPid)) throw new Error('선임 시작 기록 변경');
  }
  lastStart(role) {
    return this.entries().filter(e => e.kind === 'start' && e.role === role).at(-1);
  }
  graph(file) {
    const text = fs.readFileSync(file, 'utf8');
    const value = JSON.parse(text); parseHierarchy(value);
    return { text, value, hash: hash(text) };
  }
  // 전환 때 남긴 쓰기 직전 값. 이 칸이 없는 옛 routes-pending 상태는 준비 스냅샷에서 이끈다
  // (옛 코드는 후임 줄이 있으면 전환을 쓰지 못했으므로 그때 후임 줄은 없었다).
  routes(s) { return s.routes ?? { ...preparedRoutes(s), toBefore: null }; }
  // 관계표 읽기·대조·쓰기는 등록·정리와 같은 잠금(hierarchy-register.lock) 안에서만 한다. 잠금은 그 동안만 쥔다.
  // 경로는 실제 경로로 푼다: 링크 경로로 이름을 바꾸면 링크 자체가 파일로 바뀌고, 잠금 폴더도 달라질 수 있다.
  hierarchyLocked(s, run) {
    const file = fs.realpathSync(s.hierarchy);
    for (let attempt = 1; ; attempt++) {
      try { return withHierarchyLock(file, () => run(file)); }
      catch (cause) {
        if (cause.code !== 'HIERARCHY_LOCKED') throw cause;
        if (attempt >= ROUTE_LOCK_TRIES) {
          const error = new Error('관계표 쓰기 잠금을 얻지 못함: 관계표는 그대로, 선임 보존. ' +
            '남은 hierarchy-register.lock을 확인하고 같은 명령으로 다시 시도', { cause });
          error.code = 'HIERARCHY_LOCKED'; throw error;
        }
        this.sleep(ROUTE_LOCK_POLL_MS);
      }
    }
  }
  begin(from, { to, cmd, cwd, hierarchy, context, atBoundary = false, sourceEnded = false }) {
    return this.locked(() => {
      if (!atBoundary) throw new Error('--at-boundary 필요: 선임의 새 발령을 멈춘 카드 경계에서만 시작');
      if (!validRole(from) || !validRole(to) || from === to) throw new Error('서로 다른 유효 역할명이 필요하다');
      const previous = this.lastStart(from);
      if (!previous) throw new Error('선임 start 기록 없음');
      const roleProfile = startRoleProfile({home:this.home,role:from,profile:previous.roleProfile??undefined});
      const oldPid = previous.panePid ?? previous.rottiePid;
      if (oldPid == null) throw new Error('선임 PID 기록 없음');
      this.sourceIdentity({from, oldPid, sourceEnded});
      if (this.floor.alive(session(to)) || this.lastStart(to)) throw new Error('후임 이름이 사용 중이거나 과거 사용됨');
      if (previous.floor && previous.floor !== this.floor.name) throw new Error('실행 바닥 불일치');
      const command = cmd ?? previous.cmd;
      const directory = cwd ?? previous.cwd;
      if (!command || typeof command !== 'string') throw new Error('--cmd 필요: 실행 명령을 추측하지 않는다');
      if (!directory || !path.isAbsolute(directory) || !fs.statSync(directory).isDirectory())
        throw new Error('--cwd에 실제 절대경로가 필요하다');
      if (!hierarchy || !path.isAbsolute(hierarchy)) throw new Error('--hierarchy 절대경로 필요');
      if (!context || !path.isAbsolute(context) || !fs.statSync(context).isFile())
        throw new Error('--context에 현재 승인/작업 기준 파일 절대경로 필요');
      const graph = this.graph(hierarchy);
      if (!(from in graph.value) || to in graph.value) throw new Error('선임 관계가 없거나 후임 관계가 이미 있음');
      for (const name of fs.readdirSync(this.dir).filter(n => n.endsWith('.json'))) {
        const other = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        if (!['complete', 'aborted'].includes(other.phase) && [other.from, other.to].some(r => [from, to].includes(r)))
          throw new Error(`겹치는 인계가 있다: ${other.id}`);
      }
      const id = randomUUID();
      const state = { id, sourceEnded, phase: 'preparing', from, to, oldPid: String(oldPid), command, cwd: directory,
        ...(roleProfile?{roleProfile}:{}),
        hierarchy, originalHierarchy: graph.text, originalHash: graph.hash,
        context, contextHash: hash(fs.readFileSync(context)), taskIds: openTaskIds(this.entries(), from),
        createdAt: new Date(this.now()).toISOString() };
      this.save(state);
      const packet = path.join(this.dir, `${id}.md`);
      fs.writeFileSync(packet, `# 인수 확인 ${id}\n\n선임: ${from}\n후임: ${to}\n작업공간: ${directory}\n` +
        `원장: ${storagePath(this.home)}\n현재 승인/기준: ${context}\n` +
        `인계할 미완료 카드: ${JSON.stringify(state.taskIds)}\n관계표: ${hierarchy}\n\n` +
        '카드·결과·원장을 읽고 다음 행동을 확인하라. 이 문서는 새 구현/배포 승인이 아니다.\n' +
        '독립적으로 확인한 근거 파일 경로와 다음 행동을 JSON에 적어라: {"taskIds":[],"evidencePaths":[],"nextAction":"..."}.\n' +
        `KADAN_ROLE=${to} kadan handover accept ${id} --receipt <절대경로> 로 인수를 확인한 뒤 응답을 끝내라.\n` +
        '전환 완료 편지 전에는 카드 발령·구현·관계 변경·선임 종료를 하지 않는다.\n', { mode: 0o600 });
      try {
      this.start(to, command, directory, roleProfile);
      const successor = this.lastStart(to);
      state.newPid = String(successor?.panePid ?? successor?.rottiePid ?? '');
      this.identity(to, state.newPid);
      state.phase = 'prepared'; state.packet = packet; this.save(state);
      this.record({ kind: 'handover', phase: 'prepared', handoverId: id, from, to, taskIds: state.taskIds });
      this.send(to, `인수 준비: ${packet} 를 읽고 accept 후 입력 대기. 전환 완료 전 새 작업 금지.`, state.newPid);
      return state;
      } catch (error) {
        state.error = error.message; this.save(state);
        throw new Error(`인계 ${id} 중단, 선임 보존: ${error.message}`);
      }
    });
  }
  accept(id, receipt) {
    return this.locked(() => {
      const s = this.status(id);
      if (this.env.KADAN_ROLE !== s.to) throw new Error('인수 확인은 지정 후임 역할에서 실행');
      this.identity(s.to, s.newPid);
      if (s.phase === 'accepted') return s;
      if (s.phase !== 'prepared') throw new Error(`인수 확인 불가: ${s.phase}`);
      if (!receipt || !path.isAbsolute(receipt)) throw new Error('인수 근거 절대경로 필요');
      const bytes = fs.readFileSync(receipt); const data = JSON.parse(bytes);
      if (!Array.isArray(data.taskIds) || JSON.stringify([...data.taskIds].sort()) !== JSON.stringify(s.taskIds) ||
          !Array.isArray(data.evidencePaths) || !data.evidencePaths.length ||
          typeof data.nextAction !== 'string' || !data.nextAction.trim()) throw new Error('미완료 카드·읽은 근거·다음 행동을 확인해야 한다');
      for (const file of data.evidencePaths) if (typeof file !== 'string' || !path.isAbsolute(file) || !fs.statSync(file).isFile())
        throw new Error('읽은 근거 파일이 없음');
      s.receipt = receipt; s.receiptHash = hash(bytes); s.phase = 'accepted'; this.save(s);
      this.record({ kind: 'handover', phase: 'accepted', handoverId: id, from: s.from, to: s.to, receipt });
      return s;
    });
  }
  finish(id, { timeout = 90 } = {}) {
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 300) throw new Error('timeout은 0~300초');
    return this.locked(() => {
      const s = this.status(id);
      if (s.phase === 'complete') return s;
      if (this.env.KADAN_ROLE === s.from) throw new Error('선임 자기 종료 금지: 외부 지휘자가 finish 실행');
      if (!['accepted', 'routes-pending', 'transferred', 'stopped'].includes(s.phase)) throw new Error(`후임 인수 확인 전 종료 불가: ${s.phase}`);
      this.identity(s.to, s.newPid);
      if (!['transferred', 'stopped'].includes(s.phase)) {
        this.sourceIdentity(s);
        if (hash(fs.readFileSync(s.context)) !== s.contextHash || hash(fs.readFileSync(s.receipt)) !== s.receiptHash)
          throw new Error('승인/인수 근거 변경: 선임 보존, 재확인 필요');
        if (JSON.stringify(openTaskIds(this.entries(), s.from)) !== JSON.stringify(s.taskIds))
          throw new Error('선임 미완료 카드 변경: 선임 보존, 재인계 필요');
      }
      if (s.phase === 'accepted') {
        // 잠금 안에서 지금 파일을 다시 읽어 이 인계의 줄만 대조하고 바꾼다. 준비 뒤 다른 판이 붙인 줄은 그대로 남는다.
        // 잠금을 못 얻으면 routes-pending을 저장하기 전에 실패한다.
        this.hierarchyLocked(s, file => {
          const g = this.graph(file);
          const block = routeBlock(g.value, s);
          if (block) throw new Error(`관계표가 준비 후 변경됨(${block}): 선임 보존`);
          const { next, routes } = transferRoutes(g.value, s);
          parseHierarchy(next);
          const text = JSON.stringify(next, null, 2) + '\n';
          s.routes = routes; s.routesHash = hash(text); s.phase = 'routes-pending'; this.save(s);
          const tmp = `${file}.${id}.tmp`;
          fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, file);
        });
      }
      if (s.phase === 'routes-pending') {
        const file = fs.realpathSync(s.hierarchy), routes = this.routes(s);
        // 감시기 사건에는 경로·지문·PID만 있다. 그래서 "인계가 직접 읽어 이 인계의 줄이 전환된 상태임을 확인한 내용"의
        // 지문을 모아 두고(routeHashes), 살아 있는 감시기가 같은 파일에서 그중 하나를 읽은 사건이 있어야 넘어간다.
        // 전환 뒤 다른 판이 줄을 붙이면 감시기는 새 지문을 적으므로, 기다리는 동안 파일을 다시 읽어 지문을 더한다.
        // 다시 부른 finish가 이어가도록 새 지문은 상태 파일에 남긴다.
        const confirmed = new Set([s.routesHash, ...(s.routeHashes ?? [])]);
        const confirm = () => {
          const text = fs.readFileSync(file, 'utf8'), seen = hash(text);
          if (confirmed.has(seen)) return;
          const value = JSON.parse(text); parseHierarchy(value);
          const block = transferredBlock(value, s, routes);
          if (block) throw new Error(`인계 관계표 변경(${block}): 선임 보존`);
          confirmed.add(seen); s.routeHashes = [...confirmed]; this.save(s);
        };
        // 감시기가 적는 경로와 인계 상태의 경로는 링크 때문에 글자가 다를 수 있다. 실제 경로로 같은 파일인지 본다.
        const same = new Map();
        const sameFile = recorded => {
          if (!same.has(recorded)) {
            let real = null;
            try { real = fs.realpathSync(recorded); } catch { /* 없는 경로는 같은 파일이 아니다 */ }
            same.set(recorded, real === file);
          }
          return same.get(recorded);
        };
        const loaded = () => this.entries().some(e => e.kind === 'hierarchy-loaded' && confirmed.has(e.hash) &&
          typeof e.path === 'string' && sameFile(e.path) && this.watchAlive(e.pid));
        const started = this.now();
        for (;;) {
          confirm();
          if (loaded()) break;
          if (this.now() - started >= timeout * 1000) return { ...s, waiting: 'watch 관계표 반영 확인 대기; 선임 유지' };
          this.sleep(200);
        }
        this.identity(s.to, s.newPid); this.sourceIdentity(s);
        confirm();
        if (hash(fs.readFileSync(s.context)) !== s.contextHash || hash(fs.readFileSync(s.receipt)) !== s.receiptHash)
          throw new Error('대기 중 승인/근거 변경: 선임 보존');
        if (JSON.stringify(openTaskIds(this.entries(), s.from)) !== JSON.stringify(s.taskIds)) throw new Error('대기 중 카드 변경: 선임 보존');
        this.record({ kind: 'handover', phase: 'transferred', handoverId: id, from: s.from, to: s.to, taskIds: s.taskIds });
        s.phase = 'transferred'; this.save(s);
      }
      if (s.phase === 'transferred') {
        // 끄기 직전에 선임의 대화 번호를 찾아 stop 사건에 남긴다(못 찾아도 끈다). 이미 꺼져 있으면 찾을 수 없다.
        let found = { conversationMissing: 'session-gone' };
        if (this.floor.alive(session(s.from))) {
          this.sourceIdentity(s);
          try { found = this.stopFields(s.from); } catch { found = { conversationMissing: 'error' }; }
          this.sourceIdentity(s);
          this.floor.stop(session(s.from));
        }
        if (this.floor.alive(session(s.from))) throw new Error('선임 종료 미확인: 후임 활성화 보류');
        this.record({ kind: 'stop', role: s.from, session: session(s.from), handoverId: id, ...found,
          ...this.closeWindow(this.lastStart(s.from)) });
        s.phase = 'stopped'; this.save(s);
      }
      // 전송 실패/불확실 이후 finish 재호출로 같은 활성화를 중복 전송하지 않는다.
      s.phase = 'activation-pending'; this.save(s);
      this.send(s.to, `인계 전환 완료: ${id}. 선임 ${s.from} 종료·미완료 카드 ${JSON.stringify(s.taskIds)} 인수. ${s.context} 승인 범위에서 이어가라.`, s.newPid);
      // 직접 보고하는 하위도 새 수신자를 알아야 한다. 기존 카드의 승인 범위는 바꾸지 않는다.
      s.childNotices = [];
      const original = JSON.parse(s.originalHierarchy);
      for (const [child,parent] of Object.entries(original)) {
        if (parent !== s.from || !this.floor.alive(session(child))) continue;
        try { this.send(child, `직속 감독 인계: ${s.from} → ${s.to}, 인계 ${id}. 앞으로 질문·완료 통지는 ${s.to}에게 보내라. 기존 카드·승인 범위 유지.`); s.childNotices.push({role:child,sent:true}); }
        catch (error) { s.childNotices.push({role:child,sent:false,error:error.message}); }
      }
      s.phase = 'complete'; this.save(s);
      this.record({ kind: 'handover', phase: 'complete', handoverId: id, from: s.from, to: s.to, taskIds: s.taskIds });
      return s;
    });
  }
  abort(id) {
    return this.locked(() => {
      const s = this.status(id);
      if (s.phase === 'aborted') return s;
      if (['transferred','stopped','activation-pending','complete'].includes(s.phase)) throw new Error('책임 이전 후 abort 불가: 현재 후임으로 복구');
      this.sourceIdentity(s);
      // 전환을 쓰기 전(routes-pending 앞)이면 인계가 관계표를 고친 적이 없다. 다른 판이 줄을 붙였어도 건드리지 않는다.
      if (s.phase === 'routes-pending') this.hierarchyLocked(s, file => {
        const g = this.graph(file), routes = this.routes(s);
        const changed = transferredBlock(g.value, s, routes);
        if (!changed) {
          // 전환 때 바꾼 줄만 되돌린다. 되돌린 표가 깨지면(예: 줄이 없던 후임 아래 새 하위) 쓰지 않는다.
          const next = revertRoutes(g.value, s, routes);
          try { parseHierarchy(next); }
          catch (cause) { throw new Error(`관계표 충돌(${cause.message}): 자동 원복 금지`, { cause }); }
          const tmp = `${file}.${id}.abort`;
          fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file);
        } else if (routeBlock(g.value, s)) throw new Error(`관계표 충돌(${changed}): 자동 원복 금지`);
        // 그 밖은 선임 줄이 준비 때 그대로다: 전환을 쓰기 전에 멈춘 것이라 되돌릴 것이 없다.
      });
      s.phase = 'aborted'; this.save(s);
      this.record({ kind: 'handover', phase:'aborted', handoverId:id, from:s.from,to:s.to });
      return {...s, warning:'후임은 자동 삭제하지 않음. watch 원복 확인 뒤 선임 재개; 후임의 역할/작업 상태를 확인해 따로 정리'};
    });
  }
}
