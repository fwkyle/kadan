// 원장·우편함이 부실하고 옛 카드가 화면을 먹던 것 — 2026-09-06 [kyle] 신고.
// 원장에 있는 값만 옮긴다. 없는 값은 만들지 않는다.
import test from "node:test";
import assert from "node:assert/strict";
import { boardLabel, cardFlow, cardHistory, dutyRank, ledgerDetail, renderWallHtml } from "../src/wall.mjs";
import { buildTree, collectCardFiles, extractCardPath, recentSends } from "../src/cli.mjs";

test("원장 한 줄이 실행기·모델·결과·알림 종류까지 말한다 — 2026-09-06", () => {
  assert.equal(
    ledgerDetail({ kind: "start", harness: "codex", model: "xai/grok-4.6", window: "rottie" }),
    "codex · xai/grok-4.6 · 창 rottie"
  );
  assert.equal(ledgerDetail({ kind: "done", result: "ok" }), "ok");
  assert.equal(ledgerDetail({ kind: "send", title: "계열 겹침 경고", bytes: 641 }), "계열 겹침 경고 · 641B");
  assert.equal(
    ledgerDetail({ kind: "alert", alertKind: "계열겹침", level: "AMBER", recipient: "슈퍼" }),
    "계열겹침 · AMBER · → 슈퍼"
  );
  // 옛 줄에는 없는 값이 많다. 그때는 빈 문자열이어야 한다(추측 금지).
  assert.equal(ledgerDetail({ kind: "start" }), "");
  assert.equal(ledgerDetail({ kind: "stop", role: "a" }), "");
  assert.equal(ledgerDetail(null), "");
});

test("우편함은 카드 제목을 함께 보여준다 — id만으로는 무슨 카드인지 몰랐다", () => {
  const entries = [
    { t: "2026-09-06T02:00:00.000Z", kind: "plan", board: "mp", taskId: "card-66", title: "계열 겹침 경고", by: "슈퍼감독" },
    { t: "2026-09-06T02:10:00.000Z", kind: "send", role: "mp-작업자", taskId: "card-66", bytes: 641, by: "슈퍼감독" },
    { t: "2026-09-06T02:11:00.000Z", kind: "send", role: "mp-작업자", taskId: "card-없는제목", bytes: 10, by: "슈퍼감독" },
  ];
  const mail = recentSends(entries);

  assert.equal(mail.at(-1).title, "계열 겹침 경고");
  assert.equal("title" in mail[0], false);
});

test("원장은 줄 나열이 아니라 표다 — 시각·종류·대상·카드·누가·상세 (2026-09-06)", () => {
  const entries = [
    { t: "2026-09-06T02:10:00.000Z", kind: "start", role: "mp-작업자", session: "kadan-mp-작업자", harness: "codex", model: "xai/grok-4.6", window: "rottie", by: "슈퍼감독" },
    { t: "2026-09-06T02:20:00.000Z", kind: "done", role: "mp-작업자", taskId: "card-66", result: "ok" },
  ];
  const html = renderWallHtml({
    tree: buildTree(entries, {}),
    entries,
    collectedAt: new Date("2026-09-06T02:30:00.000Z"),
    ledgerPath: "/tmp/kadan/ledger.jsonl",
    ledgerLines: entries.length,
    error: null,
  });

  assert.match(html, /<table class="ledger-table">/);
  assert.match(html, /<th>종류<\/th><th>대상<\/th><th>카드<\/th><th>누가<\/th><th>상세<\/th>/);
  // 종류별 거르기가 계속 동하려면 줄이 data-kind를 지니고 있어야 한다.
  assert.match(html, /<tr data-kind="start">/);
  assert.match(html, /<td class="detail">codex · xai\/grok-4\.6 · 창 rottie<\/td>/);
  assert.match(html, /<td class="detail">ok<\/td>/);
});

test("판 요약의 옛 카드는 6장까지만 펼치고 나머지는 수로 접는다", () => {
  const entries = Array.from({ length: 9 }, (_, index) => ({
    t: "2026-09-06T02:00:00.000Z",
    kind: "plan",
    board: "old",
    taskId: `card-${index + 1}`,
    by: "사람",
  }));
  const html = renderWallHtml({
    tree: buildTree(entries, {}),
    entries,
    collectedAt: new Date("2026-09-06T02:30:00.000Z"),
    ledgerPath: "/tmp/kadan/ledger.jsonl",
    ledgerLines: entries.length,
    error: null,
    all: true,
  });

  assert.match(html, /외 3장/);
  assert.equal(boardLabel("(없음)"), "판 없이 만든 옛 카드");
  assert.equal(boardLabel("mp"), "mp");
});

test("카드 탭이 과거·진행·미래를 한 표로 눕힌다 — 2026-09-06 [kyle]: 진행과 남은 일이 딱 보여야 한다", () => {
  const entries = [
    { t: "2026-09-06T02:00:00.000Z", kind: "plan", board: "mp", taskId: "card-65", title: "역할별 프리셋", about: "모델 편성", by: "슈퍼감독" },
    { t: "2026-09-06T02:00:00.000Z", kind: "plan", board: "mp", taskId: "card-66", title: "계열 겹침 경고", by: "슈퍼감독" },
    { t: "2026-09-06T02:00:00.000Z", kind: "plan", board: "mp", taskId: "card-67", title: "화면 표시", by: "슈퍼감독" },
    { t: "2026-09-06T02:10:00.000Z", kind: "start", role: "mp-작업자", session: "kadan-mp-작업자", by: "슈퍼감독" },
    { t: "2026-09-06T02:11:00.000Z", kind: "send", role: "mp-작업자", session: "kadan-mp-작업자", taskId: "card-65", preview: "작업 카드: card-65.md 읽고 …", by: "슈퍼감독" },
    { t: "2026-09-06T02:20:00.000Z", kind: "done", role: "mp-작업자", session: "kadan-mp-작업자", taskId: "card-65", result: "ok" },
    { t: "2026-09-06T02:21:00.000Z", kind: "send", role: "mp-작업자", session: "kadan-mp-작업자", taskId: "card-66", preview: "작업 카드: card-66.md 읽고 …", by: "슈퍼감독" },
  ];
  const alive = { "kadan-mp-작업자": { session: "kadan-mp-작업자", pid: "1", alive: true } };
  const tree = buildTree(entries, alive);
  const flow = cardFlow(tree, entries);

  // 진행이 맨 위, 미래가 가운데, 과거가 아래다.
  assert.deepEqual(flow.map(row => [row.state, row.taskId]), [
    ["진행", "card-66"],
    ["미래", "card-67"],
    ["과거", "card-65"],
  ]);

  // 같은 원장인데 세션이 없으면 그 카드는 진행이 아니라 멈춤이다 — 2026-09-01 미아 6건.
  const orphan = cardFlow(buildTree(entries, {}), entries);
  assert.equal(orphan.find(row => row.taskId === "card-66").state, "멈춤");
  assert.equal(orphan.find(row => row.taskId === "card-65").state, "과거");
  assert.equal(flow[0].preview, "작업 카드: card-66.md 읽고 …");
  assert.equal(flow[0].role, "mp-작업자");
  assert.equal(flow[2].result, "ok");
  // 발령 전 카드는 담당이 없다 — 없는 값을 지어내지 않는다.
  assert.equal(flow[1].role, null);

  const html = renderWallHtml({
    tree,
    entries,
    collectedAt: new Date("2026-09-06T02:30:00.000Z"),
    ledgerPath: "/tmp/kadan/ledger.jsonl",
    ledgerLines: entries.length,
    error: null,
  });
  assert.match(html, /<section class="page" id="cards">/);
  assert.match(html, /<tr data-state="진행">/);
  assert.match(html, /<tr data-state="미래">/);
  assert.match(html, /<tr data-state="과거">/);
});

test("카드 본문을 화면에서 펼친다 — 아무 파일이나 읽지 않는다(절대경로 .md만)", () => {
  const entries = [
    { t: "2026-09-06T02:00:00.000Z", kind: "plan", board: "mp", taskId: "card-66", title: "계열 겹침 경고", by: "슈퍼감독" },
    { t: "2026-09-06T02:10:00.000Z", kind: "start", role: "mp-작업자", session: "kadan-mp-작업자", by: "슈퍼감독" },
    { t: "2026-09-06T02:11:00.000Z", kind: "send", role: "mp-작업자", session: "kadan-mp-작업자", taskId: "card-66", digest: "abc", preview: "작업 카드: /tmp/card-66.md 읽고 …", by: "슈퍼감독" },
    { t: "2026-09-06T02:12:00.000Z", kind: "send", role: "mp-작업자", session: "kadan-mp-작업자", taskId: "card-없음", digest: "zzz", preview: "작업 카드: /tmp/사라진.md 읽고 …", by: "슈퍼감독" },
  ];

  const files = collectCardFiles(entries, {
    readBody: digest => (digest === "abc" ? "작업 카드: /tmp/card-66.md 읽고 그대로 해라" : null),
    readFile: file => {
      if (file === "/tmp/card-66.md") return "# card-66 — 계열 겹침 경고\n\n## 금지\n- 막지 않는다.";
      const error = new Error("no such file");
      error.code = "ENOENT";
      throw error;
    },
  });

  assert.equal(files["card-66"].path, "/tmp/card-66.md");
  assert.match(files["card-66"].text, /## 금지/);
  assert.equal(files["card-없음"].error, "파일 없음");

  const html = renderWallHtml({
    tree: buildTree(entries, {}),
    entries,
    cardFiles: files,
    collectedAt: new Date("2026-09-06T02:30:00.000Z"),
    ledgerPath: "/tmp/kadan/ledger.jsonl",
    ledgerLines: entries.length,
    error: null,
  });

  assert.match(html, /<summary>카드 본문 보기<\/summary>/);
  assert.match(html, /## 금지/);
  assert.match(html, /카드 파일 파일 없음/);
  // 경로가 없는 편지는 본문 칸도 없다.
  assert.equal(extractCardPath("경로 없는 지시"), null);
});

test("레포마다 카드 폴더가 달라도 상대경로를 역할의 작업 폴더로 푼다 — 2026-09-06 [kyle]", () => {
  const entries = [
    { t: "2026-09-06T02:10:00.000Z", kind: "start", role: "x-작업자", session: "kadan-x-작업자", cwd: "/repo/앱", by: "슈퍼감독" },
    { t: "2026-09-06T02:11:00.000Z", kind: "send", role: "x-작업자", session: "kadan-x-작업자", taskId: "card-rel", digest: "d1", by: "슈퍼감독" },
    { t: "2026-09-06T02:12:00.000Z", kind: "start", role: "y-작업자", session: "kadan-y-작업자", by: "슈퍼감독" },
    { t: "2026-09-06T02:13:00.000Z", kind: "send", role: "y-작업자", session: "kadan-y-작업자", taskId: "card-cwd없음", digest: "d2", by: "슈퍼감독" },
  ];
  const read = new Map([["/repo/앱/tasks/card-rel.md", "# 상대경로 카드"]]);
  const files = collectCardFiles(entries, {
    readBody: digest => (digest === "d1" ? "카드: tasks/card-rel.md 읽고 해라" : "카드: tasks/card-rel.md 읽고 해라"),
    readFile: file => {
      if (read.has(file)) return read.get(file);
      const error = new Error("no such file");
      error.code = "ENOENT";
      throw error;
    },
  });

  assert.equal(files["card-rel"].path, "/repo/앱/tasks/card-rel.md");
  assert.match(files["card-rel"].text, /상대경로 카드/);
  // 작업 폴더를 모르는 역할은 상대경로를 풀지 않는다 — 아무 데나 뒤지지 않는다.
  assert.equal("card-cwd없음" in files, false);
  assert.equal(extractCardPath("카드: tasks/a.md", "/repo/앱"), "/repo/앱/tasks/a.md");
  assert.equal(extractCardPath("카드: tasks/a.md", null), null);
  assert.equal(extractCardPath("카드: /절대/b.md", "/무시됨"), "/절대/b.md");
});

test('새 원문 경로 영수증: null은 footer 검색 금지, 명시 경로만 읽고 옛 원장은 기존 파싱 유지',()=>{
  const entries=[
    {kind:'start',role:'worker',cwd:'/repo/at-send'},
    {kind:'send',role:'worker',taskId:'pathless',executionKey:'test/pathless',digest:'footer',preview:'/templates/common.md',originalCardPath:null},
    {kind:'send',role:'worker',taskId:'explicit',digest:'footer',originalCardPath:'/repo/at-send/tasks/card.md'},
    {kind:'send',role:'worker',taskId:'legacy',digest:'legacy'},
    {kind:'start',role:'worker',cwd:'/repo/latest'},
  ].map((entry,index)=>({t:`2026-09-12T00:0${index}:00.000Z`,session:'kadan-worker',...entry}));
  const reads=[];
  const files=collectCardFiles(entries,{readBody:d=>{assert.equal(d,'legacy','새 영수증은 전달 footer를 읽지 않는다');return 'tasks/old.md 읽기';},readFile:file=>{reads.push(file);return `카드 본문: ${file}`;}});
  assert.equal(files.pathless,undefined);
  assert.equal(files.explicit.path,'/repo/at-send/tasks/card.md');
  assert.equal(files.legacy.path,'/repo/latest/tasks/old.md');
  assert.deepEqual(reads,['/repo/at-send/tasks/card.md','/repo/latest/tasks/old.md']);
  const html=renderWallHtml({tree:buildTree(entries,{}),entries,cardFiles:files,collectedAt:new Date().toISOString(),ledgerPath:'/tmp/isolated/ledger.jsonl',ledgerLines:entries.length});
  const cardsSection=html.match(/<section class="page" id="cards">([\s\S]*?)<\/section>/)[1];
  assert.equal((cardsSection.match(/<summary>카드 본문 보기<\/summary>/g)||[]).length,2);
  assert.ok(!cardsSection.includes('카드 본문: /templates/common.md'));
  assert.ok(cardsSection.includes('카드 본문: /repo/at-send/tasks/card.md'));
});

test("판 나무는 슈퍼감독→감독→검수자→작업자 순으로 접히고 카드 안에 왕복이 있다 — 2026-09-06 [kyle]", () => {
  const entries = [
    { t: "2026-09-06T02:00:00.000Z", kind: "plan", board: "mp", taskId: "card-66", title: "계열 겹침 경고", about: "모델 편성", by: "슈퍼감독" },
    { t: "2026-09-06T02:01:00.000Z", kind: "start", role: "mp-슈퍼감독", session: "kadan-mp-슈퍼감독", by: "사람" },
    { t: "2026-09-06T02:02:00.000Z", kind: "start", role: "mp-작업자", session: "kadan-mp-작업자", by: "mp-감독" },
    { t: "2026-09-06T02:03:00.000Z", kind: "start", role: "mp-감독", session: "kadan-mp-감독", by: "mp-슈퍼감독" },
    { t: "2026-09-06T02:10:00.000Z", kind: "send", role: "mp-작업자", session: "kadan-mp-작업자", taskId: "card-66", preview: "작업 카드: card-66.md", by: "mp-감독" },
    { t: "2026-09-06T02:30:00.000Z", kind: "send", role: "mp-작업자", session: "kadan-mp-작업자", taskId: "card-66", preview: "정정 1건: 강도는 medium", by: "mp-감독" },
  ];
  const alive = Object.fromEntries(["kadan-mp-슈퍼감독", "kadan-mp-감독", "kadan-mp-작업자"].map(session => [session, { session, pid: "1", alive: true }]));
  const html = renderWallHtml({
    tree: buildTree(entries, alive),
    entries,
    collectedAt: new Date("2026-09-06T03:00:00.000Z"),
    ledgerPath: "/tmp/kadan/ledger.jsonl",
    ledgerLines: entries.length,
    error: null,
  });

  // 직무 순서: 슈퍼감독이 감독보다, 감독이 작업자보다 먼저 나온다.
  const tree판 = html.slice(html.indexOf("판 나무"), html.indexOf("판 한 줄 요약"));
  const order = ["mp-슈퍼감독", "mp-감독", "mp-작업자"].map(role => tree판.indexOf(role));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal(dutyRank("mp-슈퍼감독", "mp") < dutyRank("mp-감독", "mp"), true);

  // 같은 카드에 send가 두 번이면 왕복 2회로 접힌다.
  const steps = cardHistory(entries).get("mp-작업자\u0000card-66");
  assert.equal(steps.length, 2);
  assert.match(html, /왕복 1/);
  assert.match(html, /왕복 2/);
  assert.match(html, /정정 1건: 강도는 medium/);
});

test("원장을 못 읽어 트리가 비어도 판 나무는 화면을 죽이지 않는다 — 2026-09-06 실측 사고", () => {
  const html = renderWallHtml({
    // 2026-09-06 실제 사고 모양: 역할은 있는데 plannedCards가 없는 트리에서 화면 전체가 죽었다.
    tree: [{ name: "mp", roles: [{ role: "mp-작업자", session: "kadan-mp-작업자", life: { state: "unknown" }, cards: [] }] }],
    entries: [],
    collectedAt: new Date("2026-09-06T03:00:00.000Z"),
    ledgerPath: null,
    ledgerLines: null,
    error: "원장 못 읽음",
  });

  assert.match(html, /카단 관제/);
});
