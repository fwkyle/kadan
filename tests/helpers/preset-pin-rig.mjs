// work-preset-pin 시험의 공통 재료: 격리 홈·가짜 실행기·격리 tmux CLI·카드 발령 도우미.
// 실제 agy/claude/codex를 실행하지 않고 격리 홈 안의 잠만 자는 가짜 스크립트만 쓴다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {WorkStore} from '../../src/work-store.mjs';
import {CardStore} from '../../src/card-store.mjs';
import {DEFAULT_FAMILIES} from '../../src/runner-settings.mjs';
import {guardedSend} from '../../src/cli-guarded-send.mjs';
import {appendLedger, readLedger} from '../../src/ledger.mjs';

const CLI = new URL('../../src/cli.mjs', import.meta.url).pathname;
export const hasTmux = spawnSync('tmux', ['-V']).status === 0;
export const SETTINGS_FILE = 'runner-settings.json';

// 활성 B(codex 작업자·claude 검수자, 작업자 대체 후보 1개)와 C(agy 작업자·claude 다른 모델 검수자).
export function makeSettings() {
  return {
    version: 1, revision: 1, activePreset: 'B',
    families: {...DEFAULT_FAMILIES, gemini: ['gemini-', 'google/gemini-']},
    runners: {
      agy: {spawn: 'agy --model {model} --dangerously-skip-permissions', models: [{model: 'gemini-4-neon-high', efforts: []}]},
      claude: {
        spawn: 'claude --model {model} --effort {effort} --dangerously-skip-permissions',
        models: [{model: 'claude-fable-5-2', efforts: ['high']}, {model: 'claude-sonnet-5-5', efforts: ['high']}],
      },
      codex: {
        spawn: 'codex -p lite --model {model} -c model_reasoning_effort={effort}',
        models: [{model: 'gpt-6-sol', efforts: ['high']}, {model: 'gpt-6-astra', efforts: ['high']}],
      },
    },
    presets: {
      B: {
        label: '기본',
        roles: {
          worker: {runner: 'codex', model: 'gpt-6-sol', effort: 'high'},
          reviewer: {runner: 'claude', model: 'claude-sonnet-5-5', effort: 'high'},
        },
        fallback: {worker: [{runner: 'codex', model: 'gpt-6-astra', effort: 'high'}]},
      },
      C: {
        label: '바꿔 볼 프리셋',
        roles: {
          worker: {runner: 'agy', model: 'gemini-4-neon-high'},
          reviewer: {runner: 'claude', model: 'claude-fable-5-2', effort: 'high'},
        },
      },
    },
    blocked: [],
  };
}

export const writeSettings = (home, settings = makeSettings()) =>
  fs.writeFileSync(path.join(home, SETTINGS_FILE), JSON.stringify(settings, null, 2));

export function makeHome({withSettings = true} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-preset-pin-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-preset-pin-repo-'));
  if (withSettings) writeSettings(home);
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['agy', 'claude', 'codex']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexec sleep 120\n', {mode: 0o755});
  }
  return {home, repo, bin};
}

export const workFields = repo => ({title: '업무', goal: '목표', scope: '범위', acceptance: '조건', owner: 'boss', 'repo-path': repo, board: '판'});

// 격리 소켓(-L)의 tmux로 실제 CLI를 돌린다. TMUX/TMUX_PANE은 지운다.
export function cliRig(name, {home, repo, bin}) {
  const socket = `kadan-pin-${name}-${process.pid}-${Date.now()}`;
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, KADAN_HOME: home, KADAN_SOCKET: socket, KADAN_FLOOR: 'tmux',
    KADAN_WINDOW: 'none', KADAN_NOTIFY: 'off', KADAN_ALT_CHECK_MS: '0', KADAN_TRUST_TRIES: '1', KADAN_TRUST_INTERVAL_MS: '1',
  };
  delete env.TMUX;
  delete env.TMUX_PANE;
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], {env, cwd: repo, encoding: 'utf8', timeout: 15000});
  const ok = (...args) => {
    const r = run(...args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    return r;
  };
  const cleanup = () => {
    console.log(`격리 소켓 kill-server: ${socket}`);
    spawnSync('tmux', ['-L', socket, 'kill-server'], {env});
  };
  return {env, socket, run, ok, cleanup};
}

export const startOf = (home, role) => readLedger(home).filter(e => e.kind === 'start' && e.role === role && e.cmd).at(-1);

// 업무에 연결한 배정 카드 한 장.
export function makeCard(home, repo, id, role, step, workKey) {
  const cards = new CardStore(home), works = new WorkStore(home);
  const card = cards.create({repo: 'pin', id, repoPath: repo, body: '# 지시'});
  cards.update(card.key, {status: 'assigned', role, board: '판', scope: '범위',
    rallyId: 'w', rallyTitle: '고정', rallyRound: '1', rallyStep: step}, {revision: 1, note: '배정'});
  if (workKey) {
    const current = works.get(workKey);
    works.change(workKey, 'link', {execution: card.key, phase: step, round: 1}, {revision: current.revision, by: 'boss', note: '연결'});
  }
  return card;
}

// 실제 발령 입구(guardedSend)로 카드를 보낸다. 바닥만 가짜다(살아 있고 PID가 시작 기록과 같다고 답한다).
export function sendCard(home, card, start, workKey) {
  const warnings = [], original = console.error;
  console.error = (...args) => warnings.push(args.join(' '));
  try {
    const entry = guardedSend({
      floor: {name: 'fake', alive: () => true, pid: () => String(start.panePid), send: () => ({})},
      session: start.session, role: start.role, message: '카드 수행', taskId: card.id, recordedPid: String(start.panePid),
      mailContext: workKey ? {workKey, executionKey: card.key} : undefined,
      env: {...process.env, KADAN_HOME: home}, readEntries: () => readLedger(home),
      record: e => appendLedger(e, home), saveBody: () => {},
    });
    return {entry, warnings};
  } finally { console.error = original; }
}
