import "./helpers/isolated-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dashboardFixture } from "./helpers/dashboard-fixture.mjs";
import { howToData } from "../src/dashboard-how-to.mjs";
import { createWallServer } from "../src/wall.mjs";
import { renderCardDocument } from "../src/card-content.mjs";

const root = new URL("../", import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), "utf8");
const LABELS = ["말 한마디", "명령 한 줄", "주의", "자세한 문서"];
const NOT_ITEMS = new Set(["Why", "읽는 법"]);

// 항목 = "## 제목" 아래 줄들. Why·읽는 법은 항목이 아니다.
function items(markdown) {
  return markdown
    .split(/^## /m)
    .slice(1)
    .map((block) => {
      const [title, ...lines] = block.split("\n");
      return { title: title.trim(), lines: lines.filter((line) => line.trim()) };
    })
    .filter((item) => !NOT_ITEMS.has(item.title));
}

test("길잡이 문서: 항목 아홉 개가 같은 순서의 네 줄이고 단순한 Markdown만 쓴다", () => {
  const doc = read("docs/how-to.md");
  assert.match(doc, /^# .+\n\n## Why\n/, "맨 위에 제목과 Why가 있어야 한다");
  const list = items(doc);
  assert.equal(list.length, 9, "항목 수: " + list.map((item) => item.title).join(" / "));
  for (const item of list)
    assert.deepEqual(
      item.lines.map((line) => line.match(/^- \*\*(.+?)\*\*: \S/)?.[1] ?? "형식 밖: " + line),
      LABELS,
      item.title,
    );
  // 옛 명령 이름을 되살리지 않는다(Autopilot으로 바뀜).
  assert.doesNotMatch(doc, /kadan night/);
  // 공개 사이트 변환과 GitHub 보기를 위해 표·코드 울타리·HTML 태그를 쓰지 않는다.
  // `<역할>` 같은 자리표시는 백틱 안에만 둔다(밖에 두면 GitHub에서 사라진다).
  assert.doesNotMatch(doc, /^\s*\|/m, "표를 쓰지 않는다");
  assert.doesNotMatch(doc, /^\s*(```|~~~)/m, "코드 울타리를 쓰지 않는다");
  assert.doesNotMatch(doc.replace(/`[^`\n]+`/g, ""), /[<>]/, "백틱 밖의 꺾쇠");
  assert.doesNotMatch(doc, /\/Users\//, "내부 절대경로");
});

test("길잡이 문서가 가리키는 문서와 절이 모두 있다", () => {
  const doc = read("docs/how-to.md");
  const anchorOf = (heading) =>
    heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
  const links = [...doc.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length >= 9, "항목마다 자세한 문서가 있어야 한다");
  for (const link of links) {
    assert.doesNotMatch(link, /^[a-z]+:/i, "밖으로 나가는 링크는 쓰지 않는다: " + link);
    const [file, anchor] = link.split("#");
    const target = path.join("docs", file);
    assert.ok(fs.existsSync(new URL(target, root)), "없는 문서: " + target);
    if (!anchor) continue;
    const anchors = [...read(target).matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => anchorOf(m[1]));
    assert.ok(anchors.includes(anchor), `없는 절: ${target}#${anchor}`);
  }
});

test("길잡이 재료: 문서의 HTML은 글자로만 보이고 문서 링크는 저장소 경로 글자로 보인다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-how-to-"));
  const file = path.join(dir, "how-to.md");
  fs.writeFileSync(
    file,
    [
      "# 시험 길잡이",
      "",
      "## 위험한 글 <script>alert(1)</script>",
      "",
      '- **주의**: <img src=x onerror="bad()"> 그리고 `kadan restart <역할>`',
      "- **자세한 문서**: [안내](adopt.md#정상-흐름), [위](../README.md), [밖](https://example.com/a)",
      "- **나쁜 링크**: [x](javascript:alert(1))",
    ].join("\n"),
  );
  const data = howToData({ file });
  assert.equal(data.title, "시험 길잡이");
  assert.equal(data.error, null);
  assert.doesNotMatch(data.html, /<script|<img|onerror="|href="javascript:/i);
  assert.match(data.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(data.html, /<code>kadan restart &lt;역할&gt;<\/code>/);
  // 문서 사이 링크는 대시보드에서 죽은 링크가 되지 않게 a 태그 없이 경로 글자로 보인다.
  assert.match(data.html, /안내 <code>docs\/adopt\.md#정상-흐름<\/code>/);
  assert.match(data.html, /위 <code>README\.md<\/code>/);
  assert.doesNotMatch(data.html, /href="[^"]*\.md/);
  assert.match(data.html, /<a href="https:\/\/example\.com\/a" target="_blank" rel="noopener noreferrer">밖<\/a>/);
  assert.doesNotMatch(data.html, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "설치 경로 노출");
});

test("문서 렌더러: 카드 레코드에 함수가 아닌 link 칸이 있어도 기존 링크 표시를 쓴다", () => {
  const html = renderCardDocument("[안내](docs/a.md)", { path: "/repo/card.md", link: "https://example.com" });
  assert.match(html, /class="dw-document-reference"/);
  assert.match(html, /안내 <code>docs\/a\.md<\/code>/);
});

test("길잡이 재료: 실제 문서의 아홉 항목이 제목으로 그려진다", () => {
  const data = howToData();
  assert.equal(data.title, "상황별 길잡이");
  const headings = [...data.html.matchAll(/<h3>(.+?)<\/h3>/g)].map((m) => m[1]);
  assert.deepEqual(
    headings.filter((heading) => !NOT_ITEMS.has(heading)),
    items(read("docs/how-to.md")).map((item) => item.title),
  );
});

test("길잡이 API: 원장·카드를 읽지 않고 답하며, 문서가 없어도 다른 화면은 정상이다", async (t) => {
  const missing = path.join(os.tmpdir(), "kadan-how-to-missing", "how-to.md");
  const f = dashboardFixture({ count: 2, howToFile: missing });
  // 스냅숏(원장·카드 수집)을 부르면 바로 드러나는 서버: 길잡이는 그 앞에서 답해야 한다.
  let reads = 0;
  const bare = createWallServer(
    () => {
      reads++;
      throw new Error("길잡이는 스냅숏을 읽으면 안 된다");
    },
    { home: f.home, cacheSec: 0, howToFile: missing },
  );
  t.after(() => (f.server.close(), bare.close()));
  await Promise.all(
    [f.server, bare].map((server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))),
  );
  const url = (server, route) =>
    "http://127.0.0.1:" + server.address().port + "/api/dashboard/" + route;
  for (const server of [bare, f.server]) {
    const response = await fetch(url(server, "how-to"));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/json/);
    const body = await response.json();
    assert.equal(body.html, null);
    assert.match(body.error, /docs\/how-to\.md/);
  }
  assert.equal(reads, 0, "길잡이 조회가 원장·카드 수집을 불렀다");
  // 쓰기 요청과 다른 사이트의 조회는 기존 대시보드 API 규칙대로 거절된다.
  assert.equal((await fetch(url(bare, "how-to"), { method: "POST" })).status, 405);
  assert.equal(
    (await fetch(url(bare, "how-to"), { headers: { origin: "https://example.com" } })).status,
    403,
  );
  // 문서가 없어도 다른 화면의 자료는 그대로 읽힌다.
  for (const route of ["session", "summary", "status"])
    assert.equal((await fetch(url(f.server, route))).status, 200, route);
});

test("길잡이 API: 기본 위치의 문서를 읽어 화면 재료를 준다", async (t) => {
  const f = dashboardFixture({ count: 2 });
  t.after(() => f.server.close());
  await new Promise((resolve) => f.server.listen(0, "127.0.0.1", resolve));
  const body = await (
    await fetch("http://127.0.0.1:" + f.server.address().port + "/api/dashboard/how-to")
  ).json();
  assert.equal(body.title, "상황별 길잡이");
  assert.equal(body.error, null);
  assert.equal((body.html.match(/<h3>/g) || []).length, 11);
});
