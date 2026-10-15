// 명령 공용 바닥 함수 — 오류 종료·세션 이름·화면 글자 정리·최근 시작 기록 (HW-3-impl: cli.mjs에서 옮김)
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readMailBody, ledgerBy, readLedger } from "./ledger.mjs";

export function recentSends(entries) {
  // 카드 제목은 plan 줄에만 있다. 우편함에서 id만 보면 무슨 카드인지 모른다 (2026-09-06).
  const titles = new Map();
  for (const entry of entries) {
    if (entry?.kind === "plan" && entry.taskId && entry.title) titles.set(entry.taskId, entry.title);
  }
  return entries
    .filter((entry) => entry?.kind === "send")
    .slice(-20)
    .reverse()
    .map((entry) => ({
      at: entry.t,
      by: ledgerBy(entry),
      role: entry.role ?? "모름",
      taskId: entry.taskId ?? "-",
      ...(entry.taskId && titles.has(entry.taskId) ? { title: titles.get(entry.taskId) } : {}),
      ...(entry.preview ? { preview: entry.preview } : {}),
      ...(entry.digest ? { digest: entry.digest } : {}),
      ...(entry.digest && readMailBody(entry.digest) ? { body: readMailBody(entry.digest) } : {}),
      bytes: entry.bytes ?? null,
    }));
}

export const die = (message, code = 1) => {
  console.error(`오류: ${message}`);
  process.exit(code);
};

export function sessionName(role) {
  const safe = role
    .trim()
    .replace(/[^\p{L}\p{N}\p{Extended_Pictographic}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (!safe) die("역할 이름이 비어 있거나 부적합하다");
  return `kadan-${safe}`;
}

export function stripAnsi(text) {
  return text
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    // Rottie는 렌더된 화면이 아니라 원시 TUI 스트림을 준다. 절대 커서 이동을 그냥
    // 지우면 완료 줄과 다음 입력 프롬프트가 붙으므로 줄 경계로 보존한다(2026-08-30).
    .replace(/\x1b\[[0-9;?]*[Hf]/g, "\n")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "");
}

export function tailLines(text, count) {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.slice(-count).join("\n");
}

export function digest(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export function lastStartFor(session) {
  const starts = readLedger().filter(
    (entry) => entry.kind === "start" && entry.session === session
  );
  return starts[starts.length - 1] || null;
}

export function recordedPid(entry) {
  return entry?.panePid ?? entry?.rottiePid ?? null;
}

export function normalizeFloorRead(value) {
  if (typeof value === "string") {
    return {
      text: value,
      cursor: null,
      gap: null,
      incremental: false,
    };
  }
  return {
    text: value?.text ?? "",
    cursor: value?.cursor ?? null,
    gap: value?.gap ?? null,
    incremental: value?.incremental === true,
  };
}
export function sleepMs(ms) { if (ms > 0) spawnSync("sleep", [String(ms / 1000)]); }

export function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    // `--` 뒤는 다른 명령의 인자라 해석하지 않고 그대로 넘긴다(kadan limit run, 2026-10-02 [kyle]).
    if (arg === "--") { rest.push(...argv.slice(index)); break; }
    if (
      arg === "--raw" || arg === "--hidden" || arg === "--user-notify" || arg === "--help" ||
      arg === "--writers-stopped" || arg === "--at-boundary" || arg === "--source-ended" ||
      arg === "--force-no-card" || arg === "--expect-reply" || arg === "--reply-final" || arg === "--all" ||
      arg === "--unread" || arg === "--mailbox" || arg === "--dry-run" || arg === "--close-card" || arg === "--inherit-mail" || arg === "--previous-generations" ||
      arg === "--once" || arg === "--stdin" || arg === "--archive" || arg === "--quiet" ||
      arg === "--from-screen" || arg === "--next-block" || arg === "--no-prompt" ||
      arg === "--apply" || arg === "--manual" || arg === "--force"
    ) {
      flags[arg.slice(2)] = true;
    } else if (arg.startsWith("--")) {
      const name = arg.slice(2);
      let value;
      if (index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
        value = argv[++index];
      } else {
        value = true;
      }
      if (Object.hasOwn(flags, name)) {
        flags[name] = Array.isArray(flags[name])
          ? [...flags[name], value]
          : [flags[name], value];
      } else {
        flags[name] = value;
      }
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}
