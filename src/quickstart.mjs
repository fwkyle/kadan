// kadan init / kadan up — 새 사용자의 시작점.
// init: 환경 확인 + 스킬 링크 + 실행기 선택 (한 번). up: 비서 세션 + 대시보드 세션 (매일).
// 비서와 대시보드는 새 장치 없이 기존 start/status/stop 규약 그대로 tmux 세션이다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const SECRETARY_ROLE = '비서';
export const DASHBOARD_ROLE = '대시보드';
export const DEFAULT_PORT = '8790';
export const RUNNER_CANDIDATES = ['codex', 'claude'];
export const FIRST_PROMPT = '당신은 카단 비서입니다. 설치된 kadan-secretary 스킬을 읽고(/kadan-secretary), kadan status와 kadan tree로 현재 판을 확인한 뒤, 사용자에게 지금 무엇을 도울지 한 문장으로 물어보고 기다리세요. 사용자가 시키기 전에는 아무것도 발송하지 마세요.';

const SKILL_HOMES = ['.codex/skills', '.claude/skills', '.agents/skills'];

export function configPath(home) { return path.join(home, 'quickstart.json'); }
export function readConfig(home) {
 try { return JSON.parse(fs.readFileSync(configPath(home), 'utf8')); } catch { return {}; }
}
export function writeConfig(home, value) {
 fs.mkdirSync(home, { recursive: true });
 fs.writeFileSync(configPath(home), JSON.stringify(value, null, 2) + '\n');
}

export function detectRunners({ which = whichBin } = {}) {
 return RUNNER_CANDIDATES.filter((name) => which(name));
}
function whichBin(name) {
 const r = spawnSync('which', [name], { encoding: 'utf8' });
 return r.status === 0 ? r.stdout.trim() : null;
}

// 스킬 폴더를 사용자의 에이전트 스킬 폴더에 링크한다. 있는 폴더에만, 없는 이름만. 남의 링크·실물은 덮지 않는다.
export function linkSkills({ skillsDir, userHome = os.homedir(), homes = SKILL_HOMES, fsm = fs } = {}) {
 const results = [];
 if (!fsm.existsSync(skillsDir)) return results;
 const names = fsm.readdirSync(skillsDir).filter((n) => fsm.statSync(path.join(skillsDir, n)).isDirectory());
 for (const rel of homes) {
  const dir = path.join(userHome, rel);
  if (!fsm.existsSync(dir)) { results.push({ dir, state: 'skipped', reason: '폴더 없음' }); continue; }
  for (const name of names) {
   const target = path.join(skillsDir, name);
   const link = path.join(dir, name);
   let existing = null;
   try { existing = fsm.lstatSync(link); } catch {}
   if (!existing) { fsm.symlinkSync(target, link); results.push({ dir, name, state: 'linked' }); continue; }
   if (existing.isSymbolicLink() && fsm.readlinkSync(link) === target) { results.push({ dir, name, state: 'already' }); continue; }
   results.push({ dir, name, state: 'kept', reason: existing.isSymbolicLink() ? '다른 곳을 가리키는 링크' : '실물 폴더' });
  }
 }
 return results;
}

export function runInit({ home, repoRoot, flags = {}, floorName = 'tmux', spawn = spawnSync, which, userHome = os.homedir(), log = console.log } = {}) {
 const report = { node: process.versions.node, tmux: null, home, skills: [], runners: [], runner: null, agentRunners: null };
 const major = Number(process.versions.node.split('.')[0]);
 if (major < 24) throw new Error(`Node 24 이상이 필요합니다 (현재 ${process.versions.node})`);
 if (floorName === 'tmux') {
  const r = spawn('tmux', ['-V'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('tmux를 찾을 수 없습니다. 먼저 tmux를 설치하세요 (brew install tmux / apt install tmux)');
  report.tmux = String(r.stdout || '').trim();
 }
 report.runners = detectRunners(which ? { which } : {});
 if (flags.runner && !report.runners.includes(flags.runner)) throw new Error(`실행기 ${flags.runner}가 PATH에 없습니다`);
 fs.mkdirSync(home, { recursive: true });
 if (!flags['no-skills']) report.skills = linkSkills({ skillsDir: path.join(repoRoot, 'skills'), userHome });
 const example = path.join(repoRoot, 'skills', 'kadan-conductor', 'references', 'agent-runners.example.json');
 const dest = path.join(home, 'agent-runners.json');
 if (!fs.existsSync(dest) && fs.existsSync(example)) { fs.copyFileSync(example, dest); report.agentRunners = 'copied'; } else report.agentRunners = fs.existsSync(dest) ? 'exists' : 'no-example';
 const chosen = flags.runner || readConfig(home).runner || report.runners[0] || null;
 report.runner = chosen;
 writeConfig(home, { ...readConfig(home), runner: chosen, initializedAt: new Date().toISOString() });
 log(`node ${report.node}${report.tmux ? ` · ${report.tmux}` : ''} · 데이터 폴더 ${home}`);
 for (const s of report.skills) {
  if (s.state === 'skipped') log(`스킬 링크 건너뜀: ${s.dir} (${s.reason})`);
  else if (s.state === 'linked') log(`스킬 링크: ${path.join(s.dir, s.name)}`);
  else if (s.state === 'kept') log(`스킬 링크 안 함: ${path.join(s.dir, s.name)} (${s.reason} — 그대로 둠)`);
 }
 log(`실행기 목록: ${dest} (${report.agentRunners === 'copied' ? '예시 복사' : report.agentRunners === 'exists' ? '기존 유지' : '예시 없음'})`);
 if (chosen) log(`비서 실행기: ${chosen} (바꾸려면 kadan init --runner <이름>)`);
 else log('비서 실행기를 찾지 못했습니다 (codex·claude 중 하나를 PATH에 두거나 kadan up --cmd <명령>)');
 log('다음: kadan up');
 return report;
}

// 화면이 두 번 연속 같으면 TUI가 첫 그림을 다 그린 것으로 본다. 판정이 아니라 붙여넣기 시점 선택이다.
export function waitForSettled({ read, tries = 20, sleep = sleepMs, intervalMs = 1000 } = {}) {
 let last = null;
 for (let i = 0; i < tries; i++) {
  let text = '';
  try { const v = read(); text = typeof v === 'string' ? v : (v?.text ?? ''); } catch { text = ''; }
  if (text.trim() && text === last) return true;
  last = text;
  sleep(intervalMs);
 }
 return false;
}
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

export function runUp({ home, flags = {}, floor, start, send, cliPath, nodePath = process.execPath, log = console.log, sessionName, sleep } = {}) {
 const config = readConfig(home);
 const runner = flags.cmd || config.runner || detectRunners()[0];
 if (!runner) throw new Error('비서를 띄울 실행기가 없습니다. kadan init 또는 kadan up --cmd <명령>');
 const port = String(flags.port ?? config.port ?? DEFAULT_PORT);
 if (!/^\d+$/.test(port) || Number(port) > 65535) throw new Error('--port는 0부터 65535까지의 정수여야 한다');
 const out = { runner, port, secretary: null, dashboard: null, prompt: 'skipped' };

 const secretarySession = sessionName(SECRETARY_ROLE);
 if (floor.alive(secretarySession)) { out.secretary = 'reused'; log(`비서 이미 살아 있음: ${secretarySession}`); }
 else { start([SECRETARY_ROLE], { cmd: runner, hidden: Boolean(flags.hidden), profile:'secretary' }); out.secretary = 'started'; }

 const dashboardSession = sessionName(DASHBOARD_ROLE);
 if (floor.alive(dashboardSession)) { out.dashboard = 'reused'; log(`대시보드 이미 살아 있음: ${dashboardSession}`); }
 else { start([DASHBOARD_ROLE], { cmd: `${quote(nodePath)} ${quote(cliPath)} dashboard --port ${port}`, hidden: true }); out.dashboard = 'started'; }

 if (out.secretary === 'started' && !flags['no-prompt']) {
  const settled = waitForSettled({ read: () => floor.read(secretarySession), ...(sleep ? { sleep } : {}) });
  if (settled) { send({ role: SECRETARY_ROLE, session: secretarySession, message: FIRST_PROMPT, roleProfile:'secretary' }); out.prompt = 'sent'; }
  else { out.prompt = 'not-ready'; log('비서 화면이 아직 준비되지 않아 첫 지문을 보내지 않았습니다. 창에서 직접 말을 거세요.'); }
 }
 log('');
 log(`대시보드: http://127.0.0.1:${port}`);
 log(`비서 창: kadan attach ${SECRETARY_ROLE}   (또는 ${floor.attach(secretarySession)})`);
 log(`끄기: kadan stop ${SECRETARY_ROLE} · kadan stop ${DASHBOARD_ROLE}`);
 return out;
}
function quote(s) { return /^[\w./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`; }
