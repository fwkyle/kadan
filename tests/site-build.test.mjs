// 공개 소개 사이트 빌드(scripts/build-site.mjs)의 계약. 실제 빌드를 임시 폴더에 돌려 결과 HTML을 본다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PAGES, RESERVED_IDS, buildSite, dropSections, loadConfig, sectionId, splitSections } from "../scripts/build-site.mjs";

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
// 본문 속 명령은 낱말마다 <span class="w">로 묶여 있다. 글자를 견줄 때는 그 묶음만 걷어 낸다.
const unwrapWords = (html) => html.replace(/<span class="w">([^<]*)<\/span>/g, "$1");

test("사이트 빌드: 다섯 쪽이 메뉴 순서대로 나오고 설정의 첫 화면 문구가 들어간다", () => {
  const { html, outDir } = build();
  assert.deepEqual(PAGES.map((page) => page.nav), ["홈", "시작하기", "유즈케이스", "상황별 길잡이", "문서"]);
  const config = loadConfig();
  for (const page of PAGES) assert.match(html[page.file], /^<!doctype html>\n<html lang="ko">/);
  // 홈은 위쪽 메뉴로 다섯 쪽에 간다. 글 쪽의 길(사이트 지도)은 아래 시험이 본다.
  const home = html["index.html"];
  const nav = home.match(/<nav aria-label="쪽 이동">(.*?)<\/nav>/)[1];
  assert.deepEqual(attrs(nav, "a", "href"), PAGES.map((p) => p.file));
  assert.deepEqual(nav.match(/<a href="([^"]+)" aria-current="page"/g), [`<a href="index.html" aria-current="page"`]);
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

// 사이트 지도 하나를 [{ file, current, nav, items: [{ href, label }] }]로 읽는다. 묶음 제목의 주소에는 #이 없고 구획의 주소에는 있다.
const readMap = (map) =>
  [...map.matchAll(/<li(?: class="here")?><a href="([^"#]+)"( aria-current="page")?>([^<]*)<\/a>(?:<ol>(.*?)<\/ol>)?<\/li>/g)]
    .map(([whole, file, current, nav, list = ""]) => ({
      file, nav, current: Boolean(current), here: whole.startsWith('<li class="here">'),
      items: [...list.matchAll(/<li><a href="([^"]*)">([^<]*)<\/a><\/li>/g)].map(([, href, label]) => ({ href, label })),
    }));
// 원본 글의 구획 제목(숨김 목록을 뺀 것). 지금 제목에는 이스케이프될 글자가 없어 그대로 견준다.
const sourceTitles = (page, config) => page.source.endsWith(".md")
  ? splitSections(dropSections(read(page.source), config[page.drop] ?? []).text).slice(1).map((part) => part.split("\n")[0].slice(3).trim())
  : [];
// 그 쪽의 구획들: 제목, 제목에서 만든 주소, 지도·목차에 올리는지(mapSkip에 없는 것).
const sourceSections = (page, config) => {
  const taken = new Set(RESERVED_IDS);
  return sourceTitles(page, config).map((title) => ({ title, id: sectionId(title, taken), listed: !(page.mapSkip ?? []).includes(title) }));
};

test("사이트 빌드: 글 쪽의 사이트 지도·이 쪽의 목차는 원본 글의 구획에서 만들어지고 지금 쪽을 표시한다", () => {
  const { html } = build();
  const config = loadConfig();
  const docs = PAGES.filter((page) => page.source.endsWith(".md"));
  assert.equal(docs.length, 4);
  // 홈은 소개 배치 그대로다(옆 칸·목차 없음). 좁은 화면용 메뉴 줄만 글 쪽과 같은 것을 쓴다.
  const home = html["index.html"];
  assert.doesNotMatch(home, /class="frame"|class="side"|class="toc"/);
  assert.equal(home.match(/<nav class="map" aria-label="사이트 지도">/g).length, 1);
  assert.match(home, /<header class="bar">\n<a class="brand" href="index\.html">.*\n<details class="menu">\n<summary><span>메뉴<\/span><\/summary>\n<nav class="map"/);
  assert.deepEqual(readMap(home.match(/<nav class="map" aria-label="사이트 지도">(.*?)<\/nav>/)[1]).filter((group) => group.current).map((group) => group.file), ["index.html"]);
  for (const page of docs) {
    const text = html[page.file];
    assert.doesNotMatch(text, /쪽 이동/, page.file);
    // 같은 지도가 두 번 들어간다: 좁은 화면의 접히는 메뉴(details) 안과 넓은 화면의 옆 칸.
    const maps = [...text.matchAll(/<nav class="map" aria-label="사이트 지도">(.*?)<\/nav>/g)].map((m) => m[1]);
    assert.equal(maps.length, 2, page.file);
    assert.equal(maps[0], maps[1]);
    assert.match(text, /<details class="menu">\n<summary><span>메뉴<\/span><\/summary>\n<nav class="map"/);
    assert.doesNotMatch(text, /<details[^>]*\sopen/, "메뉴는 접힌 채로 나온다");
    assert.match(text, /<aside class="side">\n<a class="brand" href="index\.html">.*\n<nav class="map"/);
    assert.doesNotMatch(maps[0], /\sid=/, "두 번 들어가므로 id를 달지 않는다");

    const groups = readMap(maps[0]);
    assert.deepEqual(groups.map((group) => [group.file, group.nav]), PAGES.map((p) => [p.file, p.nav]));
    assert.deepEqual(groups.filter((group) => group.current).map((group) => group.file), [page.file]);
    assert.deepEqual(groups.filter((group) => group.here).map((group) => group.file), [page.file]);
    assert.equal(maps[0].match(/aria-current/g).length, 1);
    for (const [index, group] of groups.entries()) {
      const listed = sourceSections(PAGES[index], config).filter((section) => section.listed);
      assert.deepEqual(group.items.map((item) => item.label), listed.map((section) => section.title), `${page.file} → ${group.file}`);
      // 지금 쪽의 구획은 쪽 안 주소(#제목), 다른 쪽의 구획은 그 쪽의 해당 구획(파일#제목)으로 간다.
      const prefix = group.file === page.file ? "" : group.file;
      assert.deepEqual(group.items.map((item) => item.href), listed.map((section) => `${prefix}#${section.id}`));
    }

    // 이 쪽의 목차: 본문 위 상자가 아니라 본문 밖(뒤)에 하나, 자기 구획 전부.
    const toc = text.match(/<nav class="toc" aria-label="이 쪽의 목차"><p>이 쪽의 목차<\/p><ol>(.*?)<\/ol><\/nav>/);
    assert.ok(toc, page.file);
    assert.equal(text.match(/class="toc"/g).length, 1);
    assert.ok(text.indexOf('class="toc"') > text.indexOf("</main>"), "목차는 본문 밖에 있다");
    const sections = sourceSections(page, config);
    assert.deepEqual([...toc[1].matchAll(/<li><a href="#([^"]+)">([^<]*)<\/a><\/li>/g)].map((m) => [m[1], m[2]]),
      sections.filter((section) => section.listed).map((section) => [section.id, section.title]));
    // 본문의 구획 제목에는 지도·목차에 올리지 않는 것까지 모두 id가 있다.
    assert.deepEqual(attrs(text.slice(text.indexOf("<main"), text.indexOf("</main>")), "h2", "id"), sections.map((section) => section.id));

    // 본문 건너뛰기 링크가 맨 앞이고 그 대상이 있다. 이전·다음 쪽은 메뉴 순서를 따른다.
    assert.match(text, /<body>\n<a class="skip" href="#main">본문으로 건너뛰기<\/a>/);
    assert.equal(text.match(/<main id="main">/g).length, 1);
    const at = PAGES.indexOf(page);
    const pager = text.match(/<nav class="pager" aria-label="이전·다음 쪽">(.*?)<\/nav>/)[1];
    assert.deepEqual(attrs(pager, "a", "href"), [PAGES[at - 1], PAGES[at + 1]].filter(Boolean).map((p) => p.file));
  }
});

test("사이트 빌드: 줄마다 '이름표: 내용'인 목록만 두 칸(dl)으로 그리고 글자는 그대로 둔다", () => {
  const { html } = build();
  const useCases = html["use-cases.html"];
  assert.equal(useCases.match(/<dl class="facts">/g).length, 8, "장면 여덟 개");
  const labels = [...useCases.matchAll(/<dt>([^<]*)<\/dt>/g)].map((m) => m[1]);
  assert.deepEqual(labels, Array.from({ length: 8 }, () => ["이런 때", "이렇게", "알아 둘 것", "더 읽기"]).flat());
  assert.ok(useCases.includes("<dt>이런 때</dt><dd>AI와 한참 이야기하던 일이 커졌습니다."));
  // 길잡이 1번 항목: 표가 네 줄 사이에 끼어 있어 두 칸 목록이 표 앞(세 줄)과 뒤(한 줄)로 갈라진다.
  assert.match(html["how-to.html"], /<dt>주의<\/dt><dd>[^<]*<\/dd><\/dl><div class="dw-document-table">.*?<\/div><dl class="facts"><dt>자세한 문서<\/dt>/s);
  assert.doesNotMatch(useCases, /<dd>: |<li><strong>이런 때/, "이름표 뒤의 쌍점만 빠진다");
  // 이름표로 시작하지 않는 줄이 섞인 목록(길잡이의 읽는 법)은 목록 그대로다.
  assert.match(html["how-to.html"], /<ul><li>항목마다 같은 순서의 네 줄이다/);
  // 원본의 글자가 빠지지 않았다: 장면마다 네 줄의 내용이 그대로 들어 있다.
  for (const line of read("site/pages/use-cases.md").split("\n").filter((l) => l.startsWith("- **이런 때**: ")))
    assert.ok(useCases.includes(`<dd>${line.slice("- **이런 때**: ".length).replaceAll('"', "&quot;")}</dd>`), line);
});

test("사이트 빌드: 구획 주소는 제목에서 만든 고정 이름이고 쪽 안에서 겹치지 않는다", () => {
  const ids = (titles, taken = new Set(RESERVED_IDS)) => titles.map((title) => sectionId(title, taken));
  // 공백·괄호·가운뎃점·따옴표·꺾쇠는 "-" 하나로, 영문은 소문자로, 한글·숫자·붙임표는 그대로.
  assert.deepEqual(ids(["밤에 맡기기 (Autopilot)", "감시기·대시보드 갱신하기", "작업자-검수자 왕복", "Why", "Node.js 24 이상"]),
    ["밤에-맡기기-autopilot", "감시기-대시보드-갱신하기", "작업자-검수자-왕복", "why", "node-js-24-이상"]);
  assert.deepEqual(ids([`Q&A "따옴표" <역할> 쓰기`, "  앞뒤 공백  ", "…!?", "(*)"]), ["q-a-따옴표-역할-쓰기", "앞뒤-공백", "section", "section-2"]);
  // 같은 제목이 또 나오면 뒤에 번호가 붙고, 틀이 쓰는 id(건너뛰기 대상 main 등)와도 겹치지 않는다.
  assert.deepEqual(ids(["끄기", "끄기", "끄기", "Main", "main", "Team Caption"]), ["끄기", "끄기-2", "끄기-3", "main-2", "main-3", "team-caption-2"]);
  // 자모가 풀린 글자(NFD)로 적혀도 같은 주소다.
  assert.equal(sectionId("끄기".normalize("NFD"), new Set()), "끄기");
  // 순서가 바뀌거나 다른 제목이 빠져도 같은 제목은 같은 주소다.
  assert.deepEqual(ids(["가", "나", "다"]).slice(1), ids(["나", "다"]));
  assert.deepEqual(ids(["다", "가"]).sort(), ids(["가", "다"]).sort());

  // 실제 빌드: 모든 쪽에서 id가 겹치지 않고, 순번 주소(#s1…)는 남아 있지 않다.
  const { html, all } = build();
  for (const page of PAGES) {
    const found = attrs(html[page.file], "\\w+", "id");
    assert.equal(new Set(found).size, found.length, page.file + ": 겹치는 id");
  }
  assert.doesNotMatch(all, /#s\d+"|id="s\d+"/);
  assert.match(html["use-cases.html"], /<h2 id="밤에-맡기기-autopilot">밤에 맡기기 \(Autopilot\)<\/h2>/);
  // 지도·목차에서 빼는 제목(mapSkip)은 원본에 실제로 있어야 하고, 본문에는 id와 함께 남는다.
  const config = loadConfig();
  for (const page of PAGES.filter((p) => p.mapSkip)) {
    for (const title of page.mapSkip) assert.ok(sourceTitles(page, config).includes(title), `${page.source}에 없는 제목: ${title}`);
  }
  assert.match(html["how-to.html"], /<h2 id="why">Why<\/h2>/);
  assert.match(html["how-to.html"], /<h2 id="읽는-법">읽는 법<\/h2>/);
  assert.doesNotMatch(all, /<li><a href="[^"]*#(?:why|읽는-법)">/, "지도·목차에는 없다");
});

test("사이트 빌드: 본문 속 명령은 낱말마다 묶되 글자는 그대로이고, 여러 줄 명령 상자는 건드리지 않는다", () => {
  const { html } = build();
  for (const page of PAGES.filter((p) => p.source.endsWith(".md"))) {
    const text = html[page.file];
    // 묶음 안에는 공백도 태그도 없다(낱말 하나). 묶음을 걷어 내면 code 안에 태그가 남지 않는다.
    for (const [, word] of text.matchAll(/<span class="w">(.*?)<\/span>/g)) assert.doesNotMatch(word, /[ <]/, page.file + ": " + word);
    for (const [, inner] of unwrapWords(text).matchAll(/<code>(.*?)<\/code>/gs)) assert.doesNotMatch(inner, /<span/, page.file);
    for (const [block] of text.matchAll(/<pre[\s\S]*?<\/pre>/g)) assert.doesNotMatch(block, /<span/, page.file + ": pre는 그대로");
  }
  assert.ok(html["use-cases.html"].includes(
    '<code><span class="w">kadan</span> <span class="w">adopt</span> <span class="w">my-app-감독</span> <span class="w">--model</span> <span class="w">&lt;모델&gt;</span></code>'));
  assert.match(html["start.html"], /<pre><code>git clone https:\/\/github\.com\/fwkyle\/kadan\.git\n/);
  // 스타일: 낱말은 한 줄보다 길 때만 그 안에서 접힌다(넘치지 않는다).
  assert.match(read("site/style.css"), /code \.w \{ display: inline-block; max-width: 100%; \}/);
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

test("사이트 빌드: 설정의 숨김 목록에 제목을 넣으면 길잡이 항목과 유즈케이스가 공개 빌드에서 빠진다", () => {
  // 지금은 숨기는 것이 없다. 감독 나누기도 실제 명령과 함께 공개된다.
  const config = loadConfig();
  assert.deepEqual(config.howToExclude, []);
  assert.deepEqual(config.hiddenUseCases, []);
  const shown = build();
  assert.match(shown.html["use-cases.html"], /감독을 나눈다<\/h2>/);
  assert.match(shown.html["how-to.html"], /감독을 나눈다<\/h2>/);
  assert.equal(shown.html["how-to.html"].match(/<h2 id=/g).length, 11, "Why·읽는 법 + 항목 아홉 개");
  assert.equal(shown.html["use-cases.html"].match(/<h2 id=/g).length, 8);
  for (const file of ["how-to.html", "use-cases.html"])
    assert.ok(unwrapWords(shown.html[file]).includes("<code>kadan limit set conductor-works &lt;개수&gt;</code>"), file);
  // 작업 중 문장이 공개 쪽 어디에도 없다.
  assert.doesNotMatch(shown.all, /장치 PR|자리만|머지된 뒤 채운다|확정/);

  // 숨김 장치: 제목을 넣으면 그 구획만 빠진다. 빼는 대상이 원본에 실제로 있어야 한다.
  const titles = { howToExclude: [SPLIT], hiddenUseCases: [SPLIT] };
  for (const [file, key] of [["docs/how-to.md", "howToExclude"], ["site/pages/use-cases.md", "hiddenUseCases"]])
    assert.deepEqual(dropSections(read(file), titles[key]).dropped, titles[key], file);
  // 숨기지 않으면 다른 쪽의 사이트 지도에도 그 항목이 있다(시작하기 쪽에서 유즈케이스·길잡이의 해당 구획으로 간다).
  const splitId = sectionId(SPLIT, new Set());
  assert.equal(splitId, "일이-쌓이면-감독을-나눈다");
  for (const target of [`use-cases.html#${splitId}`, `how-to.html#${splitId}`])
    assert.ok(shown.html["start.html"].includes(`<li><a href="${target}">${SPLIT}</a></li>`), target);
  const hidden = build(titles);
  // 숨기면 본문뿐 아니라 모든 쪽의 사이트 지도·목차에서도 빠진다(전체 결과에 그 글자가 없다).
  assert.doesNotMatch(hidden.all, /감독을 나눈|conductor-works/);
  // 숨겨도 남은 항목들의 주소는 그대로다: 숨긴 빌드의 구획 주소 = 숨기지 않은 빌드의 주소에서 그 하나만 뺀 것.
  const anchors = (page) => attrs(page, "a", "href").filter((href) => href.includes("#") && !external(href));
  for (const file of PAGES.map((page) => page.file))
    assert.deepEqual(anchors(hidden.html[file]), anchors(shown.html[file]).filter((href) => !href.endsWith(`#${splitId}`)), file);
  assert.ok(anchors(shown.html["start.html"]).length - anchors(hidden.html["start.html"]).length === 4, "지도 두 벌 × (유즈케이스·길잡이)");
  assert.equal(hidden.html["how-to.html"].match(/<h2 id=/g).length, 10);
  assert.equal(hidden.html["use-cases.html"].match(/<h2 id=/g).length, 7);
  // 원본에 없는 제목은 아무것도 빼지 않고, 빠진 것이 없다고 알려 준다.
  assert.deepEqual(dropSections(read("docs/how-to.md"), ["없는 제목"]).dropped, []);
});

test("사이트 빌드: 코드 울타리 안의 '## 제목'은 구획이 아니다", () => {
  const text = "# T\n\n## Keep\n```md\n## Hidden\nexample\n```\nafter keep\n\n## Hidden\nreal hidden\n\n~~~\n## End\n~~~\n\n## End\nend\n";
  const result = dropSections(text, ["Hidden"]);
  assert.deepEqual(result.dropped, ["Hidden"]);
  assert.equal(result.text, "# T\n\n## Keep\n```md\n## Hidden\nexample\n```\nafter keep\n\n## End\nend\n");
  assert.deepEqual(splitSections(text).map((part) => part.split("\n")[0]), ["# T", "## Keep", "## Hidden", "## End"]);
  // 아무것도 빼지 않으면 글이 그대로다.
  assert.equal(dropSections(text, []).text, text);
  assert.equal(dropSections(read("docs/how-to.md"), []).text, read("docs/how-to.md"));
});

test("사이트 빌드: 길잡이의 세 길 표가 사이트에서도 표로 그려지고 그림마다 크기를 적는다", () => {
  const { html } = build();
  assert.equal(html["how-to.html"].match(/<div class="dw-document-table">/g).length, 1);
  assert.equal(html["how-to.html"].match(/<tr>/g).length, 4);
  const images = html["index.html"].match(/<img\b[^>]*>/g);
  assert.equal(images.length, 2);
  for (const image of images) assert.match(image, /\swidth="\d+" height="\d+"/, image);
});

test("사이트 빌드: 글의 HTML은 글자로만 나오고 설정값도 태그가 되지 않는다", () => {
  const { html } = build({ title: `<script>alert(1)</script>`, lede: `"><img src=x onerror=1>`, enSummary: "<b>x</b>" });
  assert.doesNotMatch(html["index.html"], /<script|<img src=x|<b>x/);
  assert.ok(html["index.html"].includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  // 길잡이의 `<역할>` 같은 자리표시는 글자로 보인다.
  assert.ok(unwrapWords(html["how-to.html"]).includes("<code>kadan restart &lt;역할&gt; --reason &quot;&lt;이유&gt;&quot;</code>"));
  assert.doesNotMatch(Object.values(html).join(""), /<역할>|<모델>/);
});

test("사이트 빌드: 안쪽 링크는 모두 상대 경로이고 가리키는 쪽·그림·구획이 결과에 있다", () => {
  const { html, outDir } = build();
  const idsOf = Object.fromEntries(PAGES.map((page) => [page.file, new Set(attrs(html[page.file], "\\w+", "id"))]));
  let crossPage = 0;
  for (const page of PAGES) {
    const text = html[page.file];
    const targets = [...attrs(text, "a", "href"), ...attrs(text, "link", "href"), ...attrs(text, "img", "src")];
    assert.ok(targets.length > 5, page.file);
    for (const target of targets) {
      if (external(target)) continue;
      assert.doesNotMatch(target, /^\//, `${page.file}: 루트 기준 경로는 하위 경로에서 깨진다 — ${target}`);
      const [file, anchor] = target.split("#");
      if (file) assert.ok(fs.existsSync(path.join(outDir, file)), `${page.file}: 없는 파일 ${target}`);
      // 구획 주소는 같은 쪽이든 다른 쪽이든(사이트 지도) 가리키는 쪽에 그 id가 있어야 한다.
      // 한글이 든 주소는 그대로 적든 퍼센트로 적든 같은 곳이다. 풀어서 id와 견준다.
      if (anchor !== undefined) assert.ok(idsOf[file || page.file]?.has(decodeURIComponent(anchor)), `${page.file}: 없는 구획 ${target}`);
      if (file && anchor !== undefined) crossPage++;
    }
  }
  assert.ok(crossPage > 50, "사이트 지도가 다른 쪽의 구획으로 가는 링크를 낸다");
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
