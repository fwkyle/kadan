// kadan agy accounts [--target <계정 일부>] [--close-seniors] — 떠 있는 agy와 로그인 계정 한눈에 보기. 본체는 ../agy-accounts.mjs.
// 읽기만 한다: ps·lsof·로그 파일·tmux 목록·로티 탭 목록. agy를 띄우지 않고 로그인·키체인을 건드리지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ledgerHome} from '../ledger.mjs';
import {assertWritable} from '../storage.mjs';
import {currentSocket, capturePane} from '../floor-tmux.mjs';
import {rottieQuery} from '../adopt-process.mjs';
import {seniorTmux, seniorSocket, listSeniorSessions, seniorSessionStates, killOwn} from '../senior-session.mjs';
import {LOG_NAME, logStartMs, readAgyLog} from '../agy-log.mjs';
import {LOG_PATH, collectAgy, formatReport, closeSeniors, makeMasker, resolveTarget} from '../agy-accounts.mjs';

export const AGY_USAGE = [
  '사용법: kadan agy accounts [--target <계정 일부>] [--close-seniors]',
  '  떠 있는 agy 프로세스마다 PID·시작 시각·어디서 도는지·계정(앞 몇 글자만)·상태를 보이고,',
  '  지금 새로 띄우면 뜰 계정(저장소를 마지막으로 덮은 계정, 추정)과 다음 갱신 예정 시각(약)을 보인다.',
  '  --target: 맞추려는 계정의 일부 글자. 줄마다 목표와 같음/다름을 붙인다.',
  '  --close-seniors: --target과 함께만 쓴다. 목표와 다른 계정의 시니어 창만 닫는다(끝난 호출이고 기록 대조가 맞는 것만).',
  '    --target이 관측된 계정 정확히 하나와 맞아야 하고, 아니면 아무것도 닫지 않고 거절한다(종료 2).',
  '    시니어가 아닌 창(카단 역할·로티·그 밖)은 닫지 않고 "그 창에서 /login" 안내만 한다.',
  '  agy를 띄우지 않고 로그인·키체인에 접근하지 않는다. 읽는 것은 ps·lsof·agy 로그·tmux 목록·로티 탭 목록뿐이다.',
].join('\n');

const usageError = message => Object.assign(new Error(`${message}\n${AGY_USAGE}`), {exitCode: 2});

// 인자 검사: 아무것도 하기 전에 거른다(부작용 0). 반복·값 붙음·빈 값은 모두 사용법 오류다.
export function parseAgyArgs(argv, flags) {
  if (argv[0] !== 'accounts' || argv.length !== 1) throw usageError('알 수 없는 하위 명령이나 인자');
  const unknown = Object.keys(flags).filter(key => !['close-seniors', 'target', 'help'].includes(key));
  if (unknown.length) throw usageError(`알 수 없는 옵션: ${unknown.map(key => `--${key}`).join(' ')}`);
  const close = Object.hasOwn(flags, 'close-seniors');
  if (close && flags['close-seniors'] !== true) throw usageError('--close-seniors는 값 없이 한 번만 쓴다(반복·값 붙음 거절)');
  let target = null;
  if (Object.hasOwn(flags, 'target')) {
    const value = flags.target;
    if (typeof value !== 'string' || !value.trim()) throw usageError('--target에는 계정 일부 글자 하나가 필요하다(반복·빈 값 거절)');
    target = value.trim();
  }
  if (close && target == null) throw usageError('--close-seniors에는 --target이 필요하다');
  return {target, close};
}

export function agyLogDir(userHome = os.homedir()) { return path.join(userHome, '.gemini', 'antigravity-cli', 'log'); }

// 실제 조회. 각 함수는 읽기 전용이고, 못 읽으면 빈 값으로 돌려 '모름'이 되게 한다(오류로 꾸미지 않는다).
export function realDeps({home = ledgerHome(), env = process.env, run = spawnSync, logDir = agyLogDir()} = {}) {
  const tmuxList = (args) => {
    // -u: 이 옵션이 없으면 tmux가 한글 세션 이름과 탭 글자를 `_`로 바꿔 내보낸다(2026-11-24 운영 실측). 구분은 첫 공백이다(pane_pid는 숫자).
    const result = run('tmux', ['-u', '-L', currentSocket(), ...args], {encoding: 'utf8', timeout: 5000});
    return result.status === 0 ? String(result.stdout ?? '') : null;
  };
  return {
    now: () => Date.now(),
    listProcesses() {
      const result = run('ps', ['-axo', 'pid=,ppid=,lstart=,comm='], {encoding: 'utf8', timeout: 5000, env: {...env, LC_ALL: 'C'}});
      if (result.status !== 0) throw new Error('프로세스 목록을 읽지 못했다(ps)');
      return String(result.stdout).split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/.exec(line))
        .filter(Boolean).map(m => ({pid: m[1], ppid: m[2], startMs: new Date(m[3]).getTime(), comm: m[4]}));
    },
    listLogs() {
      return fs.readdirSync(logDir).filter(name => LOG_NAME.test(name)).map(name => {
        const file = path.join(logDir, name);
        return {file, mtimeMs: fs.statSync(file).mtimeMs, startMs: logStartMs(name)};
      });
    },
    readLog: file => readAgyLog(file),
    openLogs(pids) {
      const out = new Map();
      const result = run('lsof', ['-nP', '-p', pids.join(','), '-Fpn'], {encoding: 'utf8', timeout: 10_000});
      let pid = null;
      for (const line of String(result.stdout ?? '').split('\n')) {
        if (line.startsWith('p')) { pid = line.slice(1); out.set(pid, out.get(pid) ?? []); }
        else if (line.startsWith('n') && pid && LOG_PATH.test(line.slice(1))) out.get(pid).push(line.slice(1));
      }
      return out;
    },
    rolePanes() {
      const text = tmuxList(['list-panes', '-a', '-F', '#{pane_pid} #{session_name}']);
      return (text ?? '').split('\n').map(line => /^(\d+) (.+)$/.exec(line)).filter(Boolean).map(m => ({panePid: m[1], session: m[2]}));
    },
    seniorPanes() {
      try {
        const tmux = seniorTmux({socket: seniorSocket(env, home), home, env, readOnly: true});
        return listSeniorSessions(tmux).map(row => ({panePid: row.pid, session: row.name}));
      } catch { return []; }
    },
    rottieTabs() {
      try {
        const reply = rottieQuery(env.KADAN_ROTTIE_BIN, ['terminal', 'list'], run);
        return (reply.result?.terminals ?? []).filter(tab => tab.state === 'running')
          .map(tab => ({pid: tab.pid, title: tab.title ?? tab.name ?? null, cwd: tab.cwd ?? tab.folder ?? null}));
      } catch { return []; }
    },
    readScreen(session) { try { return capturePane(session); } catch { return null; } },
    seniorStates() {
      const tmux = seniorTmux({socket: seniorSocket(env, home), home, env, readOnly: true});
      return new Map(seniorSessionStates({home, run: tmux}).map(row => [row.name, {state: row.state, why: row.why ?? null, dir: row.dir}]));
    },
    kill(dir) { return killOwn(dir, {run: seniorTmux({socket: seniorSocket(env, home), home, env}), reason: 'agy-accounts', env}); },
    assertWritable: () => assertWritable(home),
  };
}

// 본체: 출력할 글을 돌려준다. 거절은 exitCode 2 오류로 던진다.
export function runAgyAccounts(argv, flags, deps = realDeps()) {
  if (flags.help) return AGY_USAGE;
  const {target, close} = parseAgyArgs(argv, flags);
  const report = collectAgy(deps);
  let note = null;
  if (target) {
    const resolved = resolveTarget(target, report.rows);
    const mask = makeMasker(resolved.observed ?? []);
    if (close && !resolved.ok) {
      const seen = (resolved.observed ?? []).map(account => mask(account)).join(', ') || '(없음)';
      throw Object.assign(new Error(`--target이 관측된 계정 ${resolved.count}개와 맞는다 — 정확히 하나여야 한다. 아무것도 닫지 않았다. 관측된 계정: ${seen}`), {exitCode: 2});
    }
    if (!resolved.ok) note = `주의: --target이 관측된 계정 ${resolved.count}개와 맞는다(정확히 하나여야 --close-seniors를 쓸 수 있다)`;
  }
  let closeLines = null;
  if (close) {
    deps.assertWritable();
    closeLines = ['', '시니어 창 닫기', ...closeSeniors(report.rows, {target, seniorStates: deps.seniorStates(), kill: deps.kill})];
  }
  return [formatReport(report, {target}), ...(note ? [note] : []), ...(closeLines ?? [])].join('\n');
}

export function cmdAgy(argv, flags) {
  console.log(runAgyAccounts(argv, flags));
}
