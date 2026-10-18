// codex 전역 Stop 훅의 신뢰 상태를 읽기만 한다 (2026-10-18 [kyle] 승인; 실측은 result.md 단계 1).
// - 설치: `$CODEX_HOME/hooks.json`(없으면 ~/.codex) Stop 배열 어딘가에 우리 명령이 있다. 위치(그룹 g, 그 안의 훅 h)는 읽어서 찾는다.
// - 신뢰: `config.toml`의 [hooks.state."<hooks.json 절대경로>:stop:<g>:<h>"]에 trusted_hash가 있다.
// 한계(실측): 훅 명령 문자열이 바뀌어도 config.toml은 그대로 남고 codex가 다음 시작 때 다시 묻는다. 그래서 여기서는
// '항목이 있는가'까지만 안다 — trusted_hash를 계산하거나 비교하지 않는다. 설정 내용은 돌려주지도 기록하지도 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {HOOK_SCRIPT, hookCommand} from './stop-hook-settings.mjs';

export const codexHome = (env = process.env) => env.CODEX_HOME || path.join(os.homedir(), '.codex');
export const codexHookCommand = (script = HOOK_SCRIPT) => hookCommand(script);

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

// 돌려주는 값: {state, key?}. state ∈
//   'no-hooks-file' | 'unreadable' — hooks.json이 없다/읽을 수 없다
//   'not-installed'  — Stop 배열에 우리 명령이 없다
//   'other-path'     — scripts/stop-hook.sh 명령은 있지만 이 체크아웃의 경로가 아니다
//   'untrusted'      — 설치돼 있지만 [hooks.state]에 그 키의 trusted_hash가 없다
//   'trusted'        — 키와 trusted_hash가 있다
//   'unknown'        — 명령을 안전하게 인용할 수 없거나 [hooks.state] 표기를 읽을 수 없다(미신뢰로 단정하지 않는다)
export function codexStopHookTrust({home = codexHome(), script = HOOK_SCRIPT} = {}) {
  const hooksFile = path.join(home, 'hooks.json');
  const raw = readText(hooksFile);
  if (raw == null) return {state: 'no-hooks-file'};
  let groups;
  try { groups = JSON.parse(raw)?.hooks?.Stop; } catch { return {state: 'unreadable'}; }
  if (!Array.isArray(groups)) return {state: 'not-installed'};
  let want;
  try { want = codexHookCommand(script); } catch { return {state: 'unknown'}; }
  let found = null, otherPath = false;
  groups.forEach((group, g) => (Array.isArray(group?.hooks) ? group.hooks : []).forEach((hook, h) => {
    if (typeof hook?.command !== 'string') return;
    if (hook.command === want && !found) found = {g, h};
    else if (/scripts\/stop-hook\.sh['"]?$/.test(hook.command)) otherPath = true;
  }));
  if (!found) return {state: otherPath ? 'other-path' : 'not-installed'};
  const key = `${hooksFile}:stop:${found.g}:${found.h}`;
  const config = readText(path.join(home, 'config.toml')) ?? '';
  const table = trustTable(config, key);
  if (table.trusted) return {state: 'trusted', key};
  return {state: table.found || !table.unreadable ? 'untrusted' : 'unknown', key};
}

// config.toml의 [hooks.state."<키>"] 표를 읽는다. 큰따옴표(이스케이프)·작은따옴표 키, 점 주변 공백, 줄 끝 주석을 같은 키로 본다.
// [hooks.state…]로 시작하지만 이 모양이 아닌 헤더(점으로 이은 키 등)가 있으면 unreadable — 그때 항목이 안 보여도 미신뢰로 단정하지 않는다.
const HEADER = /^\s*\[\s*hooks\s*\.\s*state\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]\s*(?:#.*)?$/;
function trustTable(config, key) {
  let inTarget = false, inPlain = false, found = false, trusted = false, unreadable = false;
  for (const line of config.split('\n')) {
    if (/^\s*\[/.test(line)) {
      inTarget = false;
      inPlain = /^\s*\[\s*hooks\s*\.\s*state\s*\]\s*(?:#.*)?$/.test(line);
      const match = line.match(HEADER);
      if (match) {
        let name = match[2];
        if (name === undefined) { try { name = JSON.parse(`"${match[1]}"`); } catch { unreadable = true; continue; } }
        if (name === key) { inTarget = true; found = true; }
      } else if (/^\s*\[\s*hooks\s*\.\s*state\s*\./.test(line)) unreadable = true;
    } else if (inPlain && line.trim() && !line.trim().startsWith('#')) unreadable = true; // [hooks.state] 안의 점으로 이은 키 등
    else if (inTarget && /^\s*trusted_hash\s*=\s*(?:"sha256:[0-9a-f]+"|'sha256:[0-9a-f]+')/.test(line)) trusted = true;
  }
  return {found, trusted, unreadable};
}

const STATE_TEXT = {
  'no-hooks-file': 'codex hooks.json이 없다',
  unreadable: 'codex hooks.json을 읽을 수 없다',
  'not-installed': 'codex hooks.json Stop 배열에 카단 훅이 없다',
  'other-path': 'codex hooks.json에 다른 체크아웃 경로의 카단 훅만 있다',
  untrusted: 'codex가 카단 훅을 아직 신뢰하지 않았다(config.toml [hooks.state]에 항목 없음)',
  unknown: 'codex 훅 신뢰 상태를 읽지 못했다(config.toml 표기를 해석할 수 없음) — 미신뢰라고 단정하지 않는다',
};

// 감시 경보. 설치(claude 설정 파일)를 시작한 기계에서만, 신뢰가 아닌 상태일 때만 낸다. 같은 상태는 id가 같아 한 번만 알려진다.
export function assessStopHookTrust({enabled, trust}) {
  if (!enabled || !trust || trust.state === 'trusted') return [];
  return [{id: `stop-hook:${trust.state}`, kind: '훅신뢰', level: 'AMBER', state: trust.state,
    text: STATE_TEXT[trust.state] ?? trust.state}];
}
