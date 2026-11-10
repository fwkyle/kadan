// 공개 소개 사이트 빌드(scripts/build-site.mjs)의 계약. 실제 빌드를 임시 폴더에 돌려 결과 HTML을 본다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PAGES, buildSite, dropSections, loadConfig } from "../scripts/build-site.mjs";

const root = new URL("../", import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), "utf8");
const SPLIT = "일이 쌓이면 감독을 나눈다";

function build(config) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-site-"));
  buildSite({ outDir, config });
  const html = Object.fromEntries(PAGES.map((page) => [page.file, fs.readFileSync(path.join(outDir, page.file), "utf8")]));
  return { outDir, html, all: Object.values(html).join("\n") };
}
// 태그의 src·href 값. 본문 글자는 이스케이프되어 있어 여기 걸리는 것은 실제 태그뿐이다.
const attrs = (html, tag, name) =>
  [...html.matchAll(new RegExp(`<${tag}\\b[^>]*?\\s${name}="([^"]*)"`, "g"))].map((m) => m[1]);
const external = (value) => /^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(value);

test("사이트 빌드: 다섯 쪽이 메뉴 순서대로 나오고 설정의 첫 화면 문구가 들어간다", () => {
  const { html, outDir } = build();
  assert.deepEqual(PAGES.map((page) => page.nav), ["홈", "시작하기", "유즈케이스", "상황별 길잡이", "문서"]);
  const config = loadConfig();
  for (const page of PAGES) {
    assert.match(html[page.file], /^<!doctype html>\n<html lang="ko">/);
    const nav = html[page.file].match(/<nav aria-label="쪽 이동">(.*?)<\/nav>/)[1];
    assert.deepEqual(attrs(nav, "a", "href"), PAGES.map((p) => p.file));
    assert.equal(nav.match(/aria-current="page"/g).length, 1);
  }
  const home = html["index.html"];
  assert.ok(home.includes(`<h1>${config.title}</h1>`));
  assert.ok(home.includes(config.lede));
  assert.match(home, /<p class="en" lang="en">Kadan runs AI coding CLIs/);
  assert.doesNotMatch(home, /\{\{/, "채우지 않은 자리");
  // 홈 미리 보기의 첫 번째는 '하던 대화를 카단으로 갈아타기'다(kyle 확정).
  const cards = [...home.matchAll(/<a class="card" href="use-cases\.html"><strong>(.*?)<\/strong>/g)].map((m) => m[1]);
  assert.equal(cards.length, 3);
  assert.equal(cards[0], "하던 대화를 카단으로 갈아타기");
  // 시작하기: AI에게 맡기기가 직접 설치보다 먼저다.
  const start = html["start.html"];
  assert.ok(start.indexOf("AI에게 설치 맡기기") > 0 && start.indexOf("AI에게 설치 맡기기") < start.indexOf("직접 설치하기"));
  assert.ok(fs.existsSync(path.join(outDir, "style.css")));
});

test("사이트 빌드: 통계 토큰이 비면 밖으로 부르는 것이 0개, 토큰을 주면 Cloudflare 스크립트 하나뿐", () => {
  const outside = (all) => [
    ...attrs(all, "script", "src"), ...attrs(all, "link", "href"), ...attrs(all, "img", "src"),
    ...attrs(all, "iframe", "src"), ...attrs(all, "source", "src"),
  ].filter(external);
  const plain = build();
  assert.deepEqual(outside(plain.all), []);
  assert.doesNotMatch(plain.all, /<script\b/i, "토큰이 없으면 스크립트 자체가 없다");
  assert.doesNotMatch(plain.all, /cloudflareinsights|googletagmanager|google-analytics|@import|url\(/i);
  assert.doesNotMatch(read("site/style.css"), /@import|url\(/i, "스타일도 밖을 부르지 않는다");

  const withToken = build({ analyticsToken: "fake-token_123" });
  assert.deepEqual([...new Set(outside(withToken.all))], ["https://static.cloudflareinsights.com/beacon.min.js"]);
  for (const page of PAGES) {
    const scripts = withToken.html[page.file].match(/<script\b[^>]*>/g);
    assert.deepEqual(scripts, [
      `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{&quot;token&quot;:&quot;fake-token_123&quot;}'>`,
    ]);
  }
  assert.throws(() => loadConfig({ analyticsToken: `x"><script>` }), /통계 토큰/);
  assert.equal(loadConfig().analyticsToken, "", "저장소의 토큰은 비워 둔다");
});

test("사이트 빌드: 자리만 둔 '감독 나누기'는 길잡이와 유즈케이스 어디에도 공개되지 않고, 설정을 비우면 다시 나온다", () => {
  const config = loadConfig();
  assert.deepEqual(config.howToExclude, [SPLIT]);
  assert.deepEqual(config.hiddenUseCases, [SPLIT]);
  // 빼는 대상이 원본에 실제로 있어야 한다(제목이 바뀌면 조용히 공개되지 않게 여기서 알린다).
  for (const [file, key] of [["docs/how-to.md", "howToExclude"], ["site/pages/use-cases.md", "hiddenUseCases"]]) {
    assert.deepEqual(dropSections(read(file), config[key]).dropped, config[key], file);
  }
  const hidden = build();
  assert.doesNotMatch(hidden.all, /감독을 나눈/);
  assert.doesNotMatch(hidden.all, /자리만 둔다|머지된 뒤 채운다/);
  assert.equal(hidden.html["how-to.html"].match(/<h2 id=/g).length, 10, "Why·읽는 법 + 항목 여덟 개");
  assert.equal(hidden.html["use-cases.html"].match(/<h2 id=/g).length, 7);

  const shown = build({ hiddenUseCases: [], howToExclude: [] });
  assert.match(shown.html["use-cases.html"], /감독을 나눈다<\/h2>/);
  assert.match(shown.html["how-to.html"], /감독을 나눈다<\/h2>/);
  assert.equal(shown.html["use-cases.html"].match(/<h2 id=/g).length, 8);
});

test("사이트 빌드: 글의 HTML은 글자로만 나오고 설정값도 태그가 되지 않는다", () => {
  const { html } = build({ title: `<script>alert(1)</script>`, lede: `"><img src=x onerror=1>`, enSummary: "<b>x</b>" });
  assert.doesNotMatch(html["index.html"], /<script|<img src=x|<b>x/);
  assert.ok(html["index.html"].includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  // 길잡이의 `<역할>` 같은 자리표시는 글자로 보인다.
  assert.ok(html["how-to.html"].includes("<code>kadan restart &lt;역할&gt; --reason &quot;&lt;이유&gt;&quot;</code>"));
  assert.doesNotMatch(Object.values(html).join(""), /<역할>|<모델>/);
});

test("사이트 빌드: 안쪽 링크는 모두 상대 경로이고 가리키는 쪽·그림·구획이 결과에 있다", () => {
  const { html, outDir } = build();
  for (const page of PAGES) {
    const text = html[page.file];
    const ids = new Set(attrs(text, "\\w+", "id"));
    const targets = [...attrs(text, "a", "href"), ...attrs(text, "link", "href"), ...attrs(text, "img", "src")];
    assert.ok(targets.length > 5, page.file);
    for (const target of targets) {
      if (external(target)) continue;
      assert.doesNotMatch(target, /^\//, `${page.file}: 루트 기준 경로는 하위 경로에서 깨진다 — ${target}`);
      const [file, anchor] = target.split("#");
      if (file) assert.ok(fs.existsSync(path.join(outDir, file)), `${page.file}: 없는 파일 ${target}`);
      else assert.ok(ids.has(anchor), `${page.file}: 없는 구획 ${target}`);
    }
  }
});

test("사이트 빌드: 문서 링크는 저장소 공개 주소로 열리고 가리키는 파일이 저장소에 있다", () => {
  const { all, html } = build({ hiddenUseCases: [], howToExclude: [] });
  const blob = "https://github.com/fwkyle/kadan/blob/main/";
  const links = attrs(all, "a", "href").filter(external);
  assert.ok(links.length > 30);
  for (const link of links) {
    assert.ok(link === "https://github.com/fwkyle/kadan" || link.startsWith(blob), "밖으로 나가는 주소: " + link);
    if (link.startsWith(blob)) {
      const file = decodeURI(link.slice(blob.length).split("#")[0]);
      assert.ok(fs.existsSync(new URL(file, root)), "저장소에 없는 문서: " + file);
    }
  }
  // 길잡이는 대시보드와 달리 경로 글자가 아니라 누르는 링크다.
  assert.doesNotMatch(html["how-to.html"], /dw-document-reference/);
  assert.ok(html["how-to.html"].includes(`<a href="${blob}docs/adopt.md#`));
  // 내부 경로·옛 이름이 섞이지 않는다.
  assert.doesNotMatch(all, /\/Users\/|kadan night|\.kadan-lite/);
});

test("사이트 배포 워크플로: main push(사이트 재료가 바뀐 때)와 수동 실행에서만 돌고, 권한은 배포 작업에만 준다", () => {
  const yml = read(".github/workflows/pages.yml");
  const on = yml.slice(yml.indexOf("\non:"), yml.indexOf("\npermissions:"));
  assert.match(on, /push:\n\s+branches: \[main\]/);
  assert.match(on, /workflow_dispatch:/);
  assert.doesNotMatch(yml, /pull_request/);
  // 빌드가 읽는 것이 모두 경로 필터에 있어야 한다(빠지면 고쳐도 배포가 돌지 않는다).
  const paths = [...on.matchAll(/^\s+- "(.+)"$/gm)].map((m) => m[1]);
  const covered = (file) => paths.some((p) => p === file || (p.endsWith("/**") && file.startsWith(p.slice(0, -2))));
  const inputs = ["scripts/build-site.mjs", "src/card-content.mjs", "docs/architecture.svg", "docs/work-flow.svg",
    "site/site.config.json", "site/style.css", ".github/workflows/pages.yml", ...PAGES.map((page) => page.source)];
  for (const file of inputs) assert.ok(covered(file), "경로 필터에 없는 빌드 재료: " + file);
  const top = yml.slice(yml.indexOf("\npermissions:"), yml.indexOf("\nconcurrency:"));
  assert.match(top, /^\npermissions:\n\s+contents: read\n$/);
  assert.equal(yml.match(/pages: write/g).length, 1);
  assert.equal(yml.match(/id-token: write/g).length, 1);
  assert.ok(yml.indexOf("pages: write") > yml.indexOf("\n  deploy:"), "쓰기 권한은 deploy 작업 안에만");
  assert.match(yml, /persist-credentials: false/);
  assert.match(yml, /npm run build:site/);
  assert.match(read("package.json"), /"build:site": "node scripts\/build-site\.mjs"/);
  assert.match(read(".gitignore"), /^site-dist\/$/m);
});
