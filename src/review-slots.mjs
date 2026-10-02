// 검수 자리(review slot): 저장소마다 다시 쓰는 검수용 worktree 몇 개(기본 4).
// 왜: 검수마다 새 worktree와 node_modules(약 0.9GB, 파일 수만 개)를 만들고 지워 파일 감시 프로세스가 CPU 82%·
// 메모리 11GB를 쓰고 스왑이 가득 찼다. 자리를 빌려 쓰고 돌려주면 설치는 잠금 파일이 바뀔 때만 한다 (2026-10-02 [kyle]).
// 임차 기록은 카단 폴더의 파일 하나이고, 'wx' 생성이 곧 잠금이다. 데몬·서비스는 없다.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {createExclusive, readResourceConfig, reclaim, runLimited, sleep} from './heavy-limit.mjs';

export const SLOT_USAGE = 'kadan slot acquire <저장소> --for <카드|역할> [--ref <SHA|브랜치>] [--no-wait] [--wait-timeout 1800] [--temporary --reason <이유>] | deps <자리경로> [--cmd "<설치 명령>"] | release <자리경로> | release --for <카드|역할> | status [<저장소>]. 위치 인자를 옵션보다 앞에 둔다. 상세: docs/review-slots.md';
const BUSY_EXIT = 3;
// 잠금 파일 → 설치 명령. 잠금 파일을 그대로 따르게 고정 설치를 쓴다.
const INSTALLERS = [
  ['pnpm-lock.yaml', ['pnpm', 'install', '--frozen-lockfile']],
  ['yarn.lock', ['yarn', 'install', '--frozen-lockfile']],
  ['package-lock.json', ['npm', 'ci']],
];

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value) + '\n', {mode: 0o600});
const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

function git(cwd, args, {allowFail = false} = {}) {
  const result = spawnSync('git', ['-C', cwd, ...args], {encoding: 'utf8'});
  if (result.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} 실패: ${(result.stderr || result.stdout || '').trim()}`);
  return result.status === 0 ? result.stdout.trim() : null;
}

// worktree 경로를 줘도 같은 자리 묶음을 쓰도록 원본 저장소로 되돌린다.
function mainRepo(input) {
  const common = git(path.resolve(input), ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (path.basename(common) !== '.git') throw new Error(`일반 저장소만 지원(bare 저장소 아님): ${input}`);
  return real(path.dirname(common));
}

const poolsDir = home => path.join(home, 'review-slots');
function poolOf(home, repo) {
  const key = `${path.basename(repo)}-${createHash('sha1').update(repo).digest('hex').slice(0, 8)}`;
  const dir = path.join(poolsDir(home), key);
  const pool = {dir, repo, root: path.join(path.dirname(repo), `${path.basename(repo)}-review-slots`)};
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  if (!fs.existsSync(path.join(dir, 'repo.json'))) writeJson(path.join(dir, 'repo.json'), {repo: pool.repo, root: pool.root});
  return pool;
}
function allPools(home) {
  if (!fs.existsSync(poolsDir(home))) return [];
  return fs.readdirSync(poolsDir(home)).map(name => ({dir: path.join(poolsDir(home), name), ...readJson(path.join(poolsDir(home), name, 'repo.json'))}))
    .filter(p => p.repo);
}
const leaseFile = (pool, name) => path.join(pool.dir, `${name}.lease.json`);
const metaFile = (pool, name) => path.join(pool.dir, `${name}.meta.json`);
const leasesOf = pool => fs.readdirSync(pool.dir).filter(n => n.endsWith('.lease.json'))
  .map(n => ({file: path.join(pool.dir, n), lease: readJson(path.join(pool.dir, n))})).filter(x => x.lease);

// 임차가 버려졌는지: 빌린 역할 세션이 사라졌거나 PID가 바뀌었거나, 너무 오래됐다. slot 명령은 바로 끝나므로
// 자기 PID 대신 카단 역할 세션(KADAN_ROLE)의 생존을 본다. 역할 밖에서 빌렸으면 나이만 본다.
function staleReason(lease, {floor, home, now}) {
  if (lease.session && floor) {
    try {
      if (!floor.alive(lease.session)) return `세션 없음(${lease.session})`;
      if (lease.panePid != null && String(floor.pid(lease.session)) !== String(lease.panePid)) return `세션 PID 바뀜(${lease.session})`;
    } catch {}
  }
  const hours = Number(readResourceConfig(home).leaseMaxHours);
  if (now() - Date.parse(lease.at) > hours * 3600_000) return `${hours}시간 초과`;
  return null;
}

const ageMin = (lease, now) => Math.round((now() - Date.parse(lease.at)) / 60000);
const holderText = (lease, now) => `${lease.slot}: ${lease.for}${lease.role ? ` (${lease.role})` : ''} ${ageMin(lease, now)}분`;

function resolveRef(repo, ref) {
  if (!ref) return null;
  const local = git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {allowFail: true});
  if (local) return local;
  // 없을 때만 그 참조 하나만 가져온다. 같은 저장소에서 전체 fetch가 겹치면 참조 잠금 오류가 난다.
  git(repo, ['fetch', '--quiet', 'origin', ref]);
  // FETCH_HEAD는 저장소에 하나라 동시에 빌리는 다른 검수자의 fetch와 섞일 수 있다. 원격 추적 참조를 먼저 본다.
  return git(repo, ['rev-parse', '--verify', '--quiet', `origin/${ref}^{commit}`], {allowFail: true})
    ?? git(repo, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
}

function dirtyError(dir, porcelain) {
  const error = new Error(`자리에 커밋 안 된 변경이 있어 다시 쓰지 않음: ${dir}\n${porcelain.split('\n').slice(0, 5).join('\n')}\n검수자는 코드를 고치지 않는다. 변경을 확인해 치운 뒤 다시 빌린다(node_modules가 .gitignore에 없으면 설치 뒤 항상 이렇게 보인다).`);
  error.code = 'SLOT_DIRTY';
  return error;
}

// 자리 폴더를 처음 쓸 때 만들고(분리된 HEAD), 깨끗한지 본 뒤 요청한 커밋으로 옮긴다.
function prepareSlot(pool, name, sha) {
  const dir = path.join(pool.root, name);
  if (!fs.existsSync(dir)) {
    git(pool.repo, ['worktree', 'prune']);
    fs.mkdirSync(pool.root, {recursive: true});
    git(pool.repo, ['worktree', 'add', '--detach', '--quiet', dir, sha ?? 'HEAD']);
    return {path: dir, sha: git(dir, ['rev-parse', 'HEAD']), created: true};
  }
  const porcelain = git(dir, ['status', '--porcelain']);
  if (porcelain) throw dirtyError(dir, porcelain);
  if (sha) git(dir, ['checkout', '--detach', '--quiet', sha]);
  return {path: dir, sha: git(dir, ['rev-parse', 'HEAD']), created: false};
}

function holderFor(flags, {env, floor, sessionName}) {
  const role = typeof flags.role === 'string' ? flags.role : env.KADAN_ROLE || null;
  let session = null, panePid = null;
  if (role && floor && sessionName) {
    try { const name = sessionName(role); if (floor.alive(name)) { session = name; panePid = floor.pid(name) ?? null; } } catch {}
  }
  return {for: flags.for, role, session, panePid, at: new Date().toISOString()};
}

// 빈 자리 하나를 잡는다. 버려진 임차는 회수하고, 더러운 자리는 건너뛴다. 못 잡으면 slot 없이 사정만 돌려준다.
function tryAcquire(pool, holder, sha, ctx) {
  const cap = Number(readResourceConfig(ctx.home).reviewSlots);
  const dirty = [], reclaimed = [];
  for (let n = 1; n <= cap; n++) {
    const slot = `slot-${n}`, file = leaseFile(pool, slot), lease = {...holder, slot};
    if (!createExclusive(file, lease)) {
      const old = readJson(file), reason = old && staleReason(old, ctx);
      if (!reason || !reclaim(file) || !createExclusive(file, lease)) continue;
      reclaimed.push({slot, holder: old.for, role: old.role, reason});
    }
    try {
      const ready = prepareSlot(pool, slot, sha);
      writeJson(file, {...lease, path: ready.path, sha: ready.sha});
      return {slot: {...ready, slot}, reclaimed, dirty};
    } catch (error) {
      fs.rmSync(file, {force: true});
      if (error.code !== 'SLOT_DIRTY') throw error;
      dirty.push({slot, message: error.message});
    }
  }
  return {slot: null, reclaimed, dirty};
}

function busyError(pool, ctx, dirty) {
  const holders = leasesOf(pool).map(x => holderText(x.lease, ctx.now));
  const error = new Error(`검수 자리 모두 사용 중(${pool.repo}): ${holders.join('; ') || '없음'}${dirty.length ? `\n${dirty.map(d => d.message).join('\n')}` : ''}`);
  error.exitCode = BUSY_EXIT;
  return error;
}

async function acquire(target, flags, ctx) {
  if (!target || typeof flags.for !== 'string') throw new Error(SLOT_USAGE);
  if (flags.temporary && typeof flags.reason !== 'string') throw new Error('임시 자리는 --reason "<이유>" 필요');
  const pool = poolOf(ctx.home, mainRepo(target));
  // --ref가 없으면 원본 저장소의 HEAD. 이전 검수의 커밋이 남아 그대로 검수되는 일을 막는다.
  const sha = resolveRef(pool.repo, typeof flags.ref === 'string' ? flags.ref : 'HEAD');
  const holder = holderFor(flags, ctx);
  const waitMs = (flags['wait-timeout'] == null ? 1800 : Number(flags['wait-timeout'])) * 1000;
  const started = ctx.now();
  let shown = '';
  for (;;) {
    const got = tryAcquire(pool, holder, sha, ctx);
    if (got.slot) return {path: got.slot.path, slot: got.slot.slot, sha: got.slot.sha, repo: pool.repo, for: holder.for, created: got.slot.created,
      ...(got.reclaimed.length ? {reclaimed: got.reclaimed} : {}), ...(got.dirty.length ? {skippedDirty: got.dirty.map(d => d.slot)} : {})};
    if (flags.temporary) return temporary(pool, holder, sha, flags.reason);
    if (flags['no-wait'] || ctx.now() - started >= waitMs) throw busyError(pool, ctx, got.dirty);
    const now = leasesOf(pool).map(x => holderText(x.lease, ctx.now)).join('; ');
    if (now !== shown) { ctx.log(`대기: 검수 자리 모두 사용 중 — ${now}`); shown = now; }
    await sleep(ctx.pollMs);
  }
}

// 자리가 모두 찼을 때 이유를 남기고 한 번 쓰는 자리. 돌려줄 때 지운다.
function temporary(pool, holder, sha, reason) {
  const slot = `temp-${randomUUID().slice(0, 8)}`, file = leaseFile(pool, slot);
  createExclusive(file, {...holder, slot, temporary: true, reason});
  try {
    const ready = prepareSlot(pool, slot, sha);
    writeJson(file, {...holder, slot, temporary: true, reason, path: ready.path, sha: ready.sha});
    return {path: ready.path, slot, sha: ready.sha, repo: pool.repo, for: holder.for, temporary: true, reason};
  } catch (error) { fs.rmSync(file, {force: true}); throw error; }
}

function findLeases(home, {target, forKey}) {
  const want = target ? real(target) : null;
  return allPools(home).flatMap(pool => leasesOf(pool).map(x => ({...x, pool})))
    .filter(x => want ? real(x.lease.path ?? '') === want : x.lease.for === forKey);
}

function release(target, flags, ctx) {
  const forKey = typeof flags.for === 'string' ? flags.for : null;
  if (!target && !forKey) throw new Error(SLOT_USAGE);
  const found = findLeases(ctx.home, {target, forKey});
  if (!found.length) throw new Error(`빌린 자리 없음: ${target ?? `--for ${forKey}`}`);
  return {released: found.map(({file, lease, pool}) => {
    const dirty = lease.path && fs.existsSync(lease.path) ? git(lease.path, ['status', '--porcelain'], {allowFail: true}) : '';
    if (lease.temporary && lease.path && fs.existsSync(lease.path)) {
      // --force 없이 지운다. 변경이 남아 거부되면 임차를 남기고 알린다.
      const removed = git(pool.repo, ['worktree', 'remove', lease.path], {allowFail: true});
      if (removed === null) return {path: lease.path, slot: lease.slot, kept: true, reason: '임시 자리에 변경이 남아 지우지 못함 — 확인 뒤 다시 release'};
      fs.rmSync(metaFile(pool, lease.slot), {force: true});
    }
    fs.rmSync(file, {force: true});
    return {path: lease.path, slot: lease.slot, for: lease.for, ...(lease.temporary ? {removed: true} : {}),
      ...(dirty ? {warning: '커밋 안 된 변경이 남아 다음 사람이 빌리지 못한다'} : {})};
  })};
}

async function deps(target, flags, ctx) {
  if (!target) throw new Error(SLOT_USAGE);
  const [found] = findLeases(ctx.home, {target});
  if (!found) throw new Error(`빌린 자리가 아님: ${target} (먼저 kadan slot acquire)`);
  const {pool, lease} = found, dir = lease.path;
  const installer = INSTALLERS.find(([lock]) => fs.existsSync(path.join(dir, lock)));
  if (!installer) return {path: dir, installed: false, reason: '잠금 파일 없음'};
  const [lockfile, defaultCommand] = installer;
  const hash = createHash('sha256').update(fs.readFileSync(path.join(dir, lockfile))).digest('hex');
  const meta = readJson(metaFile(pool, lease.slot));
  // 잠금 파일이 같고 node_modules가 남아 있으면 설치하지 않는다(캐시 정리로 지워졌으면 다시 설치).
  if (meta?.lockfile === lockfile && meta.hash === hash && fs.existsSync(path.join(dir, 'node_modules')))
    return {path: dir, installed: false, reason: '잠금 파일 그대로', lockfile};
  const command = typeof flags.cmd === 'string' ? ['/bin/sh', '-c', flags.cmd] : defaultCommand;
  // 설치 출력은 표준 오류로 보낸다. 표준 출력은 이 명령의 JSON 결과만 둔다.
  const code = await runLimited(ctx.home, 'install', command, {cwd: dir, env: ctx.env, log: ctx.log, stdio: ['ignore', 2, 2]});
  if (code !== 0) throw Object.assign(new Error(`설치 실패(종료 ${code}): ${command.join(' ')}`), {exitCode: code});
  writeJson(metaFile(pool, lease.slot), {lockfile, hash, command, installedAt: new Date().toISOString()});
  return {path: dir, installed: true, reason: meta ? '잠금 파일 바뀜 또는 node_modules 없음' : '첫 설치', lockfile};
}

function status(target, ctx) {
  const want = target ? mainRepo(target) : null;
  return {pools: allPools(ctx.home).filter(p => !want || p.repo === want).map(pool => {
    const cap = Number(readResourceConfig(ctx.home).reviewSlots);
    const leases = new Map(leasesOf(pool).map(x => [x.lease.slot, x.lease]));
    const names = [...Array.from({length: cap}, (_, i) => `slot-${i + 1}`), ...[...leases.keys()].filter(n => n.startsWith('temp-'))];
    return {repo: pool.repo, root: pool.root, slots: names.map(slot => {
      const lease = leases.get(slot), dir = path.join(pool.root, slot);
      if (!lease) return {slot, path: dir, exists: fs.existsSync(dir), free: true};
      const stale = staleReason(lease, ctx);
      return {slot, path: dir, exists: fs.existsSync(dir), free: false, for: lease.for, role: lease.role, sha: lease.sha, ageMin: ageMin(lease, ctx.now),
        ...(lease.temporary ? {temporary: true, reason: lease.reason} : {}), ...(stale ? {reclaimable: stale} : {})};
    })};
  })};
}

// 공용 옵션 해석기는 값 없는 옵션 뒤의 위치 인자를 값으로 삼킨다. 여기서 되돌린다(handover --manual과 같은 방식).
function normalize(args, flags) {
  const out = {...flags}, rest = [...args];
  for (const name of ['no-wait', 'temporary']) if (typeof out[name] === 'string') { rest.push(out[name]); out[name] = true; }
  return {args: rest, flags: out};
}

export async function slotCommand(rawArgs, rawFlags, {home, floor = null, sessionName = null, env = process.env, now = () => Date.now(), pollMs = 5000, log = m => console.error(m)}) {
  const {args, flags} = normalize(rawArgs, rawFlags);
  const [action, target] = args;
  if (flags.help || !action) return SLOT_USAGE;
  const ctx = {home, floor, sessionName, env, now, pollMs, log};
  if (action === 'acquire') return acquire(target, flags, ctx);
  if (action === 'release') return release(target, flags, ctx);
  if (action === 'deps') return deps(target, flags, ctx);
  if (action === 'status' || action === 'list') return status(target, ctx);
  throw new Error(SLOT_USAGE);
}
