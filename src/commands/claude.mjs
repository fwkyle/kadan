// kadan claude refresh — 한도에 걸린 Claude 세션을 골라 보여 주고(PR-1), 사람이 --role로 고른 세션만 같은 대화로 다시 켠다(PR-2).
// 계정 전환까지 묶는 일괄 실행(--switch)은 PR-3이다. 미리보기는 원장·우편·알림을 쓰지 않고 바닥에 키를 보내지 않는다.
import { taskIdentity } from "../task-identity.mjs";
import { CardStore } from "../card-store.mjs";
import { floor } from "../floor.mjs";
import { ledgerHome, readLedger } from "../ledger.mjs";
import { die } from "../cli-basics.mjs";
import { pendingCardsFor } from "../cli-start-support.mjs";
import { readSettings } from "../runner-settings.mjs";
import { restartRole } from "../restart.mjs";
import { restartDeps } from "./restart.mjs";
import {
  buildPreview, formatPreview, previewJson, readAccounts, runRefresh, formatRefreshResult, parseRoleList, roleOfSession, HUMAN_ONLY_MESSAGE,
} from "../claude-refresh.mjs";

const KNOWN_FLAGS = new Set(["select", "json", "no-accounts", "yes", "switch", "role", "reason", "interval"]);
const DEFAULT_INTERVAL_SEC = 8;
const MAX_INTERVAL_SEC = 600;
const USAGE = "사용법: kadan claude refresh [--select limit|all] [--json] [--no-accounts]  |  --yes --role <역할>[,<역할>…] [--reason <이유>] [--interval <초>]";

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function cmdClaude(argv, flags) {
  const unknown = Object.keys(flags).find((name) => !KNOWN_FLAGS.has(name));
  if (unknown) die(`알 수 없는 옵션: --${unknown}`, 2);
  if (argv[0] !== "refresh" || argv.length > 1) die(USAGE, 2);
  if (flags.switch !== undefined) die("--switch는 PR-3에서 지원한다 — 지금은 미리보기와 --yes --role 다시 켜기만 한다", 2);
  const yes = flags.yes === true;
  if (flags.yes !== undefined && !yes) die("--yes는 값 없이 쓴다", 2);
  if (yes && flags.role === undefined) die("--yes만으로는 실행하지 않는다 — 다시 켤 대상은 사람이 --role <역할>[,<역할>…]로 고른다(미리보기 표의 role 칸)", 2);
  if (!yes && (flags.reason !== undefined || flags.interval !== undefined)) die("--reason·--interval은 --yes와 함께 쓴다", 2);
  // 사람이 친 명령만 실제로 켠다. KADAN_ROLE은 카단 역할 세션 안에서 설정된다(스스로 밝힌 신분이라 완전한 인증은 아니다).
  if (yes && process.env.KADAN_ROLE) die(HUMAN_ONLY_MESSAGE, 2);
  const select = flags.select ?? (flags.role !== undefined ? "all" : "limit");
  if (select === "login") die("--select login: 로그인 만료 문구 미확보 — 실제 화면 문구를 받은 뒤 지원한다", 2);
  if (select !== "limit" && select !== "all") die("--select는 limit 또는 all이다", 2);
  if (yes && flags.select !== undefined) die("--yes에서는 --select를 쓰지 않는다 — 대상은 --role이 정한다", 2);
  let intervalSec = DEFAULT_INTERVAL_SEC;
  if (flags.interval !== undefined) {
    intervalSec = Number(flags.interval);
    if (typeof flags.interval !== "string" || !Number.isFinite(intervalSec) || intervalSec < 0 || intervalSec > MAX_INTERVAL_SEC) die(`--interval은 0~${MAX_INTERVAL_SEC} 사이 초다`, 2);
  }
  if (flags.reason !== undefined && (typeof flags.reason !== "string" || !flags.reason.trim())) die("--reason에는 이유 글자가 필요하다", 2);
  if (floor.name !== "tmux") die("claude refresh는 tmux 바닥에서만 쓴다", 2);

  const home = ledgerHome();
  const entries = readLedger(home);
  const cards = new CardStore(home).listSummaries();
  const pendingCards = (all, role) => pendingCardsFor(taskIdentity(cards).project(all), role);
  const live = floor.list().filter((item) => item.alive !== false && String(item.session).startsWith("kadan-"));
  const liveSessions = new Set(live.map((item) => item.session));
  const liveRoles = new Set(live.map((item) => roleOfSession(entries, item.session)));
  let chosen = null;
  if (flags.role !== undefined) {
    try { chosen = parseRoleList(flags.role, liveRoles, liveSessions); } catch (error) { die(error.message, 2); }
  }

  if (!yes) {
    let rows = buildPreview({ entries, floor, pendingCards, select });
    if (chosen) {
      rows = chosen.map((role) => rows.find((row) => row.role === role)
        ?? { role, session: `kadan-${role}`, harness: null, model: null, cards: null, verdict: "skip", reason: "살아 있는 역할이 아님", resetLine: null, screenTail: [] });
    }
    const accounts = flags["no-accounts"] === true ? null : readAccounts();
    console.log(flags.json === true ? JSON.stringify(previewJson(rows, accounts), null, 2) : formatPreview(rows, accounts, { select }));
    return;
  }

  // 활성 계정 번호는 원장 기록용이다. 못 읽으면 칸을 생략한다(기록만 비고 다시 켜기는 막지 않는다).
  const accounts = flags["no-accounts"] === true ? null : readAccounts();
  const accountSlot = accounts?.ok && Number.isInteger(accounts.activeAccountNumber) ? accounts.activeAccountNumber : null;
  const deps = restartDeps(home);
  const settings = readSettings(home);
  const results = runRefresh({
    roles: chosen,
    entriesOf: () => readLedger(home),
    floor,
    pendingCards,
    restart: ({ role, session, flags: restartFlags }) => restartRole({ home, role, session, flags: restartFlags, floor, settings, deps }),
    reason: typeof flags.reason === "string" ? flags.reason.trim() : null,
    accountSlot,
    intervalSec,
    sleep: sleepMs,
    now: Date.now,
  });
  console.log(flags.json === true ? JSON.stringify({ results }, null, 2) : formatRefreshResult(results));
  if (results.some((result) => result.outcome === "failed")) process.exitCode = 1;
}
