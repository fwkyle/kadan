import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { dashboardFixture } from "./helpers/dashboard-fixture.mjs";
import { dashboardData } from "../src/dashboard-api.mjs";
import { serveDashboard } from "../src/dashboard-static.mjs";
import { appendLedger } from "../src/ledger.mjs";

for (const mode of ["jsonl", "sqlite"])
  test(`React JSON API: ${mode} 목록·상세·수정·충돌·결정·우편`, async (t) => {
    const f = dashboardFixture({ mode });
    t.after(() => f.server.close());
    await new Promise((resolve) => f.server.listen(0, "127.0.0.1", resolve));
    const base = "http://127.0.0.1:" + f.server.address().port;
    const get = async (route) => {
      const r = await fetch(base + "/api/dashboard/" + route);
      const text = await r.text();
      assert.equal(r.status, 200, text);
      return JSON.parse(text);
    };
    const token = (await get("session")).token;
    assert.ok(token);
    for (const route of [
      "summary",
      "status",
      "decisions",
      "mail",
      "ledger",
      "runs",
      "sessions",
      "runners",
      "create?kind=work",
      "workspace?collection=work",
      "detail?card=work:demo/dashboard",
      "detail?card=demo/card-1",
    ])
      await get(route);
    const list = await get("workspace?collection=executions&state=all");
    assert.equal(list.rows.length, 50);
    assert.equal(list.total, 55);
    assert.ok(!JSON.stringify(list).includes("<script>"));
    assert.ok(!("body" in list.rows[0]));
    const last = await get("workspace?collection=executions&state=all&page=2");
    assert.equal(last.rows.length, 5);
    assert.equal(
      new Set([...list.rows, ...last.rows].map((r) => r.key)).size,
      55,
    );
    const unlinked = await get("workspace?collection=unlinked&state=all");
    assert.equal(unlinked.total, 54);
    const detail = await get("detail?card=demo/card-1");
    assert.equal(detail.revision, 1);
    assert.match(detail.instructions.sections.at(-1).html, /&lt;script&gt;/);
    const post = (fields) =>
      fetch(base + "/cards/update", {
        method: "POST",
        headers: { Accept: "application/json", Origin: base },
        body: new URLSearchParams({
          ...Object.fromEntries(
            detail.forms[0].fields.map((f) => [f.name, String(f.value ?? "")]),
          ),
          token,
          key: "demo/card-1",
          revision: "1",
          note: "격리 시험",
          ...fields,
        }),
      });
    assert.equal((await post({ token: "wrong" })).status, 403);
    const saved = await post({ title: "수정된 제목" });
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.equal((await saved.json()).result.revision, 2);
    assert.equal((await get("detail?card=demo/card-1")).title, "수정된 제목");
    assert.equal((await post({ title: "오래된 저장" })).status, 409);
    assert.equal(f.cards.get("demo/card-1").title, "수정된 제목");
    appendLedger(
      {
        kind: "done",
        t: new Date().toISOString(),
        role: "작업자",
        taskId: "card-1",
        executionKey: "demo/card-1",
        result: "ok",
      },
      f.home,
    );
    const signal = await get("detail?card=demo/card-1");
    assert.equal(signal.revision, 2);
    assert.ok(
      signal.runs.some((r) => r.state === "done"),
      "같은 카드 버전이라도 실행 신호가 갱신된다",
    );
    const workDetail = await get("detail?card=work:demo/dashboard"),
      workForm = workDetail.forms.find((f) => f.action === "/works/update");
    const workResponse = await fetch(base + workForm.action, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: new URLSearchParams({
        ...Object.fromEntries(
          workForm.fields.map((f) => [f.name, String(f.value ?? "")]),
        ),
        token,
        key: workDetail.key,
        revision: String(workDetail.revision),
        progress: "처리 1 / 남은 1",
        note: "업무 저장 시험",
      }),
    });
    assert.equal(workResponse.status, 200, await workResponse.clone().text());
    assert.equal(f.works.get("demo/dashboard").progress, "처리 1 / 남은 1");
    const runnerResponse = await fetch(base + "/runners/set", {
      method: "POST",
      headers: { Accept: "application/json" },
      body: new URLSearchParams({
        token,
        revision: "1",
        role: "worker",
        runner: "demo",
        model: "demo-b",
        effort: "high",
        reason: "설정 저장 시험",
      }),
    });
    assert.equal(
      runnerResponse.status,
      200,
      await runnerResponse.clone().text(),
    );
    assert.equal((await get("runners")).settings.revision, 2);
    const answer = await fetch(base + "/decisions/answer", {
      method: "POST",
      headers: { Accept: "application/json", Origin: base },
      body: new URLSearchParams({
        token,
        id: f.decision.id,
        revision: "1",
        choice: "적용",
        text: "",
      }),
    });
    assert.equal(answer.status, 200, await answer.clone().text());
    assert.equal((await answer.json()).result.delivery.status, "sent");
    assert.equal(f.delivered.length, 1);
    assert.equal(
      (await get("decisions")).items.find((d) => d.id === f.decision.id).status,
      "answered",
    );
    const before = f.snapshot().entries.length;
    assert.match((await get("mail-body?id=fixture-letter")).body, /우편 원문/);
    assert.equal(f.snapshot().entries.length, before);
    assert.equal(
      (
        await fetch(base + "/api/dashboard/session", {
          headers: { origin: "http://other.invalid" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(base + "/api/dashboard/workspace", { method: "POST" }))
        .status,
      405,
    );
    assert.equal((await fetch(base + "/api/dashboard/missing")).status, 404);
    assert.equal(
      (await fetch(base + "/api/dashboard/summary?legacy=1")).headers.get(
        "content-type",
      ),
      "application/json; charset=utf-8",
    );
  });
test("읽기 실패는 비어 있는 성공 자료로 바꾸지 않는다", () => {
  const f = dashboardFixture({ count: 2 });
  assert.throws(
    () =>
      dashboardData(
        { ...f.snapshot(), centerError: "카드 원장 오류" },
        new URL("http://local/api/dashboard/workspace"),
      ),
    /원장 오류/,
  );
  assert.throws(
    () =>
      dashboardData(
        { ...f.snapshot(), ledgerLines: null },
        new URL("http://local/api/dashboard/mail"),
      ),
    /확인 불가/,
  );
  assert.throws(
    () =>
      dashboardData(
        { ...f.snapshot(), decisionError: "결정 원장 오류" },
        new URL("http://local/api/dashboard/decisions"),
      ),
    /결정 원장 오류/,
  );
});
test("정적 GUI는 원장을 읽지 않고 배포 파일·경로 제한·HEAD·없는 빌드를 처리한다", () => {
  const f = dashboardFixture({ count: 2 }),
    root = path.join(f.home, "dist");
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  fs.writeFileSync(path.join(root, "index.html"), '<div id="root"></div>');
  fs.writeFileSync(path.join(root, "assets", "app.js"), "test");
  const response = () => ({
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  });
  let res = response();
  assert.ok(
    serveDashboard({ method: "GET" }, res, new URL("http://local/"), { root }),
  );
  assert.equal(res.status, 200);
  assert.match(
    res.headers["content-security-policy"],
    /frame-ancestors 'none'/,
  );
  res = response();
  serveDashboard(
    { method: "HEAD" },
    res,
    new URL("http://local/dashboard-assets/assets/app.js"),
    { root },
  );
  assert.equal(res.status, 200);
  assert.equal(res.body, undefined);
  res = response();
  serveDashboard(
    { method: "GET" },
    res,
    new URL("http://local/dashboard-assets/..%2fsecret"),
    { root },
  );
  assert.equal(res.status, 403);
  res = response();
  serveDashboard({ method: "GET" }, res, new URL("http://local/"), {
    root: path.join(root, "absent"),
  });
  assert.equal(res.status, 503);
});
