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
