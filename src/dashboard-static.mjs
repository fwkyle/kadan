import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = fileURLToPath(new URL("../gui/dist/", import.meta.url));
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
export const DASHBOARD_BUILD_COMMAND = "npm --prefix gui ci && npm run build:gui";

// 대시보드 화면 빌드를 읽을 수 있는지 본다. serveDashboard가 "/"에 503을 내는 조건과 같다:
// gui/dist 폴더가 있는지가 아니라 index.html을 파일로 읽을 수 있는지다. 아무것도 만들거나 고치지 않는다.
export function dashboardBuild({ root = defaultRoot } = {}) {
  const file = path.join(root, "index.html");
  try {
    if (!fs.statSync(file).isFile()) throw new Error("not a file");
    fs.closeSync(fs.openSync(file, "r"));
    return { ok: true, file };
  } catch (error) {
    return { ok: false, file, reason: error.code === "ENOENT" ? "파일이 없다" : "읽을 수 없다" };
  }
}

export function serveDashboard(
  request,
  response,
  url,
  { root = defaultRoot } = {},
) {
  if (
    !["GET", "HEAD"].includes(request.method) ||
    !(url.pathname === "/" || url.pathname.startsWith("/dashboard-assets/"))
  )
    return false;
  let relative;
  try {
    relative =
      url.pathname === "/"
        ? "index.html"
        : decodeURIComponent(url.pathname.slice("/dashboard-assets/".length));
  } catch {
    response.writeHead(400);
    response.end("잘못된 주소");
    return true;
  }
  const resolved = path.resolve(root, relative),
    prefix = path.resolve(root) + path.sep;
  if (!resolved.startsWith(prefix) || relative.includes("\0")) {
    response.writeHead(403);
    response.end("허용되지 않는 경로");
    return true;
  }
  let bytes;
  try {
    if (!fs.statSync(resolved).isFile()) throw new Error("not a file");
    bytes = fs.readFileSync(resolved);
  } catch {
    response.writeHead(url.pathname === "/" ? 503 : 404, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(
      url.pathname === "/"
        ? "대시보드 빌드가 없습니다. npm --prefix gui ci 후 npm run build:gui를 실행하세요."
        : "화면 파일을 찾을 수 없습니다",
    );
    return true;
  }
  response.writeHead(200, {
    "content-type": types[path.extname(resolved)] || "application/octet-stream",
    "content-length": bytes.length,
    "cache-control": relative.startsWith("assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "x-content-type-options": "nosniff",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(request.method === "HEAD" ? undefined : bytes);
  return true;
}
