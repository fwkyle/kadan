// kadan init / kadan up — 새 사용자의 시작점.
// init: 환경 확인 + 스킬 링크 + 실행기 선택 (한 번). up: 비서 세션 + 대시보드 세션 (매일).
// 비서와 대시보드는 새 장치 없이 기존 start/status/stop 규약 그대로 tmux 세션이다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initSecretsDir } from './secrets.mjs';
import { DASHBOARD_BUILD_COMMAND } from './dashboard-static.mjs';

export const SECRETARY_ROLE = '비서';
export const DASHBOARD_ROLE = '대시보드';
export const BRIDGE_ROLE = '디코';
export const DEFAULT_PORT = '8790';
export const RUNNER_CANDIDATES = ['codex', 'claude'];

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
 const report = { node: process.versions.node, tmux: null, home, skills: [], runners: [], runner: null, agentRunners: null, secrets: null };
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
 report.secrets = initSecretsDir(home);
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
 log(`비밀 폴더: ${report.secrets.dir} (${report.secrets.created ? '빈 폴더를 만들었다, 값 파일은 직접 만든다' : '이미 있음'}) · kadan secrets show`);
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

// skip: 건너뛸 대상 역할 이름 집합(`kadan up --auto`가 멈춤 상태·상한에 걸린 대상을 뺀다). 사람이 친 up은 비워 둔다.
export function runUp({ home, flags = {}, floor, start, cliPath, nodePath = process.execPath,
 log = console.log, sessionName, restoreSecretary, startWatch, startBridge, skip = new Set(), dashboardBuild } = {}) {
 const config = readConfig(home);
 const runner = flags.cmd || config.runner || detectRunners()[0];
 if (!runner) throw new Error('비서를 띄울 실행기가 없습니다. kadan init 또는 kadan up --cmd <명령>');
 const port = String(flags.port ?? config.port ?? DEFAULT_PORT);
 if (!/^\d+$/.test(port) || Number(port) > 65535) throw new Error('--port는 0부터 65535까지의 정수여야 한다');
 const out = { runner, port, secretary: null, dashboard: null };

 const secretarySession = sessionName(SECRETARY_ROLE);
 if (skip.has(SECRETARY_ROLE)) out.secretary = 'skipped';
 else if (floor.alive(secretarySession)) { out.secretary = 'reused'; log(`비서 이미 살아 있음: ${secretarySession}`); }
 else {
  const startNew = () => start([SECRETARY_ROLE], {
   cmd: runner, hidden: Boolean(flags.hidden), profile:'secretary', 'no-prompt': Boolean(flags['no-prompt']),
  });
  try {
   out.secretary = restoreSecretary ? restoreSecretary(startNew) : (startNew(), 'started');
  } catch (error) {
   out.secretary = 'blocked'; out.secretaryError = error.message;
   log(`비서 복원 확인 필요: ${error.message}`);
  }
  if (out.secretary === 'restored') log(`이전 비서 대화 복원됨: ${secretarySession}`);
 }

 const dashboardSession = sessionName(DASHBOARD_ROLE);
 if (skip.has(DASHBOARD_ROLE)) out.dashboard = 'skipped';
 else if (floor.alive(dashboardSession)) { out.dashboard = 'reused'; log(`대시보드 이미 살아 있음: ${dashboardSession}`); }
 else { start([DASHBOARD_ROLE], { cmd: `${quote(nodePath)} ${quote(cliPath)} dashboard --port ${port}`, hidden: true }); out.dashboard = 'started'; }

 if (startWatch && !skip.has('watch')) {
  try { out.watch = startWatch(); } catch (error) { out.watch = 'failed'; log(`감시기 시작 실패: ${error.message}`); }
  if (out.watch === 'started') log('감시기 시작됨: 기본 감시 프로필(watch-profile.json)');
  else if (out.watch === 'reused') log('감시기 이미 살아 있음');
  else if (out.watch === 'blocked') log('감시기 확인 필요: 감시기 세션은 있는데 감시 프로세스가 없습니다');
 }

 if (startBridge && !skip.has(BRIDGE_ROLE)) {
  try { out.bridge = startBridge(); } catch (error) { out.bridge = 'failed'; log(`디코 다리 시작 실패: ${error.message}`); }
  if (out.bridge === 'started') log('디코 다리 시작됨: #비서 새 글을 우편으로 비서에게 넣는다(kadan-디코)');
  else if (out.bridge === 'reused') log('디코 다리 이미 살아 있음');
  else if (/^(locked|blocked): /.test(out.bridge ?? '')) log(`디코 다리 확인 필요 — ${out.bridge.replace(/^\w+: /, '')}`);
  else if (typeof out.bridge === 'string' && out.bridge.startsWith('bad-config')) log(`디코 다리 건너뜀: ${out.bridge.slice('bad-config: '.length)}`);
 }

 // 비서 첫 안내는 start가 보낸다(start-brief.mjs): 새로 띄운 비서만 1건, 복원·재사용·--no-prompt는 0건.
 log('');
 log(`대시보드: http://127.0.0.1:${port}`);
 // 화면 빌드가 없으면 주소가 503이다(2026-10-22 빈 홈 실측). 빌드를 대신 돌리지 않고, 종료 코드도 바꾸지 않는다.
 if (dashboardBuild && !dashboardBuild().ok) log(`경고: 대시보드 화면 빌드가 없다 — ${DASHBOARD_BUILD_COMMAND}`);
 log(`비서 창: kadan attach ${SECRETARY_ROLE}   (또는 ${floor.attach(secretarySession)})`);
 log(`끄기: kadan stop ${SECRETARY_ROLE} · kadan stop ${DASHBOARD_ROLE}${['started', 'reused'].includes(out.bridge) ? ` · kadan stop ${BRIDGE_ROLE}` : ''}`);
 return out;
}
function quote(s) { return /^[\w./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`; }

// 다리 상태를 읽기만 하는 함수(2026-10-16). ensureBridge와 같은 판단을 쓰되 create()를 부르지 않는다.
// 반환: 'ok' | 'dead'(세션 없음) | 'no-secret' | 'bad-config: …' | 'blocked: …' | 'locked: …'.
// `kadan up --auto`가 '살아 있는 창인데 일을 못 하는 진짜 막힘'을 가릴 때 쓴다(죽은 pane은 먼저 치워서 여기 오지 않는다).
export function bridgeStatus(deps) {
 const state = ensureBridge({ ...deps, create: () => {} });
 return state === 'started' ? 'dead' : state === 'reused' ? 'ok' : state;
}

// 재부팅 뒤 로그인 자동 시작(`kadan up --hidden`)이 감시기도 되살린다(2026-10-13 [kyle]).
// 2026-10-12 재부팅 뒤 감시기만 안 떠서 약 16시간 감시가 비었고, 로티 위계 표시도 꺼졌다.
// 기본 감시 프로필이 있는 홈만 켠다. 이미 도는 감시 프로세스가 있으면 새로 띄우지 않는다.
export function ensureWatch({ profileExists, running, alive, create }) {
 if (!profileExists()) return 'no-profile';
 if (running().length) return 'reused';
 if (alive()) return 'blocked';
 create();
 return 'started';
}

// 디코 #비서 새 글을 우편으로 넣는 다리(`kadan discord watch --to-mail`)를 보장한다. 감시기와 같은 모양이다: 역할이 아니라
// start 기록 없이 tmux 세션 kadan-디코에서 돈다 → 실행 카드가 없어 감시 대상(collectRoles·buildWatchScope)에 오르지 않는다.
// discord-bot 비밀값이 없으면 조용히 건너뛴다. 설정이 있는데 틀렸으면 세션을 띄우지 않고 이유를 알린다(1초 만에 죽는 세션 방지).
// 재사용은 "그 세션이 쥔 잠금이 우편 모드(받는 역할=비서)"일 때만 성공이다. 다른 모드·모드 모르는 옛 잠금·세션 밖 주인이면
// 'blocked: 이유'/'locked: 이유'로 알리고 기존 받기를 끄거나 바꾸지 않는다(stdout 받기를 재사용하면 👀만 붙고 우편은 0통이다).
// lockInfo()는 {pid, mode, to} 또는 null, owned(pid)는 그 프로세스가 이 세션 안에 있는지.
export function ensureBridge({ configured, lockInfo, alive, owned = () => true, create, target = SECRETARY_ROLE }) {
 const state = configured();
 if (state !== 'ok') return state;
 const lock = lockInfo();
 if (alive()) {
  if (!lock) return 'blocked: kadan-디코 세션은 있는데 받기 프로세스(잠금)가 없습니다';
  if (lock.mode !== 'mail') return `blocked: kadan-디코의 받기가 우편 모드가 아닙니다(${lock.mode === 'stdout' ? 'stdout 모드' : '모드를 알 수 없는 옛 받기'}) — 끄고 kadan up을 다시 실행하세요`;
  if (lock.to !== target) return `blocked: kadan-디코의 우편 받기가 ${target}이(가) 아닌 ${lock.to}에게 보내고 있습니다`;
  if (!owned(lock.pid)) return 'blocked: 잠금을 쥔 받기 프로세스가 kadan-디코 세션 안에 있지 않습니다';
  return 'reused';
 }
 if (lock) return `locked: 다른 kadan discord watch(${lock.mode === 'mail' ? '우편 모드' : lock.mode === 'stdout' ? 'stdout 모드' : '모드 모름'})가 잠금을 쥐고 있어 띄우지 않았습니다(같은 상태 파일을 둘이 쓰면 중복·누락이 생긴다)`;
 create();
 return 'started';
}
