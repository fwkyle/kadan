// kadan tree·wall·dashboard (HW-3-impl: cli.mjs에서 옮김)
import { readLedgerState, projectLedger } from "../ledger-domains.mjs";
import { readLedgerViewIncremental } from "../ledger-incremental.mjs";
import { storageMode, storageSnapshot } from "../storage.mjs";
import { captureRuntimeVersion } from "../runtime-version.mjs";
import { attachWatchOverview } from "../watch-overview.mjs";
import { watchProcessName } from "../watch-system.mjs";
import { defaultProfilePath } from "../watch-profile.mjs";
import { CardStore } from "../card-store.mjs";
import { buildCardCenter } from "../card-center.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { floor } from "../floor.mjs";
import { ledgerHome, ledgerPath, readLedger, readMailBody } from "../ledger.mjs";
import { buildWallSnapshot, createWallServer, withWaitSnapshots } from "../wall.mjs";
import { collectResources } from "../watch-resource.mjs";
import { recentSends, die } from "../cli-basics.mjs";
import { buildTree, renderTree } from "../cli-tree.mjs";
import { collectCardFiles } from "../cli-guarded-send.mjs";
import { centerSummary } from "../center-summary.mjs";
import { nextTimeBoundary, wallCache } from "../wall-snapshot-cache.mjs";
import {dashboardDataVersions} from '../dashboard-data-versions.mjs';
import {createTreeInputCache} from '../dashboard-tree-inputs.mjs';
import {createDashboardStoreReader} from '../dashboard-store-reader.mjs';
import { createDashboardSummaryReader } from "../dashboard-summary-reader.mjs";
import {readHumanBriefInputs} from '../human-brief.mjs';
import {readOperationsFlowInputs} from '../operations-flow.mjs';
import {DecisionStore} from '../decisions.mjs';
import {createDashboardLedgerReader} from '../dashboard-ledger-reader.mjs';
import {createDashboardMailReader} from '../dashboard-mail-reader.mjs';

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

const treeInputs = createTreeInputCache();
let stores = null;
function dashboardStores(home) {
  if (stores?.home !== home) stores = {home,
    cards: createDashboardStoreReader(home, 'cards'),
    // 대시보드 서버 경로(요약 본문 모드)와 업무는 과거 이력을 RAM에 두지 않고 사실만 든다. 이력은 상세에서 SQL로 읽는다.
    summaryCards: createDashboardStoreReader(home, 'cards', {summaryBodies: true, facts: true}),
    works: createDashboardStoreReader(home, 'works', {facts: true})};
  return stores;
}
// 원장/카드/업무 버전을 나눠 바뀐 입력만 다시 읽는다. 사건 분류는 새 부분만 이어서 한다.
// 생존 여부·자원·감시 프로세스는 원장에 없는 값이라 매번 새로 읽는다.
function readWallData(runtime, listOnly, summaryBodies) {
  const collectedAt = new Date();
  const home = ledgerHome();
  let versions;
  try { versions = dashboardDataVersions(home); }
  catch { versions = {all: null, cards: null, works: null}; }
  const version = versions.all;
  const file = ledgerPath();
  let entries = [];
  let ledgerLines = null,ledgerState=null;
  const errors = [];
  try {
    ({ state: ledgerState, entries } = wallCache.memo("ledger", version, () => {
      // SQLite는 커서 뒤 새 사건만 읽는다. 버전마다 entries는 새 배열이다. 빈 홈은 전체 읽기 한 번으로 둘 다 만든다.
      if (storageMode(home) === "none") {
        const state = readLedgerState(home);
        return { state, entries: projectLedger(state) };
      }
      return readLedgerViewIncremental(home);
    }));
    ledgerLines = entries.length;
  } catch (error) {
    errors.push(`원장 못 읽음(0개가 아니라 모름): ${error.message}`);
  }

  let cards=[],cardError=null,registeredWorks=null,workError=null;
  const cardReader = summaryBodies ? 'summaryCards' : 'cards';
  try {cards=wallCache.memo(cardReader, versions.cards, () => dashboardStores(home)[cardReader].read());}
  catch(error){cardError=error;}
  try {registeredWorks=wallCache.memo("works", versions.works, () => dashboardStores(home).works.read());}
  catch(error){workError=error;}
  const briefInputs=readHumanBriefInputs(home,cards.map(c=>c.key));
  let operationsInputs=null,operationsInputsError=null,decisions=[],decisionError=null;
  try{decisions=new DecisionStore(home).list();}catch(error){decisionError=error.message;}
  if(registeredWorks)try{
    operationsInputs=readOperationsFlowInputs(home,registeredWorks,{cards,ledgerState,decisions,decisionError});
  }catch(error){operationsInputsError=error.message;}
  return {runtime,listOnly,summaryBodies,collectedAt,home,versions,version,file,entries,ledgerLines,ledgerState,
    errors,cards,cardError,registeredWorks,workError,briefInputs,operationsInputs,operationsInputsError,
    decisions,decisionError};
}

function buildWallData(data) {
  const {runtime,listOnly,summaryBodies,collectedAt,home,versions,version,file,entries,ledgerLines,ledgerState,
    cards,cardError,registeredWorks,workError,briefInputs,operationsInputs,operationsInputsError,
    decisions,decisionError}=data;
  const errors=[...data.errors];
  const resourceSnapshot = listOnly ? {} : buildWallSnapshot({ collect: () => collectResources(spawnSync) });
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
  const inputs = treeInputs(entries);
  const aliveKey = JSON.stringify(Object.keys(aliveBySession).sort()
    .map(name => [name, aliveBySession[name].pid ?? null]));
  const treeKey = version && JSON.stringify([versions.cards, inputs.revision, aliveKey]);
  const tree=withWaitSnapshots(wallCache.memo('tree', treeKey,
    () => buildTree(inputs.entries,aliveBySession,cards)),home);
  let center=null, centerError=null,centerKey=null;
  try {
    if (ledgerLines===null) throw new Error("원장을 읽을 수 없어 카드 상태 모름");
    if(cardError)throw cardError;
    const runtimeKnown=!errors.some(x=>x.startsWith("생존"));
    // 카드 상태 계산은 원장·카드 파일과 세션 생존 여부(pid 포함)가 같으면 결과가 같다.
    centerKey = version && JSON.stringify([versions.cards, inputs.revision, runtimeKnown, aliveKey, summaryBodies]);
    // 상태 판정이 현재 시각을 본다(card-center의 activityAt 비교). 계산한 시각을 쓰고, 카드에 적힌 다음 시각 경계가 지나면 다시 계산한다.
    let builtAt = 0;
    const cached = wallCache.memo("center", centerKey, () => buildCardCenter({cards,entries:inputs.entries,tree,runtimeKnown,now:(builtAt=Date.now())}),
      { boundary: () => nextTimeBoundary(cards, builtAt) });
    // 대기 출력 꼬리(out/*.wait-*.txt)는 원장 밖 파일이라 재사용한 카드 상태에 낡은 값이 남는다. 역할 목록은 매번 새 tree의 것을 쓴다.
    center = { ...cached, roles: [...new Map(tree.flatMap(b => b.roles).map(r => [r.role, r])).values()] };
    if(workError)throw workError;
    if(!listOnly)center=attachWatchOverview(center,entries,{works:registeredWorks,watchName:watchProcessName(home),profilePath:fs.existsSync(defaultProfilePath(home))?defaultProfilePath(home):null});
  } catch(error) { centerError=error.message; }
  let cardFiles = null;
  return {
    center,centerError,tree,ledgerState,registeredWorks,runtime,
    registeredWorkError:workError?.message??null,
    briefInputs,operationsInputs,operationsInputsError,decisions,decisionError,
    ...resourceSnapshot,
    entries,
    centerKey,
    // 업무 후속 판정에는 우편/흐름 등 더 넓은 입력이 필요하므로 기존 전체 버전을 유지한다.
    workModelKey: version && JSON.stringify([version, centerKey]),
    version: fs.existsSync(new URL("../../package.json", import.meta.url)) ? JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version : "",
    mailbox: ledgerLines === null ? null : recentSends(entries),
    // 옛 HTML 카드 본문을 펼칠 때만 쓴다. 새 대시보드 API는 과거 첨부 파일을 읽지 않는다.
    get cardFiles() {
      cardFiles ??= ledgerLines === null ? {} : collectCardFiles(entries,
        {readBody: digest => readMailBody(digest, home)});
      return cardFiles;
    },
    collectedAt,
    ledgerPath: file,
    ledgerLines,
    error: errors.length > 0 ? errors.join(" / ") : null,
  };
}

// 서버는 read만 DB snapshot으로 묶고 build·렌더는 닫힌 뒤 실행한다.
// 10배 이력에서 원본 배열 보관은 여전히 늘지만 OS 조회와 상태 계산은 DB를 붙잡지 않는다.
export function createWallSnapshotLoader(runtime=null,{listOnly=false,summaryBodies=false}={}) {
  return {read:()=>readWallData(runtime,listOnly,summaryBodies),build:buildWallData};
}
export function loadWallSnapshot(runtime=null,options={}) {
  const loader=createWallSnapshotLoader(runtime,options);
  return loader.build(storageSnapshot(ledgerHome(),loader.read));
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
  const home = ledgerHome();
  const loadSummary = createDashboardSummaryReader(home, {runtime, listSessions: () => floor.list()});
  const server = createWallServer(createWallSnapshotLoader(runtime, {summaryBodies:true}),
    {home,cacheSec,gui:true,loadSummary,
    loadLedger:createDashboardLedgerReader(home, {runtime}),
    loadMail:createDashboardMailReader(home, {runtime}),
    loadListSnapshot: createWallSnapshotLoader(runtime, {listOnly:true,summaryBodies:true})});
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
