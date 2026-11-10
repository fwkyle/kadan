// 대시보드 '길잡이' 화면의 재료. docs/how-to.md 한 파일만 읽어 기존 문서 렌더러로 그린다.
// 원장·카드·우편을 읽지 않는다(요청마다 고정 크기 파일 하나).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { documentLink, escapeHtml, renderCardDocument } from "./card-content.mjs";

// 설치본 기준 위치(src/dashboard-static.mjs가 gui/dist를 찾는 방식과 같다).
const defaultFile = fileURLToPath(new URL("../docs/how-to.md", import.meta.url));
const MAX_BYTES = 256 * 1024;
const MISSING =
  "길잡이 문서(docs/how-to.md)를 읽을 수 없습니다. 설치한 폴더의 docs/how-to.md를 확인하세요.";

// 문서 사이 링크(adopt.md 등)는 대시보드 주소가 아니다. 죽은 링크로 만들지 않고 저장소 경로를 글자로 보인다.
function howToLink(label, target) {
  const raw = String(target).trim();
  const outside =
    /^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith("//") || raw.startsWith("#");
  if (outside || /[\u0000-\u001f\u007f]/u.test(raw)) return documentLink(label, raw);
  const [file, anchor] = raw.split("#");
  const shown = path.posix.normalize("docs/" + file) + (anchor ? "#" + anchor : "");
  return (
    `<span class="dw-document-reference" title="${escapeHtml("저장소 안 문서: " + shown)}">` +
    `${escapeHtml(label)} <code>${escapeHtml(shown)}</code></span>`
  );
}

export function howToData({ file = defaultFile } = {}) {
  let text;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("unreadable");
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { title: null, html: null, error: MISSING };
  }
  // 첫 줄의 큰 제목은 화면 제목으로 따로 보낸다(본문에서 두 번 보이지 않게).
  const head = text.match(/^﻿?#\s+(.+)\r?\n/);
  return {
    title: head ? head[1].trim() : null,
    html: renderCardDocument(head ? text.slice(head[0].length) : text, { link: howToLink }),
    error: null,
  };
}
