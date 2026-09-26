import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { CardStore } from "../../src/card-store.mjs";
import { WorkStore } from "../../src/work-store.mjs";
import { DecisionStore } from "../../src/decisions.mjs";
import { buildCardCenter } from "../../src/card-center.mjs";
import { appendLedger, readLedger, saveMailBody } from "../../src/ledger.mjs";
import { createDatabase, writeStorageMarker } from "../../src/storage.mjs";
import { createWallServer } from "../../src/wall.mjs";

export function dashboardFixture({ mode = "sqlite", count = 55 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-react-"));
  if (mode === "sqlite") {
    createDatabase(home);
    writeStorageMarker(home, "sqlite");
  }
  const cards = new CardStore(home),
    works = new WorkStore(home),
    delivered = [];
  const notify = (role, message) => {
    delivered.push({ role, message });
    return { delivered: true };
  };
  const decisions = new DecisionStore(home, { notify });
  for (let i = 1; i <= count; i++)
    cards.create({
      repo: "demo",
      id: "card-" + i,
      repoPath: home,
      title: "화면 검증 " + i,
      body: "# 화면 검증\n\n## 목표\n갱신과 편집을 함께 확인합니다.\n\n## 완료 조건\n작성 내용이 유지되어야 합니다. <script>bad()</script>",
      by: "사람",
    });
  const work = works.create({
    key: "demo/dashboard",
    title: "대시보드 개편 검증",
    goal: "최신 상태와 작성 내용 보존",
    scope: "격리 데이터",
    acceptance: "읽기·수정·답변 확인",
    owner: "감독",
    repoPath: home,
    board: "검증판",
  });
  works.change(
    work.key,
    "link",
    { execution: "demo/card-1", phase: "implementation", round: 1 },
    { revision: work.revision, by: "사람", note: "기존 실행 연결" },
  );
  const decision = decisions.request(
    "demo/card-1",
    {
      question: "표시 방식을 적용할까요?",
      options: ["적용", "보류"],
      recommendation: "적용",
      reason:
        "격리 화면에서 비교합니다.\n- 확인 경로 없음: 합성 데이터의 방침 질문",
    },
    "슈퍼감독",
  );
  decisions.request(
    "demo/card-2",
    {
      question: "추가 검수를 진행할까요?",
      options: ["진행", "대기"],
      recommendation: "진행",
      reason: "두 번째 정렬 시험\n- 확인 경로 없음: 합성 데이터의 방침 질문",
    },
    "슈퍼감독",
  );
  const body = "우편 원문 · 연결된 실행의 검증 결과",
    digest = createHash("sha256").update(body).digest("hex").slice(0, 12);
  saveMailBody(digest, body, home);
  appendLedger(
    {
      t: new Date().toISOString(),
      kind: "send",
      by: "작업자",
      role: "감독",
      mailId: "fixture-letter",
      digest,
      workKey: work.key,
      executionKey: "demo/card-1",
      preview: "검증 결과",
      expectReply: true,
    },
    home,
  );
  const settings = {
    version: 1,
    revision: 1,
    activePreset: "default",
    runners: {
      demo: {
        spawn: "demo --model {model} --effort {effort}",
        models: [
          { model: "demo-a", efforts: ["high", "max"] },
          { model: "demo-b", efforts: ["high"] },
        ],
      },
    },
    presets: {
      default: {
        roles: { worker: { runner: "demo", model: "demo-a", effort: "high" } },
        fallback: {},
      },
    },
    blocked: [],
  };
  fs.writeFileSync(
    path.join(home, "runner-settings.json"),
    JSON.stringify(settings),
  );
  const snapshot = () => {
    const entries = readLedger(home);
    return {
      home,
      collectedAt: new Date().toISOString(),
      center: buildCardCenter({
        cards: cards.list(),
        entries,
        tree: [],
        runtimeKnown: true,
      }),
      centerError: null,
      registeredWorks: works.list(),
      entries,
      ledgerLines: entries.length,
      resources: null,
      resourceError: "격리 시험: 자원 미수집",
      tree: [],
      decisions: decisions.list(),
    };
  };
  const server = createWallServer(snapshot, {
    home,
    notify,
    gui: true,
    cacheSec: 0,
  });
  return {
    home,
    cards,
    works,
    decisions,
    decision,
    delivered,
    snapshot,
    server,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = dashboardFixture();
  fixture.server.listen(0, "127.0.0.1", () =>
    console.log(
      JSON.stringify({
        url: "http://127.0.0.1:" + fixture.server.address().port,
        home: fixture.home,
        pid: process.pid,
      }),
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => fixture.server.close(() => process.exit()));
}
