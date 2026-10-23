// kadan claude refresh — 한도에 걸린 Claude 세션을 골라 보여 준다. PR-1은 미리보기(읽기 전용)만 한다.
// 실제 다시 켜기는 PR-2, 계정 전환까지 묶는 일괄 실행은 PR-3이다. 원장·우편·알림을 쓰지 않고 바닥에 키를 보내지 않는다.
import { taskIdentity } from "../task-identity.mjs";
import { CardStore } from "../card-store.mjs";
import { floor } from "../floor.mjs";
import { ledgerHome, readLedger } from "../ledger.mjs";
import { die } from "../cli-basics.mjs";
import { pendingCardsFor } from "../cli-start-support.mjs";
import { buildPreview, formatPreview, previewJson, readAccounts } from "../claude-refresh.mjs";

export function cmdClaude(argv, flags) {
  if (argv[0] !== "refresh" || argv.length > 1)
    die("사용법: kadan claude refresh [--select limit|all] [--json] [--no-accounts]  (PR-1은 미리보기만 한다)", 2);
  if (flags.yes !== undefined || flags.switch !== undefined)
    die("--yes·--switch는 PR-2/PR-3에서 지원한다 — 지금은 미리보기만 한다", 2);
  const select = flags.select ?? "limit";
  if (select === "login") die("--select login: 로그인 만료 문구 미확보 — 실제 화면 문구를 받은 뒤 지원한다", 2);
  if (select !== "limit" && select !== "all") die("--select는 limit 또는 all이다", 2);
  if (floor.name !== "tmux") die("claude refresh는 tmux 바닥에서만 쓴다", 2);
  const home = ledgerHome();
  const entries = readLedger(home);
  const cards = new CardStore(home).listSummaries();
  const rows = buildPreview({
    entries, floor, select,
    pendingCards: (all, role) => pendingCardsFor(taskIdentity(cards).project(all), role),
  });
  const accounts = flags["no-accounts"] === true ? null : readAccounts();
  console.log(flags.json === true ? JSON.stringify(previewJson(rows, accounts), null, 2) : formatPreview(rows, accounts, { select }));
}
