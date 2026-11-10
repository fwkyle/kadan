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

// 위 메뉴 순서 그대로다. base는 그 글 안의 상대 링크가 기준으로 삼는 저장소 폴더다.
export const PAGES = [
  { file: "index.html", nav: "홈", source: "site/pages/home.html" },
  { file: "start.html", nav: "시작하기", source: "site/pages/start.md", base: "" },
  { file: "use-cases.html", nav: "유즈케이스", source: "site/pages/use-cases.md", base: "", drop: "hiddenUseCases" },
  { file: "how-to.html", nav: "상황별 길잡이", source: "docs/how-to.md", base: "docs", drop: "howToExclude" },
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

function renderMarkdownPage(page, config) {
  const { text } = dropSections(read(page.source), config[page.drop] ?? []);
  const head = text.match(/^﻿?#\s+(.+)\r?\n/);
  const title = head ? head[1].trim() : page.nav;
  let count = 0;
  const toc = [];
  const body = liftHeadings(renderCardDocument(head ? text.slice(head[0].length) : text, { link: siteLink(config, page.base) }))
    .replace(/<h2>(.*?)<\/h2>/g, (_, inner) => {
      const id = `s${++count}`;
      toc.push(`<li><a href="#${id}">${inner}</a></li>`);
      return `<h2 id="${id}">${inner}</h2>`;
    });
  const nav = toc.length > 3 ? `<nav class="toc" aria-label="이 쪽의 목차"><ol>${toc.join("")}</ol></nav>` : "";
  // 목차는 머리말 문단 다음, 첫 구획 앞에 둔다.
  const at = body.indexOf("<h2 ");
  const withNav = at < 0 ? body : body.slice(0, at) + nav + body.slice(at);
  return { title, body: `<article class="prose"><h1>${escapeHtml(title)}</h1>${withNav}</article>` };
}

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

function layout(page, { title, body }, config) {
  const nav = PAGES.map((item) =>
    `<a href="${item.file}"${item.file === page.file ? ' aria-current="page"' : ""}>${escapeHtml(item.nav)}</a>`).join("");
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
<header class="top">
<a class="brand" href="index.html">kadan <span>카단</span></a>
<nav aria-label="쪽 이동">${nav}</nav>
</header>
<main id="main"${page.file === "index.html" ? ' class="home"' : ""}>
${body}
</main>
<footer class="bottom">
<p>카단은 Apache-2.0 라이선스의 오픈소스입니다. <a href="${escapeHtml(config.repoUrl)}">GitHub 저장소</a></p>
</footer>
${analytics}</body>
</html>
`;
}

export function buildSite({ outDir = path.join(ROOT, "site-dist"), config: overrides = {} } = {}) {
  const config = loadConfig(overrides);
  fs.mkdirSync(path.join(outDir, "assets"), { recursive: true });
  for (const page of PAGES) {
    const content = page.source.endsWith(".md") ? renderMarkdownPage(page, config) : renderHome(config);
    fs.writeFileSync(path.join(outDir, page.file), layout(page, content, config));
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
