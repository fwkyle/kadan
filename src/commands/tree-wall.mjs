// kadan tree·wall·dashboard (HW-3-impl: cli.mjs에서 옮김)
import { readLedgerState, projectLedger } from "../ledger-domains.mjs";
import { captureRuntimeVersion } from "../runtime-version.mjs";
import { attachWatchOverview } from "../watch-overview.mjs";
import { watchProcessName } from "../watch-system.mjs";
import { defaultProfilePath } from "../watch-profile.mjs";
import { CardStore } from "../card-store.mjs";
import { WorkStore } from "../work-store.mjs";
import { buildCardCenter } from "../card-center.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { floor } from "../floor.mjs";
import { ledgerHome, ledgerPath, readLedger } from "../ledger.mjs";
import { buildWallSnapshot, createWallServer, withWaitSnapshots } from "../wall.mjs";
import { collectResources } from "../watch-resource.mjs";
import { recentSends, die } from "../cli-basics.mjs";
import { buildTree, renderTree } from "../cli-tree.mjs";
import { collectCardFiles } from "../cli-guarded-send.mjs";
import { centerSummary } from "../center-summary.mjs";
import { dataVersion, nextTimeBoundary, wallCache } from "../wall-snapshot-cache.mjs";

export function cmdTree(_argv, flags = {}) {
  if (!flags.legacy) {
    const snapshot=loadWallSnapshot();
    if (snapshot.centerError) die(snapshot.centerError);
    const c=snapshot.center;
    console.log(JSON.stringify(centerSummary(c),null,2)); return;
  }
  let sessions;
  try {
    sessions = floor.list();
  } catch (error) {
    die(error.message, error.exitCode || 1);
  }
  const aliveBySession = Object.fromEntries(
    sessions
      .filter((item) => item.alive !== false)
      .map((item) => [item.session, item])
  );
  console.log(renderTree(buildTree(readLedger(), aliveBySession,new CardStore(ledgerHome()).listSummaries())));
}

// 데이터 버전(원장 마지막 사건 번호·카드 파일 지문)이 같으면 원장 읽기·카드 읽기·카드 상태 계산을 다시 하지 않는다.
// 생존 여부·자원·감시 프로세스는 원장에 없는 값이라 매번 새로 읽는다.
export function loadWallSnapshot(runtime=null) {
  const collectedAt = new Date();
  const home = ledgerHome();
  const version = dataVersion(home);
  const resourceSnapshot = buildWallSnapshot({ collect: () => collectResources(spawnSync) });
  const file = ledgerPath();
  let entries = [];
  let ledgerLines = null,ledgerState=null;
  const errors = [];
  try {
    ({ state: ledgerState, entries } = wallCache.memo("ledger", version, () => {
      const state = readLedgerState(home);
      return { state, entries: projectLedger(state) };
    }));
    ledgerLines = entries.length;
  } catch (error) {
    errors.push(`원장 못 읽음(0개가 아니라 모름): ${error.message}`);
  }

  let sessions = [];
  try {
    sessions = floor.list();
  } catch (error) {
    errors.push(`생존 못 읽음(죽음이 아니라 모름): ${error.message}`);
  }
  const aliveBySession = Object.fromEntries(
    sessions
      .filter((item) => item.alive !== false)
      .map((item) => [item.session, item])
  );
  let cards=[],cardError=null;
  try {cards=wallCache.memo("cards", version, () => new CardStore(home).list());}catch(error){cardError=error;}
  const tree=withWaitSnapshots(buildTree(entries,aliveBySession,cards),home);
  let center=null, centerError=null,registeredWorks=null,centerKey=null;
  try {
    if (ledgerLines===null) throw new Error("원장을 읽을 수 없어 카드 상태 모름");
    if(cardError)throw cardError;
    const runtimeKnown=!errors.some(x=>x.startsWith("생존"));
    // 카드 상태 계산은 원장·카드 파일과 세션 생존 여부(pid 포함)가 같으면 결과가 같다.
    centerKey = version && JSON.stringify([version, runtimeKnown, Object.keys(aliveBySession).sort().map(name => [name, aliveBySession[name].pid ?? null])]);
    // 상태 판정이 현재 시각을 본다(card-center의 activityAt 비교). 계산한 시각을 쓰고, 카드에 적힌 다음 시각 경계가 지나면 다시 계산한다.
    let builtAt = 0;
    const cached = wallCache.memo("center", centerKey, () => buildCardCenter({cards,entries,tree,runtimeKnown,now:(builtAt=Date.now())}),
      { boundary: () => nextTimeBoundary(cards, builtAt) });
    // 대기 출력 꼬리(out/*.wait-*.txt)는 원장 밖 파일이라 재사용한 카드 상태에 낡은 값이 남는다. 역할 목록은 매번 새 tree의 것을 쓴다.
    center = { ...cached, roles: [...new Map(tree.flatMap(b => b.roles).map(r => [r.role, r])).values()] };
    registeredWorks=wallCache.memo("works", version, () => new WorkStore(home).list());
    center=attachWatchOverview(center,entries,{works:registeredWorks,watchName:watchProcessName(home),profilePath:fs.existsSync(defaultProfilePath(home))?defaultProfilePath(home):null});
  } catch(error) { centerError=error.message; }
  return {
    center,centerError,tree,ledgerState,registeredWorks,runtime,
    ...resourceSnapshot,
    entries,
    centerKey,
    version: fs.existsSync(new URL("../../package.json", import.meta.url)) ? JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version : "",
    mailbox: ledgerLines === null ? null : recentSends(entries),
    cardFiles: ledgerLines === null ? {} : collectCardFiles(entries),
    collectedAt,
    ledgerPath: file,
    ledgerLines,
    error: errors.length > 0 ? errors.join(" / ") : null,
  };
}

export function cmdWall(_argv, flags) {
  if (flags.help) {
    console.log("사용법: kadan wall [--port 8790] [--cache-sec 초]  (모든 판: 주소 뒤에 ?all=1, 카단 판정: ?judge=1)");
    return;
  }
  const rawPort = flags.port ?? "8790";
  if (
    typeof rawPort !== "string" ||
    !/^\d+$/.test(rawPort) ||
    Number(rawPort) > 65535
  ) {
    die("--port는 0부터 65535까지의 정수여야 한다");
  }
  const cacheSec=flags['cache-sec']===undefined?10:Number(flags['cache-sec']);
  // 같은 주소를 15초마다 다시 읽는 화면을 위해 응답을 잠깐 재사용한다. 0이면 끈다.
  if(!Number.isInteger(cacheSec)||cacheSec<0)die('--cache-sec는 0 이상의 정수여야 한다');
  const runtime=captureRuntimeVersion();
  const server = createWallServer(()=>loadWallSnapshot(runtime), {home:ledgerHome(),cacheSec,gui:true});
  server.on("error", (error) => {
    console.error(`오류: 관제 화면 서버 시작 실패: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(Number(rawPort), "127.0.0.1", () => {
    const address = server.address();
    console.log(
      `관제 화면: http://127.0.0.1:${address.port} (Ctrl+C로 종료)`
    );
  });
}
