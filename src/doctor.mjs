// kadan doctor — 막힌 곳을 한 번에 보여 주는 읽기 전용 점검 (설치·상주 PR-1).
// 카단의 데이터와 상태(원장 행·스키마·설정·체크포인트·잠금·revive-state)를 바꾸지 않고, tmux 세션·서버를 만들지 않는다.
// SQLite의 -wal/-shm과 tmux 런타임 폴더는 `kadan status`와 같은 수준으로 생길 수 있다.
// 각 점검은 기존 모듈의 읽기 함수를 부른다. 같은 판정을 새로 짜지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import {storageMode, storageSnapshot} from './storage.mjs';
import {readSystemLedger} from './ledger.mjs';
import {dashboardBuild, DASHBOARD_BUILD_COMMAND} from './dashboard-static.mjs';
import {readReviveState, TARGETS, REVIVE_LABELS} from './revive.mjs';
import {inspectSecretaryCheckpoint} from './secretary-resume.mjs';
import {autostartCommand} from './autostart.mjs';
import {readWindowSetting} from './window-setting.mjs';
import {readSettings} from './runner-settings.mjs';
import {SECRET_NAMES, resolveSecret, permissionWarnings, secretsDirPath} from './secrets.mjs';
import {linkSkills} from './quickstart.mjs';
import {isDefaultHome, liveFloorReason, ALLOW_LIVE_FLOOR_ENV} from './live-floor-guard.mjs';

export const STATES = {ok: '정상', na: '해당 없음', warn: '주의', blocked: '막힘', unknown: '확인 불가'};
const RANK = {ok: 0, na: 0, warn: 1, unknown: 2, blocked: 3};
const worst = states => states.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok');
const result = (state, reason, fix = '') => ({state, reason, fix});

// 원장은 `kadan status`·대시보드와 같은 읽기 경로(storageSnapshot)로 연다. 자체 우회 열기를 두지 않는다.
// SQLite의 -wal/-shm 관리는 다른 읽기 명령과 같은 수준으로 SQLite 자신이 한다.
function probeSqlite(home) {
  storageSnapshot(home, db => db.prepare('SELECT 1').get()); // 형식·버전 확인은 openDatabase가 한다
}

function checkRuntime({run, nodeVersion, floorName}) {
  const problems = [];
  if (Number(nodeVersion.split('.')[0]) < 24) problems.push(`node ${nodeVersion} (24 이상 필요)`);
  let tmuxText = '';
  if (floorName === 'tmux') {
    const r = run('tmux', ['-V'], {encoding: 'utf8'});
    if (r.status !== 0) problems.push('tmux를 찾을 수 없다');
    else tmuxText = ` · ${String(r.stdout).trim()}`;
  }
  if (!problems.length) return result('ok', `node ${nodeVersion}${tmuxText}`);
  return result('blocked', problems.join(', '), 'brew install tmux  (node는 24 이상으로 올린다)');
}

function checkDashboardBuild({repoRoot, dashboardRoot}) {
  const build = dashboardBuild({root: dashboardRoot ?? path.join(repoRoot, 'gui', 'dist')});
  if (build.ok) return result('ok', 'gui/dist/index.html을 읽을 수 있다');
  return result('blocked', `gui/dist/index.html ${build.reason} — 대시보드 주소가 503으로 열린다`, DASHBOARD_BUILD_COMMAND);
}

function checkStorage({home}) {
  if (!fs.existsSync(home)) return result('blocked', '데이터 폴더가 없다', 'kadan init');
  if (!fs.statSync(home).isDirectory()) return result('blocked', '데이터 폴더 자리에 파일이 있다');
  if (storageMode(home) === 'sqlite') {
    probeSqlite(home);
    const paused = fs.existsSync(path.join(home, 'storage-paused.json'));
    return paused ? result('warn', 'SQLite는 열리지만 저장 전환 중이라 쓰기가 중지돼 있다', 'kadan storage --help')
      : result('ok', 'SQLite 원장을 읽기 전용으로 열었다');
  }
  const ledger = path.join(home, 'ledger.jsonl');
  if (!fs.existsSync(ledger)) return result('na', '아직 원장이 없다(처음 kadan up 전)');
  fs.accessSync(ledger, fs.constants.R_OK);
  return result('ok', 'JSONL 원장을 읽을 수 있다');
}

function checkBase({home, probes}) {
  const state = readReviveState(home);
  if (state.corrupt) {
    return result('blocked', 'revive-state.json이 깨져 자동 되살리기가 멈춘다', 'kadan up  (깨진 파일은 .trash로 옮기고 새로 시작한다)');
  }
  const rows = [];
  for (const target of TARGETS) {
    const label = REVIVE_LABELS[target];
    if (target === 'watch' && !probes.watchProfile()) {
      rows.push({label, state: 'na', text: '감시 프로필이 없어 쓰지 않는다'});
      continue;
    }
    if (target === '디코') {
      const bridge = probes.bridgeStatus();
      if (bridge === 'no-secret') { rows.push({label, state: 'na', text: '디코 비밀값이 없어 쓰지 않는다'}); continue; }
      if (bridge.startsWith('bad-config')) {
        rows.push({label, state: 'warn', text: `설정 오류: ${bridge.slice(12)}`});
        continue;
      }
      if (/^(blocked|locked): /.test(bridge)) {
        rows.push({label, state: 'warn', text: bridge.replace(/^\w+: /, '')});
        continue;
      }
    }
    const marked = state.targets[target];
    const core = target === '비서' || target === '대시보드';
    if (marked?.state === 'capped') rows.push({label, state: 'blocked', text: '1시간에 3번 넘게 꺼져 자동으로 안 띄운다'});
    else if (probes.alive(target)) {
      rows.push(state.blocked[target]
        ? {label, state: 'warn', text: '창은 살아 있는데 일을 못 한다'}
        : {label, state: 'ok', text: '살아 있음'});
    } else if (marked?.state === 'stopped') rows.push({label, state: 'warn', text: '사람이 꺼 둔 상태(자동 되살리기가 건너뛴다)'});
    else rows.push({label, state: core ? 'blocked' : 'warn', text: '세션이 없다'});
  }
  const state4 = worst(rows.map(r => r.state));
  const bad = rows.filter(r => !['ok', 'na'].includes(r.state));
  const reason = bad.length ? bad.map(r => `${r.label}: ${r.text}`).join(' / ')
    : rows.map(r => `${r.label} ${r.state === 'na' ? '해당 없음' : '정상'}`).join(' · ');
  return result(state4, reason, bad.length ? 'kadan up' : '');
}

function checkSecretaryCheckpoint({home, floorName, probes}) {
  if (floorName !== 'tmux') return result('na', 'tmux 바닥이 아니라 체크포인트를 쓰지 않는다');
  const found = inspectSecretaryCheckpoint({home, entries: readSystemLedger(home)});
  const alive = probes.alive('비서');
  switch (found.kind) {
    case 'none': return result('na', '아직 비서 시작 기록이 없다');
    case 'not-codex': return result('na', `비서 실행기가 ${found.runner ?? '알 수 없음'}라 체크포인트 대상이 아니다(codex 비서만 만든다)`);
    case 'stopped': return result('warn', '사람이 끈 비서라 자동 복원하지 않는다', 'kadan up');
    case 'ok': return result('ok', 'secretary-resume.json이 지금 비서 기록과 맞는다');
    default: {
      const what = found.kind === 'missing'
        ? 'secretary-resume.json이 없다' : `secretary-resume.json이 맞지 않는다(${found.message})`;
      if (alive) {
        return result('warn', `${what} — 비서가 살아 있는 동안은 괜찮지만 재부팅 뒤 복원이 막힌다`,
          'kadan up  (살아 있는 비서의 대화 정보를 다시 저장한다)');
      }
      return result('blocked', `${what} — 새 비서를 중복 생성하지 않고 복원을 멈춘다`, '사람 확인 필요: docs/recovery.md의 "로그인 때 비서 대화 복원"');
    }
  }
}

function checkAutostart({home, cli, userHome, platform}) {
  if (platform !== 'darwin') return result('na', 'macOS가 아니라 로그인 자동 시작(LaunchAgent)을 쓰지 않는다');
  const status = autostartCommand('status', {home, cli, userHome});
  if (!status.installed) return result('warn', '로그인 자동 시작이 설치돼 있지 않다(재부팅 뒤 카단이 저절로 안 켜진다)', 'kadan autostart install');
  if (status.current === false) {
    return result('warn', '설치된 plist가 지금 환경으로 만들 내용과 다르다(실행 폴더·PATH가 달랐을 수 있다)', 'kadan autostart status');
  }
  return result('ok', 'LaunchAgent plist가 설치돼 있고 지금 환경과 같다');
}

function checkSettings({home}) {
  const parts = [];
  let state = 'ok', fix = '';
  const note = (s, text, cmd = '') => { parts.push(text); if (RANK[s] > RANK[state]) { state = s; fix = cmd; } };
  try {
    const setting = readWindowSetting(home);
    if (setting?.window === 'rottie' && !fs.existsSync(setting.rottieBin)) {
      note('warn', `창 설정의 로티 경로가 없다(${setting.rottieBin})`, 'kadan window show');
    } else parts.push(`창 설정 ${setting ? setting.window : '미설정'}`);
  } catch (error) { note('blocked', error.message, 'kadan window unset'); }
  try {
    if (readSettings(home)) parts.push('runner-settings.json 있음');
    else note('warn', 'runner-settings.json이 없다(역할별 모델을 아직 안 정했다)', 'kadan runners init --reason "처음 시작용 프리셋"');
  } catch (error) { note('blocked', error.message, 'kadan runners show'); }
  return result(state, parts.join(' · '), fix);
}

function checkSecrets({home, env}) {
  const dir = secretsDirPath(home);
  const problems = [];
  let found = 0;
  for (const name of SECRET_NAMES) {
    const where = resolveSecret(env, home, name);
    if (where.source === 'broken') { problems.push(`${name}: ${where.error}`); continue; }
    if (!where.exists) continue;
    found++;
    problems.push(...permissionWarnings(where.path, {checkDir: where.source === 'default'}));
  }
  if (problems.length) return result('warn', problems.join(' / '), 'kadan secrets show');
  if (!fs.existsSync(dir) && !found) return result('na', '비밀 폴더가 없다(선택 기능)');
  return result('ok', found ? `비밀 파일 ${found}개 권한이 알맞다(값은 읽지 않는다)` : '비밀 폴더만 있고 값 파일은 아직 없다(선택 기능)');
}

function checkLiveFloor({home, env}) {
  if (isDefaultHome(home)) return null; // 기본 홈에서는 이 점검을 보이지 않는다
  const socket = env.KADAN_SOCKET || '(없음, 기본 kadan)', window = env.KADAN_WINDOW || '(없음)';
  if (env[ALLOW_LIVE_FLOOR_ENV] === '1') {
    return result('warn', `${ALLOW_LIVE_FLOOR_ENV}=1이라 운영 바닥 거절 장치가 꺼져 있다`, `unset ${ALLOW_LIVE_FLOOR_ENV}`);
  }
  const reason = liveFloorReason(env);
  if (reason) {
    return result('blocked', `기본이 아닌 KADAN_HOME인데 ${reason}라 tmux·로티 호출이 KADAN_LIVE_FLOOR_DENIED로 거절된다`,
      'export KADAN_SOCKET=<격리 이름> KADAN_WINDOW=none');
  }
  return result('ok', `기본이 아닌 KADAN_HOME이고 운영 바닥과 격리돼 있다(소켓 ${socket}, 창 ${window})`);
}

// 읽기 전용: 링크를 만들지 않는 가짜 fs로 linkSkills의 판정만 쓴다('linked' = 아직 안 걸린 링크).
const dryFs = {existsSync: fs.existsSync, readdirSync: fs.readdirSync, statSync: fs.statSync,
  lstatSync: fs.lstatSync, readlinkSync: fs.readlinkSync, symlinkSync: () => {}};
function resolvesTo(link, target) {
  try { return fs.realpathSync(link) === fs.realpathSync(target); } catch { return false; } // 끊긴 링크는 거짓
}
function checkSkills({repoRoot, userHome}) {
  const skillsDir = path.join(repoRoot, 'skills');
  const planned = linkSkills({skillsDir, userHome, fsm: dryFs});
  const folders = planned.filter(r => r.state !== 'skipped');
  if (!folders.length) return result('na', '스킬을 걸 에이전트 폴더(~/.codex·~/.claude·~/.agents의 skills)가 없다');
  const missing = planned.filter(r => r.state === 'linked');
  // linkSkills의 kept(남의 링크는 덮지 않는다)는 건강하다는 뜻이 아니다. 링크가 저장소 스킬로 실제 풀리는지 본다.
  const wrong = planned.filter(r => r.state === 'kept' && r.reason.includes('링크')
    && !resolvesTo(path.join(r.dir, r.name), path.join(skillsDir, r.name)));
  if (!missing.length && !wrong.length) return result('ok', '스킬 링크가 모두 걸려 있다');
  const parts = [];
  if (missing.length) parts.push(`걸리지 않은 스킬 링크 ${missing.length}개: ${missing.map(r => r.name).join(', ')}`);
  if (wrong.length) {
    parts.push(`저장소 스킬로 풀리지 않는 링크 ${wrong.length}개(자동으로 바꾸지 않는다): `
      + wrong.map(r => path.join(r.dir, r.name)).join(', '));
  }
  return result('warn', parts.join(' / '), missing.length ? 'kadan init' : `ls -l '${path.join(wrong[0].dir, wrong[0].name)}'`);
}

function checkRecoveryLocks({home}) {
  const dir = path.join(home, 'recovery');
  const locks = fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => /^role-.*\.lock$/.test(name)) : [];
  if (!locks.length) return result('ok', '남은 복원 잠금이 없다');
  const first = path.join(dir, locks[0]);
  const paths = locks.map(n => path.join(dir, n)).join(', ');
  return result('warn', `복원 잠금 ${locks.length}개가 남아 있다: ${paths} (doctor는 지우지 않는다)`,
    `진행 중인 kadan up·restart가 없는지 확인한 뒤 직접 지운다: rmdir '${first}'`);
}

const CHECKS = [
  ['runtime', 'node·tmux', checkRuntime],
  ['dashboard-build', '대시보드 화면', checkDashboardBuild],
  ['storage', '데이터 폴더·원장', checkStorage],
  ['base', '기반 프로세스 4개', checkBase],
  ['secretary-checkpoint', '비서 복원 체크포인트', checkSecretaryCheckpoint],
  ['autostart', '로그인 자동 시작', checkAutostart],
  ['settings', '창·모델 설정', checkSettings],
  ['secrets', '비밀 폴더 권한', checkSecrets],
  ['live-floor', '운영 바닥 거절 장치', checkLiveFloor],
  ['skills', '스킬 링크', checkSkills],
  ['recovery-locks', '복원 잠금', checkRecoveryLocks],
];

// deps: home · env · repoRoot · cli · userHome · platform · nodeVersion · floorName · run(spawnSync 꼴)
//       probes{alive(target) · watchProfile() · bridgeStatus()} · dashboardRoot(시험용)
export function runDoctor(deps) {
  const checks = [];
  for (const [id, name, check] of CHECKS) {
    let outcome;
    try { outcome = check(deps); } catch (error) { outcome = result('unknown', `조회 실패: ${error.message}`); }
    if (outcome) checks.push({id, name, ...outcome});
  }
  const blocked = checks.filter(c => c.state === 'blocked').length;
  return {exitCode: blocked ? 1 : 0, blocked, checks};
}

const clean = text => String(text).replace(/\s*\n\s*/g, ' ');
export function renderDoctor({checks}) {
  const line = c => [c.name, STATES[c.state], clean(c.reason), c.fix ? `풀려면: ${c.fix}` : '-'].join(' | ');
  return checks.map(line).join('\n');
}
export const doctorJson = ({exitCode, blocked, checks}) => ({
  ok: exitCode === 0, blocked,
  checks: checks.map(c => ({id: c.id, name: c.name, state: c.state, stateLabel: STATES[c.state],
    reason: clean(c.reason), fix: c.fix || null})),
});
