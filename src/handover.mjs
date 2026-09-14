import {CardStore} from './card-store.mjs';
import {taskIdentity} from './task-identity.mjs';
import {storageMode,storagePath,assertWritable} from './storage.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseHierarchy } from './hierarchy.mjs';
import { openTaskIds } from './handover-state.mjs';
import {startRoleProfile} from './role-instructions.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const session = role => `kadan-${role}`;
const validRole = role => typeof role === 'string' && /^[\p{L}\p{N}_-]+$/u.test(role);
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export class Handover {
  constructor({ home, floor, readEntries, record, start, send, closeWindow = () => ({}),
    env = process.env, now = Date.now, sleep = pause, watchAlive = pid => { try { process.kill(Number(pid), 0); return true; } catch { return false; } } }) {
    Object.assign(this, { home, floor, readEntries, record, start, send, closeWindow, env, now, sleep, watchAlive });
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
        `원장: ${storageMode(this.home)==='sqlite'?storagePath(this.home):path.join(this.home, 'ledger.jsonl')}\n현재 승인/기준: ${context}\n` +
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
        const g = this.graph(s.hierarchy);
        if (g.hash !== s.originalHash) throw new Error('관계표가 준비 후 변경됨: 선임 보존');
        const next = Object.fromEntries(Object.entries(g.value).map(([role, parent]) =>
          [role === s.from ? s.to : role, parent === s.from ? s.to : parent]));
        parseHierarchy(next);
        const text = JSON.stringify(next, null, 2) + '\n';
        s.routesHash = hash(text); s.phase = 'routes-pending'; this.save(s);
        const tmp = `${s.hierarchy}.${id}.tmp`; fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, s.hierarchy);
      }
      if (s.phase === 'routes-pending') {
        if (this.graph(s.hierarchy).hash !== s.routesHash) throw new Error('인계 관계표 변경: 선임 보존');
        const started = this.now();
        const loaded = () => this.entries().some(e => e.kind === 'hierarchy-loaded' && e.path === s.hierarchy && e.hash === s.routesHash && this.watchAlive(e.pid));
        while (!loaded()) {
          if (this.now() - started >= timeout * 1000) return { ...s, waiting: 'watch 관계표 반영 확인 대기; 선임 유지' };
          this.sleep(200);
        }
        this.identity(s.to, s.newPid); this.sourceIdentity(s);
        if (this.graph(s.hierarchy).hash !== s.routesHash || hash(fs.readFileSync(s.context)) !== s.contextHash ||
            hash(fs.readFileSync(s.receipt)) !== s.receiptHash) throw new Error('대기 중 관계/승인/근거 변경: 선임 보존');
        if (JSON.stringify(openTaskIds(this.entries(), s.from)) !== JSON.stringify(s.taskIds)) throw new Error('대기 중 카드 변경: 선임 보존');
        this.record({ kind: 'handover', phase: 'transferred', handoverId: id, from: s.from, to: s.to, taskIds: s.taskIds });
        s.phase = 'transferred'; this.save(s);
      }
      if (s.phase === 'transferred') {
        if (this.floor.alive(session(s.from))) { this.sourceIdentity(s); this.floor.stop(session(s.from)); }
        if (this.floor.alive(session(s.from))) throw new Error('선임 종료 미확인: 후임 활성화 보류');
        this.record({ kind: 'stop', role: s.from, session: session(s.from), handoverId: id,
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
      const g = this.graph(s.hierarchy);
      if (g.hash !== s.originalHash) {
        if (s.phase !== 'routes-pending' || g.hash !== s.routesHash) throw new Error('관계표 충돌: 자동 원복 금지');
        const tmp = `${s.hierarchy}.${id}.abort`; fs.writeFileSync(tmp, s.originalHierarchy, {mode:0o600}); fs.renameSync(tmp,s.hierarchy);
      }
      s.phase = 'aborted'; this.save(s);
      this.record({ kind: 'handover', phase:'aborted', handoverId:id, from:s.from,to:s.to });
      return {...s, warning:'후임은 자동 삭제하지 않음. watch 원복 확인 뒤 선임 재개; 후임의 역할/작업 상태를 확인해 따로 정리'};
    });
  }
}
