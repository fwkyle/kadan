#!/usr/bin/env node
// 재부팅·세션 유실 뒤 역할을 기억째 되살리기 위한 조사 도구.
// 읽기 전용이다. 아무것도 실행하지 않고 복구 명령만 출력한다.
//   사용: node scripts/recover-sessions.mjs [--since 2026-09-09] [--all]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {launchIdentityOf} from '../src/ai-identity.mjs';
import {conversationOf} from '../src/conversation-ref.mjs';
import {shellQuote} from '../src/mail-instructions.mjs';

const HOME = process.env.KADAN_HOME || path.join(os.homedir(), '.kadan');
const SESSIONS = path.join(os.homedir(), '.codex', 'sessions');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf('--' + name); return i < 0 ? null : (args[i + 1] || true); };
const since = typeof flag('since') === 'string' ? flag('since') : '2000-01-01';
const showAll = args.includes('--all');

function die(message) { console.error('오류: ' + message); process.exit(1); }

function startRecords() {
  const out = [];
  const db = path.join(HOME, 'kadan.sqlite');
  if (fs.existsSync(db)) {
    const res = spawnSync('sqlite3', ['-readonly', db, 'select payload from events'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (res.status !== 0) die('sqlite3 읽기 실패: ' + (res.stderr || '').trim());
    for (const line of (res.stdout || '').split('\n')) {
      if (!line.includes('"kind":"start"')) continue;
      try { const e = JSON.parse(line); if (e.kind === 'start') out.push(e); } catch {}
    }
  }
  if (!out.length) die('start 기록을 찾지 못했다(kadan.sqlite 없음 또는 start 없음). KADAN_HOME 을 확인하라: ' + HOME);
  const last = new Map();
  for (const e of out.sort((a, b) => String(a.t).localeCompare(String(b.t)))) last.set(e.role, e);
  return [...last.values()].filter((e) => String(e.t) >= since);
}

export function conversationMetas(root = SESSIONS) {
  const metas = [];
  const walk = (dir) => {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of names) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.jsonl')) continue;
      // 첫 줄(session_meta)은 시스템 지시문을 담아 수 MB까지 간다. 줄바꿈이 나올 때까지 읽는다.
      let head = '';
      try {
        const fd = fs.openSync(full, 'r');
        const chunk = Buffer.alloc(65536);
        let offset = 0, collected = '';
        while (offset < 8 * 1024 * 1024) {
          const n = fs.readSync(fd, chunk, 0, chunk.length, offset);
          if (n <= 0) break;
          collected += chunk.subarray(0, n).toString('utf8');
          offset += n;
          const nl = collected.indexOf('\n');
          if (nl >= 0) { collected = collected.slice(0, nl); break; }
        }
        fs.closeSync(fd);
        head = collected;
      } catch { continue; }
      try {
        const m = JSON.parse(head);
        if (m.type !== 'session_meta') continue;
        metas.push({ id: m.payload?.id ?? m.payload?.session_id, cwd: m.payload?.cwd,
          ts: m.payload?.timestamp, file: full });
      } catch {}
    }
  };
  walk(root);
  return metas;
}

function aliveSessions() {
  const res = spawnSync('tmux', ['-u', '-L', 'kadan', 'ls', '-F', '#{session_name}'], { encoding: 'utf8' });
  if (res.status !== 0) return new Set();
  return new Set((res.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean));
}

export function recoveryLine({role, cwd, cmd, id}) {
  if (!id) throw new Error('복구할 대화 ID가 확정되지 않음');
  const identity = launchIdentityOf(cmd);
  if (!identity.ok) throw new Error('원래 실행기·명시 모델·안전한 단일 명령을 확인할 수 없음');
  let command = cmd;
  if (identity.harness !== 'codex' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('이 조사 도구에서 확인한 Codex 대화 ID가 아님');
  }
  const previous = conversationOf(cmd);
  if (previous.conversationMode === 'new') command = `${cmd.trim()} resume ${shellQuote(id)}`;
  const next = conversationOf(command);
  if (next.conversationMode !== 'resume' || next.conversationRef !== id) {
    throw new Error('원래 옵션을 보존한 채 같은 대화로 복구할 수 없음');
  }
  return `cd ${shellQuote(cwd || '.')} && kadan start ${shellQuote(role)} --cmd ${shellQuote(command)}`;
}

function main() {
  const starts = startRecords();
  const metas = conversationMetas();
  const alive = aliveSessions();
  console.log('역할 ' + starts.length + '개 / 대화파일 ' + metas.length + '개 / 살아있는 세션 ' + alive.size + '개');
  console.log('원장 ' + HOME + '  ·  대화 ' + SESSIONS);
  console.log('');
  const lines = [];
  let ready = 0, ambiguous = 0, missing = 0, skipped = 0, blocked = 0;
  for (const e of starts.sort((a, b) => String(a.t).localeCompare(String(b.t)))) {
    const session = e.session || ('kadan-' + e.role);
    if (alive.has(session) && !showAll) { skipped += 1; continue; }
    const live = alive.has(session) ? '살아있음' : '죽음';
    const direct = conversationOf(e.cmd || '');
    let id = direct.conversationMode === 'resume' ? direct.conversationRef : null;
    let how = id ? '명령에 있음' : null;
    let others = [];
    if (!id && e.cwd && e.t) {
      const st = Date.parse(e.t);
      const near = metas
        .filter((m) => m.cwd === e.cwd && m.ts)
        .map((m) => Object.assign({}, m, { d: (Date.parse(m.ts) - st) / 1000 }))
        .filter((m) => m.d >= -5 && m.d <= 120)
        .sort((a, b) => Math.abs(a.d) - Math.abs(b.d));
      if (near.length === 1) { id = near[0].id; how = '폴더+시각 유일'; }
      else if (near.length > 1) { others = near.slice(0, 3); how = '후보 ' + near.length + '개 — 사람이 골라야 함'; }
      else how = '대화파일 못 찾음';
    }
    const row = {role: e.role, t: e.t, live, cwd: e.cwd, cmd: e.cmd, id, how, others};
    try { row.recovery = recoveryLine(row); }
    catch (error) { row.error = error.message; blocked += 1; }
    if (id && row.recovery) ready += 1;
    else if (others.length) ambiguous += 1;
    else if (!id) missing += 1;
    lines.push(row);
  }
  for (const r of lines) {
    console.log('[' + r.live + '] ' + r.role + '  (' + String(r.t).slice(0, 19).replace('T', ' ') + ' UTC)');
    console.log('    폴더 ' + (r.cwd || '모름'));
    console.log('    원래 ' + (r.cmd || '모름'));
    console.log('    대화 ' + (r.id || '모름') + '  [' + r.how + ']');
    for (const o of r.others) console.log('      후보 ' + o.id + ' (' + o.d.toFixed(1) + '초)');
    if (r.recovery) console.log('    복구> ' + r.recovery);
    else console.log('    복구 명령 보류: ' + r.error);
    console.log('');
  }
  console.log('되살릴 수 있음 ' + ready + ' / 후보 여럿 ' + ambiguous + ' / 대화 못 찾음 ' + missing +
    ' / 명령 보류 ' + blocked + (skipped ? ' / 살아있어 건너뜀 ' + skipped : ''));
  console.log('이 도구는 아무것도 실행하지 않는다. 위 복구 줄을 사람이 확인하고 직접 친다.');
  console.log('주의: 같은 폴더에서 몇 초 간격으로 띄운 역할은 구분되지 않는다. 그때는 ' + path.join(HOME, 'out') + ' 의 화면 기록으로 대조하라.');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();

