#!/usr/bin/env node
// 공개 소개 사이트 빌드. node 내장 기능만 쓰고, 한 번 돌고 끝난다(고정 크기 원본 몇 개를 읽는다).
// 원본: site/site.config.json(바꿀 값), site/pages/*(쪽 글), site/style.css, docs/how-to.md(길잡이 — 사본을 만들지 않는다).
// 글은 대시보드와 같은 렌더러(src/card-content.mjs)로 바꾼다. 결과 폴더(site-dist/)는 git에 넣지 않는다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { documentLink, escapeHtml, renderCardDocument } from "../src/card-content.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ANALYTICS_SRC = "https://static.cloudflareinsights.com/beacon.min.js";
const ASSETS = ["docs/architecture.svg", "docs/work-flow.svg"];

// 홈의 위 메뉴와 글 쪽의 사이트 지도가 이 순서 그대로다. base는 그 글 안의 상대 링크가 기준으로 삼는 저장소 폴더다.
export const PAGES = [
  { file: "index.html", nav: "홈", source: "site/pages/home.html" },
  { file: "start.html", nav: "시작하기", source: "site/pages/start.md", base: "" },
  { file: "use-cases.html", nav: "유즈케이스", source: "site/pages/use-cases.md", base: "", drop: "hiddenUseCases" },
  // 길잡이의 머리말 두 구획(문서의 목적·읽는 법)은 본문에만 두고 지도·목차에는 아홉 항목만 올린다.
  { file: "how-to.html", nav: "상황별 길잡이", source: "docs/how-to.md", base: "docs", drop: "howToExclude", mapSkip: ["Why", "읽는 법"] },
  { file: "docs.html", nav: "문서", source: "site/pages/docs.md", base: "" },
];
const PAGE_FILES = new Set(PAGES.map((page) => page.file));

const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

export function loadConfig(overrides = {}) {
  const config = { ...JSON.parse(read("site/site.config.json")), ...overrides };
  const token = String(config.analyticsToken ?? "").trim();
  if (token && !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("통계 토큰은 영문·숫자·_·- 만 받습니다");
  const repoUrl = String(config.repoUrl ?? "").replace(/\/+$/, "");
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repoUrl)) throw new Error("repoUrl은 GitHub 저장소 주소여야 합니다");
  return { ...config, analyticsToken: token, repoUrl };
}

// "## 제목" 구획 가운데 제목이 목록에 있는 것을 뺀다. 빠진 제목을 함께 돌려준다(시험이 원본에 있는지 본다).
// 코드 울타리(``` · ~~~) 안의 "## "는 예제 글자라 구획으로 세지 않는다. 닫는 규칙은 렌더러와 같다.
export function splitSections(markdown) {
  const parts = [[]];
  let fence = null;
  for (const line of markdown.split("\n")) {
    const mark = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) { if (line.trim().startsWith(fence)) fence = null; }
    else if (mark) fence = mark[1];
    else if (line.startsWith("## ")) parts.push([]);
    parts.at(-1).push(line);
  }
  return parts.map((lines) => lines.join("\n"));
}

export function dropSections(markdown, titles = []) {
  const [head, ...sections] = splitSections(markdown);
  const hidden = new Set(titles);
  const dropped = [];
  const kept = sections.filter((section) => {
    const title = section.match(/^## (.+)$/m)[1].trim();
    if (!hidden.has(title)) return true;
    dropped.push(title);
    return false;
  });
  return { text: [head, ...kept].join("\n"), dropped };
}

// 글 안의 링크: 사이트의 다른 쪽은 상대 경로, 저장소 문서는 GitHub 공개 주소, 밖의 주소는 기존 표시(새 탭).
function siteLink(config, base) {
  return (label, target) => {
    const raw = String(target).trim();
    const outside = /^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith("//") || raw.startsWith("#");
    if (outside || /[\u0000-\u001f\u007f]/u.test(raw)) return documentLink(label, raw);
    if (PAGE_FILES.has(raw)) return `<a href="${escapeHtml(raw)}">${escapeHtml(label)}</a>`;
    const [file, anchor] = raw.split("#");
    const repoPath = path.posix.normalize(path.posix.join(base, file));
    if (repoPath.startsWith("..") || path.posix.isAbsolute(repoPath)) return documentLink(label, raw);
    const href = encodeURI(`${config.repoUrl}/blob/main/${repoPath}`) + (anchor ? "#" + encodeURIComponent(anchor) : "");
    return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
  };
}

// 렌더러는 문서 제목 아래를 h3부터 그린다(대시보드 화면 기준). 사이트는 쪽 제목이 h1이라 한 단계 올린다.
// 본문 글자는 모두 이스케이프되어 있어 여기 걸리는 것은 렌더러가 만든 태그뿐이다.
const liftHeadings = (html) => html.replace(/<(\/?)h([3-6])>/g, (_, slash, level) => `<${slash}h${level - 1}>`);

// 줄마다 "**이름표**: 내용"으로 시작하는 목록은 이름표와 내용 두 칸(dl)으로 그린다. 글자는 그대로 두고 모양만 바꾼다.
// 한 줄이라도 그 꼴이 아니면 목록 그대로 둔다. 대시보드는 렌더러를 바로 쓰므로 달라지지 않는다.
const LABELED_ITEM = /<li><strong>([^<]+)<\/strong>: ((?:(?!<\/?li>)[\s\S])*)<\/li>/g;
const LABELED_LIST = new RegExp(`<ul>((?:${LABELED_ITEM.source})+)</ul>`, "g");
const labelLists = (html) => html.replace(LABELED_LIST, (_, items) =>
  `<dl class="facts">${items.replace(LABELED_ITEM, "<dt>$1</dt><dd>$2</dd>")}</dl>`);

// 본문 속 짧은 명령(인라인 code): 낱말(띄어쓰기 사이)마다 묶어, 한 줄에 들어가는 낱말은 그 안에서 줄이 바뀌지 않게 한다.
// `--model`이 `--`/`model`로 갈라지던 것을 막는다. 한 줄보다 긴 낱말만 그 안에서 접힌다(스타일의 code .w).
// 글자는 하나도 더하거나 바꾸지 않아 복사한 명령이 그대로다. 여러 줄 명령 상자(pre)는 건드리지 않는다.
const wordWrapCode = (html) => html.split(/(<pre[\s\S]*?<\/pre>)/).map((part) => (part.startsWith("<pre")
  ? part
  : part.replace(/<code>([^<]*)<\/code>/g, (_, inner) =>
    `<code>${inner.split(/( +)/).map((word) => (word.trim() ? `<span class="w">${word}</span>` : word)).join("")}</code>`))).join("");

// 구획 주소(id)는 순번이 아니라 제목에서만 만든다. 그래서 숨김 목록이나 구획 순서가 바뀌어도 같은 제목은 같은 주소다.
// 규칙: 영문은 소문자로, 글자·숫자가 아닌 것(공백·괄호·가운뎃점·따옴표 등)의 이어짐은 "-" 하나로, 앞뒤의 "-"는 뗀다.
// 남는 글자가 없으면 "section". 틀이 쓰는 id(RESERVED_IDS)와 같으면 뒤에 -2를 붙인다(이것도 제목만으로 정해진다).
// 문서 순서에 따라 달라지는 번호는 붙이지 않는다. 한 쪽에서 주소가 겹치면 아래 검사가 빌드를 멈춘다.
export const RESERVED_IDS = ["main", "team-caption"];
export function sectionId(title) {
  const base = String(title).normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "section";
  return RESERVED_IDS.includes(base) ? `${base}-2` : base;
}

// 한 쪽 안에서 두 구획의 주소가 겹치면 빌드를 멈춘다. 같은 제목이 두 번 나오는 경우와, 서로 다른 제목이 같은 주소가 되는
// 경우("A B"와 "A-B") 모두다. 번호를 붙여 넘어가면 순서나 숨김이 바뀔 때 공유된 주소가 다른 구획을 가리키게 된다.
export function assertUniqueSectionIds(source, titles) {
  const seen = new Map();
  for (const title of titles) {
    const id = sectionId(title);
    if (seen.has(id)) {
      throw new Error(`${source}: 구획 제목 "${seen.get(id)}"와(과) "${title}"의 주소가 둘 다 #${id} 입니다. `
        + "한 쪽 안에서는 구획 주소가 겹칠 수 없습니다(숨긴 구획 포함). 둘 중 한 제목을 바꿔 주세요.");
    }
    seen.set(id, title);
  }
}
const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const unescapeHtml = (text) => text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity]);
// 그려진 구획 제목(h2)의 글자: 태그를 걷고 이스케이프를 푼 것. 주소와 지도·목차의 이름이 여기서 나온다.
const headingText = (inner) => unescapeHtml(inner.replace(/<[^>]+>/g, ""));

// 글(markdown) 하나를 그리고 구획 목록(sections)을 함께 돌려준다. 사이트 지도와 "이 쪽의 목차"가 이 목록에서 만들어진다.
// 구획 이름(label)은 렌더러가 이스케이프한 글자에서 태그만 걷어 낸 것이라 그대로 넣어도 된다.
// hidden에 적은 제목의 구획은 통째로 빼고, mapSkip에 적은 제목은 본문에는 그대로 두고 지도·목차에서만 뺀다(map: false).
// 주소 충돌 검사는 숨김보다 먼저, 원본 전체에 대해 한다. 숨긴 구획과 겹치는 것도 잡아야 숨김을 풀 때 빌드가 갑자기 깨지지 않는다.
export function renderMarkdown(markdown, { source = "글", hidden = [], mapSkip = [], link, fallbackTitle = "" } = {}) {
  const body = (md) => md.replace(/^\uFEFF?#\s+.+\r?\n/, "");
  const render = (md) => wordWrapCode(labelLists(liftHeadings(renderCardDocument(body(md), { link }))));
  const { text, dropped } = dropSections(markdown, hidden);
  const html = render(text);
  const whole = dropped.length ? render(markdown) : html;
  assertUniqueSectionIds(source, [...whole.matchAll(/<h2>(.*?)<\/h2>/g)].map(([, inner]) => headingText(inner)));

  const head = text.match(/^\uFEFF?#\s+(.+)\r?\n/);
  const title = head ? head[1].trim() : fallbackTitle;
  const sections = [];
  const article = html.replace(/<h2>(.*?)<\/h2>/g, (_, inner) => {
    const plain = headingText(inner);
    const id = sectionId(plain);
    sections.push({ id, label: inner.replace(/<[^>]+>/g, ""), map: !mapSkip.includes(plain) });
    return `<h2 id="${id}">${inner}</h2>`;
  });
  return { title, sections, body: `<article class="prose"><h1>${escapeHtml(title)}</h1>${article}</article>` };
}

const renderMarkdownPage = (page, config) => renderMarkdown(read(page.source), {
  source: page.source, hidden: config[page.drop] ?? [], mapSkip: page.mapSkip ?? [], link: siteLink(config, page.base), fallbackTitle: page.nav,
});

// 홈의 미리 보기: 숨기지 않은 유즈케이스 앞의 세 개. 유즈케이스 쪽과 같은 원본·같은 숨김 목록을 쓴다.
function useCasePreview(config) {
  const { text } = dropSections(read("site/pages/use-cases.md"), config.hiddenUseCases ?? []);
  return splitSections(text).slice(1, 4).map((section) => {
    const [heading, ...lines] = section.split("\n");
    const title = heading.slice(3);
    const when = lines.map((line) => line.match(/^- \*\*이런 때\*\*: (.+)$/)?.[1]).find(Boolean) ?? "";
    return `    <a class="card" href="use-cases.html"><strong>${escapeHtml(title.trim())}</strong><span>${escapeHtml(when)}</span></a>`;
  }).join("\n");
}

function renderHome(config) {
  const values = {
    title: escapeHtml(config.title),
    lede: escapeHtml(config.lede),
    enSummary: escapeHtml(config.enSummary),
    repoUrl: escapeHtml(config.repoUrl),
    useCasePreview: useCasePreview(config),
  };
  const body = read("site/pages/home.html").replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`홈 틀에 모르는 자리: ${key}`);
    return values[key];
  });
  return { title: null, body };
}

const BRAND = `<a class="brand" href="index.html">kadan <span>카단</span></a>`;
const footer = (config) => `<footer class="bottom">
<p>카단은 Apache-2.0 라이선스의 오픈소스입니다. <a href="${escapeHtml(config.repoUrl)}">GitHub 저장소</a></p>
</footer>`;

// 좁은 화면의 머리줄: 이름 + 접히는 메뉴(details). 홈과 글 쪽이 같은 것을 쓴다.
const menuBar = (page, contents) => `<header class="bar">
${BRAND}
<details class="menu">
<summary><span>메뉴</span></summary>
${siteMap(page, contents)}
</details>
</header>`;

// 홈의 몸통: 넓은 화면은 위쪽 메뉴, 좁은 화면은 글 쪽과 같은 접히는 메뉴 + 한 단(소개 배치).
function homeBody(page, { body }, contents, config) {
  const nav = PAGES.map((item) =>
    `<a href="${item.file}"${item.file === page.file ? ' aria-current="page"' : ""}>${escapeHtml(item.nav)}</a>`).join("");
  return `${menuBar(page, contents)}
<header class="top">
${BRAND}
<nav aria-label="쪽 이동">${nav}</nav>
</header>
<main id="main" class="home">
${body}
</main>
${footer(config)}`;
}

// 사이트 지도: 쪽이 묶음 제목이고 그 아래가 그 쪽의 구획이다. 손으로 적은 목록이 아니라 그려진 쪽들(contents)에서 만든다.
// 같은 지도를 넓은 화면의 옆 칸과 좁은 화면의 접히는 메뉴 두 곳에 넣는다(화면 폭에 따라 한쪽만 보인다). 그래서 id를 달지 않는다.
function siteMap(current, contents) {
  const groups = PAGES.map((page) => {
    const here = page.file === current.file;
    const items = (contents.get(page.file).sections ?? []).filter((section) => section.map)
      .map(({ id, label }) => `<li><a href="${here ? "" : page.file}#${id}">${label}</a></li>`).join("");
    return `<li${here ? ' class="here"' : ""}><a href="${page.file}"${here ? ' aria-current="page"' : ""}>${escapeHtml(page.nav)}</a>`
      + `${items ? `<ol>${items}</ol>` : ""}</li>`;
  }).join("");
  return `<nav class="map" aria-label="사이트 지도"><ol>${groups}</ol></nav>`;
}

// 글 쪽의 몸통: 왼쪽 사이트 지도 · 가운데 본문 · 오른쪽 "이 쪽의 목차". 좁은 화면에서는 지도가 접히는 메뉴(details)가 된다.
function docsBody(page, { body, sections }, contents, config) {
  const map = siteMap(page, contents);
  const listed = sections.filter((section) => section.map);
  const toc = listed.length > 1
    ? `<nav class="toc" aria-label="이 쪽의 목차"><p>이 쪽의 목차</p><ol>${
      listed.map(({ id, label }) => `<li><a href="#${id}">${label}</a></li>`).join("")}</ol></nav>`
    : "";
  const at = PAGES.indexOf(page);
  const step = (item, rel, label) => item
    ? `<a class="${rel}" rel="${rel}" href="${item.file}"><span>${label}</span><strong>${escapeHtml(item.nav)}</strong></a>`
    : "";
  return `${menuBar(page, contents)}
<div class="frame">
<aside class="side">
${BRAND}
${map}
<p class="side-foot"><a href="${escapeHtml(config.repoUrl)}">GitHub 저장소</a></p>
</aside>
<div class="col">
<main id="main">
${body}
</main>
<nav class="pager" aria-label="이전·다음 쪽">${step(PAGES[at - 1], "prev", "이전")}${step(PAGES[at + 1], "next", "다음")}</nav>
${footer(config)}
</div>
${toc}
</div>`;
}

function layout(page, title, inner, config) {
  // 통계 토큰이 비면 스크립트를 넣지 않는다. 사이트가 밖으로 부르는 것은 이 한 줄뿐이다.
  const analytics = config.analyticsToken
    ? `<script defer src="${ANALYTICS_SRC}" data-cf-beacon='${escapeHtml(JSON.stringify({ token: config.analyticsToken }))}'></script>\n`
    : "";
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title ? `${title} · 카단` : `카단 (kadan) · ${config.title}`)}</title>
<meta name="description" content="${escapeHtml(config.lede)}">
<meta name="color-scheme" content="light dark">
<link rel="stylesheet" href="style.css">
</head>
<body>
<a class="skip" href="#main">본문으로 건너뛰기</a>
${inner}
${analytics}</body>
</html>
`;
}

export function buildSite({ outDir = path.join(ROOT, "site-dist"), config: overrides = {} } = {}) {
  const config = loadConfig(overrides);
  fs.mkdirSync(path.join(outDir, "assets"), { recursive: true });
  // 쪽마다 한 번씩만 그린다. 사이트 지도는 이렇게 그려 둔 결과에서 만들어서 원본을 다시 읽지 않는다.
  const contents = new Map(PAGES.map((page) =>
    [page.file, page.source.endsWith(".md") ? renderMarkdownPage(page, config) : renderHome(config)]));
  for (const page of PAGES) {
    const content = contents.get(page.file);
    const inner = content.sections ? docsBody(page, content, contents, config) : homeBody(page, content, contents, config);
    fs.writeFileSync(path.join(outDir, page.file), layout(page, content.title, inner, config));
  }
  fs.copyFileSync(path.join(ROOT, "site/style.css"), path.join(outDir, "style.css"));
  for (const asset of ASSETS) fs.copyFileSync(path.join(ROOT, asset), path.join(outDir, "assets", path.basename(asset)));
  return { outDir, files: [...PAGES.map((page) => page.file), "style.css", ...ASSETS.map((a) => "assets/" + path.basename(a))] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outFlag = process.argv.indexOf("--out");
  const result = buildSite(outFlag > 0 ? { outDir: path.resolve(process.argv[outFlag + 1]) } : {});
  console.log(`사이트 빌드: ${result.files.length}개 파일 → ${result.outDir}`);
}
