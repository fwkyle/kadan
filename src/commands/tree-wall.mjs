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

export function cmdTree(_argv, flags = {}) {
  if (!flags.legacy) {
    const snapshot=loadWallSnapshot();
    if (snapshot.centerError) die(snapshot.centerError);
    const c=snapshot.center;
    console.log(JSON.stringify({summary:c.summary,executionSummary:c.executionSummary,monitoring:c.monitoring,
      boards:c.boards.map(b=>({name:b.name,state:b.state,cards:b.cards.length,unregisteredRuns:b.runs.length,monitoring:b.monitoring})),
      pendingCards:c.cards
        .filter(card=>!['done','cancelled','superseded','archived'].includes(card.displayState))
        .map(card=>({key:card.key,state:card.displayState,workType:card.workType||'execution',board:card.board,role:card.role})),
      liveRoles:c.roles.filter(r=>r.life.state==='alive').map(r=>({role:r.role,life:r.life})),
      unregisteredRuns:c.unregistered.length},null,2)); return;
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

function loadWallSnapshot(runtime=null) {
  const collectedAt = new Date();
  const resourceSnapshot = buildWallSnapshot({ collect: () => collectResources(spawnSync) });
  const file = ledgerPath();
  let entries = [];
  let ledgerLines = null,ledgerState=null;
  const errors = [];
  try {
    ledgerState=readLedgerState(ledgerHome());
    entries = projectLedger(ledgerState);
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
  try {cards=new CardStore(ledgerHome()).list();}catch(error){cardError=error;}
  const tree=withWaitSnapshots(buildTree(entries,aliveBySession,cards),ledgerHome());
  let center=null, centerError=null,registeredWorks=null;
  try {
    if (ledgerLines===null) throw new Error("원장을 읽을 수 없어 카드 상태 모름");
    if(cardError)throw cardError;
    center=buildCardCenter({cards,entries,tree,runtimeKnown:!errors.some(x=>x.startsWith("생존"))});
    registeredWorks=new WorkStore(ledgerHome()).list();
    center=attachWatchOverview(center,entries,{works:registeredWorks,watchName:watchProcessName(ledgerHome()),profilePath:fs.existsSync(defaultProfilePath(ledgerHome()))?defaultProfilePath(ledgerHome()):null});
  } catch(error) { centerError=error.message; }
  return {
    center,centerError,tree,ledgerState,registeredWorks,runtime,
    ...resourceSnapshot,
    entries,
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
