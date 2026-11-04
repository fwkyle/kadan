// 나이트런 중 자동 머지 관문: 슈퍼감독이 넘긴 gh JSON(stdin)으로 PR 하나의 통과/거절을 판정한다.
// 카단은 GitHub를 부르지 않는다. 판정만 하고 머지는 하지 않는다 — 머지는 슈퍼감독이 통과를 보고 직접 한다.
// 거절 이유는 모두 모아 보인다. 나이트런이 켜져 있으면 `night-note gate` 한 줄만 남긴다(새 사건 종류 없음).
// 10배 점검: 명령 한 번에 카드 목록·원장·온톨로지를 한 번 읽는다. 상주 경로가 아니다.
import {WorkStore} from './work-store.mjs';
import {appendLedger, readLedger} from './ledger.mjs';
import {mergeCheck} from './merge-check.mjs';
import {normalizeSha} from './review-sha.mjs';
import {nightState, readDecisionEvents} from './night.mjs';
import {buildNightNote} from './night-note.mjs';
import {decideNightMerge, gitOriginGithub, normalizeGithub} from './night-repo-policy.mjs';

// 소문자 40자리만 인정한다. 공백·대문자를 맞춰 주지 않는다(애매하면 거절).
const FULL_SHA = /^[0-9a-f]{40}$/;
const PR_URL = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const CLEAN_STATES = ['CLEAN', 'HAS_HOOKS'];
// `--allow`가 풀어 주는 정책 보류 이유는 이 둘뿐이다. setup-needed는 정책 파일 손상·잘못된 키도 같은 이유로 나오므로 풀지 않는다.
export const ALLOW_RELEASES = ['night-merge-forbidden', 'deploy-branch'];

const LOCK_FILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'cargo.lock', 'go.sum', 'poetry.lock', 'pipfile.lock', 'uv.lock'];
// 금지 경로는 경로 이름만으로 본다(저장소 이름으로 나누지 않는다). diff를 못 보므로 의존성 파일은 바뀐 것만으로 보류한다.
// 일부러 src/cli.mjs는 넣지 않았다: 대부분의 카단 PR이 이 파일을 건드려 넣으면 거의 모든 PR이 아침으로 밀린다.
// 판정 논리는 merge-gate.mjs에 따로 있고, cli 연결을 바꾸는 PR도 같은 커밋 검수 PASS가 있어야 통과한다.
export const FORBIDDEN_PATHS = [
  'CI·비밀: .github/workflows/**, *.plist, .env*, *.pem, *.key',
  '의존성: package.json, package-lock.json, npm-shrinkwrap.json, pnpm-lock.yaml, yarn.lock, bun.lock*, Cargo.lock, go.sum, poetry.lock, Pipfile.lock, uv.lock',
  '규칙 문서: CLAUDE.md, AGENTS.md (어느 폴더든)',
  '관문과 판정 재료: src/merge-gate.mjs, src/merge-check.mjs, src/review-sha.mjs, src/review-flow.mjs, src/night*.mjs, src/commands/night.mjs',
];

// 금지 경로면 그 무리 이름, 아니면 null.
export function forbiddenGroup(file) {
  const p = String(file).replace(/^\.\//, '');
  const lower = p.toLowerCase(), base = lower.split('/').pop();
  if (lower.startsWith('.github/workflows/') || lower.includes('/.github/workflows/')) return 'CI·비밀';
  if (base.endsWith('.plist') || base.startsWith('.env') || base.endsWith('.pem') || base.endsWith('.key')) return 'CI·비밀';
  if (base === 'package.json' || LOCK_FILES.includes(base) || base.startsWith('bun.lock')) return '의존성';
  if (base === 'claude.md' || base === 'agents.md') return '규칙 문서';
  if (['src/merge-gate.mjs', 'src/merge-check.mjs', 'src/review-sha.mjs', 'src/review-flow.mjs', 'src/commands/night.mjs'].includes(lower) || /^src\/night[^/]*\.mjs$/.test(lower)) return '관문 판정 재료';
  return null;
}

const usageError = message => Object.assign(new Error(message), {exitCode: 2});

// stdin JSON의 모양을 검사한다. 틀리면 사용 오류(종료 코드 2). requiredChecks는 없어도 되지만(거절 이유가 된다) 있으면 배열이어야 한다.
function parseInput(raw) {
  let input;
  try { input = JSON.parse(raw); } catch { throw usageError('stdin이 JSON이 아닙니다. 사용: {"pr":{…},"requiredChecks":[…]} | kadan merge-gate <저장소/업무ID>'); }
  const pr = input?.pr;
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) throw usageError('입력에 pr 객체가 필요합니다');
  const strings = ['url', 'state', 'mergeable', 'mergeStateStatus', 'headRefOid', 'baseRefName'];
  for (const k of strings) if (typeof pr[k] !== 'string') throw usageError(`pr.${k}는 문자열이어야 합니다`);
  if (!Number.isInteger(pr.number) || pr.number <= 0) throw usageError('pr.number는 양의 정수여야 합니다');
  if (typeof pr.isDraft !== 'boolean') throw usageError('pr.isDraft는 true/false여야 합니다');
  if (!Number.isInteger(pr.changedFiles) || pr.changedFiles < 0) throw usageError('pr.changedFiles는 0 이상의 정수여야 합니다');
  // 파일 목록은 GitHub REST(`gh api --paginate --slurp …/pulls/N/files`) 응답이다: 페이지 배열이거나 평평한 배열. 이름을 바꾼 옛 경로(previous_filename)는 gh pr view에 없어 REST로 받는다.
  if (!Array.isArray(input.files)) throw usageError('맨 위 files(gh api --paginate --slurp repos/<소유자>/<이름>/pulls/<번호>/files 응답)가 필요합니다');
  const files = input.files.flat(1);
  const isText = v => typeof v === 'string' && v.trim() !== '';
  files.forEach((f, i) => {
    if (!f || typeof f !== 'object' || Array.isArray(f) || !isText(f.filename)) throw usageError(`files[${i}]는 filename이 비어 있지 않은 객체여야 합니다`);
    if (f.status !== undefined && typeof f.status !== 'string') throw usageError(`files[${i}].status는 문자열이어야 합니다`);
    if (f.previous_filename !== undefined && !isText(f.previous_filename)) throw usageError(`files[${i}].previous_filename은 비어 있지 않은 문자열이어야 합니다`);
  });
  const checks = input.requiredChecks;
  if (checks !== undefined && checks !== null) {
    if (!Array.isArray(checks)) throw usageError('requiredChecks는 검사 목록이어야 합니다');
    checks.forEach((c, i) => {
      if (!c || typeof c !== 'object' || Array.isArray(c) || !isText(c.name) || !isText(c.state) || !isText(c.bucket)) throw usageError(`requiredChecks[${i}]는 name·state·bucket이 모두 비어 있지 않은 문자열인 객체여야 합니다`);
    });
  }
  return {pr, files, requiredChecks: checks ?? null};
}

// deps(시험용 주입): now, origin(repoPath → 소유자/이름), readEntries, readDecisions, record.
export function mergeGate(workKey, raw, {home, by = '사람', deps = {}} = {}) {
  if (typeof workKey !== 'string' || !workKey.includes('/')) throw usageError('업무 키(저장소/업무ID)가 필요합니다');
  const {pr, files, requiredChecks} = parseInput(raw);
  const now = (deps.now ?? Date.now)();
  let work;
  try { work = new WorkStore(home).get(workKey); } catch (error) { throw usageError(`업무를 찾지 못했습니다: ${workKey} (${error.message})`); }
  const reasons = [];
  const reject = reason => reasons.push(reason);

  // 1. PR 상태
  if (pr.state !== 'OPEN') reject(`PR 상태가 OPEN이 아님(${pr.state})`);
  if (pr.isDraft) reject('초안(draft) PR');
  if (pr.mergeable !== 'MERGEABLE') reject(`합칠 수 있는 상태가 아님(mergeable ${pr.mergeable})`);
  if (!CLEAN_STATES.includes(pr.mergeStateStatus)) reject(`머지 상태가 CLEAN이 아님(${pr.mergeStateStatus}${pr.mergeStateStatus === 'UNKNOWN' ? ' — 잠시 뒤 다시 부르세요' : ''})`);
  // 2. 필수 검사
  if (!requiredChecks?.length) reject('필수 검사 없음(브랜치 보호가 없는 저장소는 아침으로 미룸)');
  else {
    const bad = requiredChecks.filter(c => c.bucket !== 'pass');
    if (bad.length) reject(`통과하지 않은 필수 검사 ${bad.length}건: ${bad.slice(0, 5).map(c => `${c.name ?? '(이름 없음)'}=${c.bucket ?? c.state ?? '?'}`).join(', ')}`);
  }
  // 3. 파일 목록 잘림
  if (files.length !== pr.changedFiles) reject(`파일 목록 개수가 맞지 않음(받은 ${files.length}개, PR ${pr.changedFiles}개; REST는 3,000개까지만 줌)`);
  const noOld = files.filter(f => f.status === 'renamed' && !f.previous_filename);
  if (noOld.length) reject(`이름을 바꾼 파일 ${noOld.length}개에 옛 경로(previous_filename)가 없음: ${noOld.slice(0, 3).map(f => f.filename).join(', ')}`);
  // 4. 금지 경로: 새 경로와 이름을 바꾸기 전 옛 경로 둘 다 본다.
  const paths = files.flatMap(f => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]);
  const forbidden = paths.map(f => [f, forbiddenGroup(f)]).filter(([, g]) => g);
  if (forbidden.length) reject(`금지 경로 ${forbidden.length}개: ${forbidden.slice(0, 5).map(([f, g]) => `${f}(${g})`).join(', ')}`);
  // 5. 검수 대조: merge-check를 그대로 쓰고, 40자리 정확 일치를 더 요구한다(sameCommit의 앞자리 일치는 물려받지 않는다).
  const head = pr.headRefOid; // 원문 그대로: trim·소문자 변환으로 맞춰 주지 않는다.
  let review = null;
  if (!FULL_SHA.test(head)) reject(`PR head가 소문자 40자리 커밋이 아님(${JSON.stringify(pr.headRefOid)})`);
  else {
    review = mergeCheck(workKey, {head}, {home});
    if (review.result !== '같음') reject(`검수 대조: ${review.result}`);
    else if (!FULL_SHA.test(review.reviewSha ?? '') || review.reviewSha !== head) reject(`검수 SHA가 PR head와 40자리로 정확히 같지 않음(${review.reviewSha})`);
  }
  // 6. 업무·저장소 연결
  if (work.status !== 'open') reject(`업무가 열려 있지 않음(${work.status})`);
  const match = PR_URL.exec(pr.url);
  if (match && Number(match[2]) !== pr.number) reject(`PR 주소의 번호(${match[2]})와 pr.number(${pr.number})가 다름`);
  const github = match ? normalizeGithub(match[1]) : null;
  const origin = work.repoPath ? (deps.origin ?? gitOriginGithub)(work.repoPath) : null;
  if (!github) reject(`PR 주소에서 저장소를 읽지 못함(${pr.url})`);
  else if (!origin || normalizeGithub(origin) !== github) reject(`PR 저장소(${github})가 업무 저장소(${origin ?? '읽지 못함'})와 다름`);
  // 7. 저장소 정책 (+ --allow)
  const entries = (deps.readEntries ?? (() => readLedger(home)))();
  const state = nightState(entries, (deps.readDecisions ?? (() => readDecisionEvents(home)))(), now);
  const allow = state.on ? (state.start.allow ?? []) : [];
  let policy = null, allowApplied = null;
  if (github) {
    policy = decideNightMerge(home, {github, baseBranch: pr.baseRefName});
    if (policy.action !== 'merge') {
      if (ALLOW_RELEASES.includes(policy.reason) && allow.includes(github)) allowApplied = policy.reason;
      else reject(`저장소 정책이 나이트런 중 자동 머지를 안 함(${policy.reason})${ALLOW_RELEASES.includes(policy.reason) ? ` — night on --allow ${github}로 풀 수 있음` : ''}`);
    }
  }

  const verdict = reasons.length ? 'reject' : 'pass';
  const prRef = github ? `${github}#${pr.number}` : null;
  const result = {verdict, reasons, work: workKey, pr: prRef, head: pr.headRefOid, reviewSha: review?.reviewSha ?? null,
    review: review?.review?.key ?? null, reviewResult: review?.result ?? null, policy, allowApplied, allow, nightOn: state.on, recorded: false};
  if (state.on) {
    const text = verdict === 'pass' ? `관문 통과${allowApplied ? ` (kyle 허용 --allow로 ${allowApplied} 보류를 풂)` : ''}` : `관문 거절: ${reasons[0]}`;
    const flags = {verdict, work: workKey, reason: verdict === 'pass' ? (allowApplied ? `allow:${allowApplied}` : '모든 조건 충족') : reasons.join(' / '),
      ...(prRef ? {pr: prRef} : {}), ...(normalizeSha(head) ? {sha: head} : {})};
    (deps.record ?? (entry => appendLedger(entry, home)))(buildNightNote({words: ['gate', text], flags, by, now}));
    result.recorded = true;
  }
  return result;
}

export function formatMergeGate(r) {
  const lines = [r.verdict === 'pass' ? '관문: 통과' : '관문: 거절', `PR: ${r.pr ?? '(저장소 모름)'}`, `PR head: ${r.head}`, `검수 SHA: ${r.reviewSha ?? '-'}${r.review ? ` (${r.review})` : ''}`];
  if (r.policy) lines.push(`저장소 정책: ${r.policy.action === 'merge' ? '나이트런 중 자동 머지' : `보류(${r.policy.reason})`}`);
  if (r.allowApplied) lines.push(`kyle 허용(--allow)으로 ${r.allowApplied} 보류를 풂`);
  for (const reason of r.reasons) lines.push(`!! ${reason}`);
  lines.push(r.recorded ? '관문 기록을 남겼습니다(night note gate).' : '기록 없음(나이트런 꺼짐)');
  if (r.verdict === 'pass') lines.push('머지는 하지 않았습니다. 통과면 gh pr merge <N> --squash --match-head-commit <head> 뒤 kadan night note merge … --pr ' + `${r.pr} --sha <mergeCommit>`);
  return lines.join('\n');
}

// 명령 몸체. stdin은 함수로 받는다(시험은 문자열을 준다). 반환: {result, text}. 거절이면 부르는 쪽이 종료 코드 1을 낸다.
export function mergeGateCommand(argv, flags, {home, by, stdin, deps}) {
  const result = mergeGate(argv[0], stdin(), {home, by, deps});
  return {result, text: flags.json === true ? JSON.stringify(result, null, 2) : formatMergeGate(result)};
}
