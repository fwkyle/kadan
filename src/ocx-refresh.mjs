// 감시기의 ocx 사용량 새로고침 (2026-10-18 [kyle] 결정)
// codex가 429·한도 화면을 낼 때 opencodex 프록시(ocx)가 옛 사용량 숫자를 붙들고 있을 수 있다. 감시기가 한도 경보를 처음 만들 때
// `ocx account refresh openai`를 한 번 불러 숫자를 새로 받고, 결과를 경보에 붙인다. 멈춘 창을 푸는 일은 하지 않는다(감독 몫).
// 지키는 것: 명령은 이 하나뿐, 전 역할 통틀어 30분에 1번, 시간 상한 30초, ocx 원래 출력(stdout·stderr)은 어디에도 저장하지 않는다.
import { spawnSync } from "node:child_process";

export const OCX_REFRESH_INTERVAL_MS = 30 * 60_000;
export const OCX_REFRESH_TIMEOUT_MS = 30_000;
// 새로 받은 사용량이 이 값 미만이면 가짜 한도로 본다.
export const OCX_LOW_USAGE_PERCENT = 90;

const percent = (text, re) => {
  const value = Number(text.match(re)?.[1]);
  return Number.isFinite(value) ? Math.min(100, Math.round(value)) : undefined;
};

// 출력 모양은 실제 refresh를 부르지 않고는 확인하지 못했다(목록 `ocx account list`에는 사용량이 없다). 그래서 '5시간/주간 낱말과 같은 줄의 퍼센트'만
// 느슨하게 뽑고, 못 뽑으면 숫자 없이 '미확인' 경로로 둔다. 읽은 출력은 이 함수 밖으로 나가지 않는다.
export function parseUsage(text) {
  const body = String(text ?? "");
  const fiveHour = percent(body, /(?:5[\s-]*h(?:ou)?(?:rs?)?\b|five[- ]hour|5시간|primary)[^\n%]*?(\d{1,3}(?:\.\d+)?)\s*%/iu);
  const weekly = percent(body, /(?:week(?:ly)?|주간|secondary)[^\n%]*?(\d{1,3}(?:\.\d+)?)\s*%/iu);
  return { ...(fiveHour !== undefined ? { fiveHour } : {}), ...(weekly !== undefined ? { weekly } : {}) };
}

const entryAt = (entry) => (Number.isFinite(entry?.at) ? entry.at : Date.parse(entry?.t));

// 새로고침은 한도 경보의 세션이 'openai를 쓰는 codex'일 때만 부른다. 시작 기록의 harness·model·cmd로 판단하고 근거를 돌려준다.
// 공급자 접두어가 붙은 모델(`kimi/k3[1m]`, `zai/…`)이거나 `model_provider`가 openai가 아니면 대상이 아니다 — codex로 띄운 대체 실행기의
// 한도에 openai 새로고침을 부르면 원인과 무관한 외부 호출이고, 30분 상한을 엉뚱한 공급자가 먼저 쓴다(2026-10-18 검수).
export function codexBasis(entries, role) {
  const start = (entries ?? []).findLast((e) => e?.kind === "start" && e.role === role);
  if (!start) return null;
  const word = String(start.harness ?? "").split("/").pop();
  if (!/codex/iu.test(word)) return null;
  const model = String(start.model ?? "").replace(/^["']|["']$/gu, "");
  if (model.includes("/")) return null;
  const provider = String(start.cmd ?? "").match(/model_provider\s*=\s*["']?([\w.-]+)/iu)?.[1];
  if (provider && provider.toLowerCase() !== "openai") return null;
  return `start 기록 harness=${word}${model ? ` model=${model}` : ""}${provider ? ` model_provider=${provider}` : ""}`;
}

// 우리가 띄운 묶음(pgid = 그 프로세스 pid)만 끝낸다. pid가 없거나 1 이하면 아무것도 하지 않는다.
function killGroup(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try { process.kill(-pid, "SIGKILL"); } catch { /* 이미 없음 */ }
}

export function createOcxRefresher({ record = () => {}, env = process.env, run = spawnSync, timeoutMs = OCX_REFRESH_TIMEOUT_MS } = {}) {
  // 같은 순회 안에서 원장 읽기가 낡아도 두 번 부르지 않게 마지막 결과를 메모리에도 둔다.
  let memo = null;
  return function refresh({ entries, now, trigger }) {
    const ledger = (entries ?? []).findLast((e) => e?.kind === "ocx-refresh");
    const last = [ledger, memo].filter(Boolean).sort((a, b) => entryAt(b) - entryAt(a))[0];
    if (last && now - entryAt(last) < OCX_REFRESH_INTERVAL_MS) {
      return { ...summary(last), cached: true, ageMs: Math.max(0, now - entryAt(last)) };
    }
    const bin = env.KADAN_OCX_BIN || "ocx";
    let outcome, exitCode = null, usage = {};
    try {
      const r = run(bin, ["account", "refresh", "openai"], {
        encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1 << 20,
        // 새 프로세스 묶음(setsid)으로 띄운다. 시간 초과 때 직접 띄운 프로세스만 죽고 그 자식이 남지 않게 우리 묶음 전체를 끝낸다.
        detached: true,
      });
      if (r?.error?.code === "ETIMEDOUT") killGroup(r.pid);
      if (r?.error?.code === "ENOENT") outcome = "missing";
      else if (r?.error?.code === "ETIMEDOUT") outcome = "timeout";
      else if (r?.error) outcome = "failed";
      else {
        exitCode = r.status ?? null;
        outcome = r.status === 0 ? "ok" : "failed";
        if (outcome === "ok") usage = parseUsage(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
      }
    } catch {
      outcome = "failed";
    }
    const entry = {
      kind: "ocx-refresh", by: "watch", provider: "openai", at: now, outcome, exitCode, usage,
      trigger: { role: trigger?.role ?? null, session: trigger?.session ?? null },
    };
    memo = entry;
    try { record(entry); } catch { /* 기록 실패가 경보 전달을 막지 않는다 */ }
    return { ...summary(entry), cached: false, ageMs: 0 };
  };
}

const summary = (entry) => ({ outcome: entry.outcome, exitCode: entry.exitCode ?? null, usage: entry.usage ?? {} });

// 경보 본문에 붙는 한 줄. 쉬운 말로, 감독이 할 일까지 적는다.
export function ocxAlertLine(result) {
  const { outcome, exitCode, usage = {}, cached, ageMs } = result;
  const ago = cached ? `${Math.max(1, Math.round(ageMs / 60_000))}분 전 ` : "";
  const head = cached ? `ocx 사용량은 ${ago}새로 받음` : "사용량 새로 받음";
  if (outcome === "missing") return "ocx 없음";
  if (outcome === "timeout") return cached ? `ocx 사용량은 ${ago}새로고침 시간 초과` : "ocx 새로고침 시간 초과";
  if (outcome === "failed") {
    const why = exitCode === null || exitCode === undefined ? "" : `(종료 코드 ${exitCode})`;
    return cached ? `ocx 사용량은 ${ago}새로고침 실패${why}` : `ocx 새로고침 실패${why}`;
  }
  const label = [["5시간", usage.fiveHour], ["주간", usage.weekly]].filter(([, v]) => v !== undefined);
  if (!label.length) return `${head}(숫자 미확인) — 창 확인`;
  const text = label.map(([name, v]) => `${name} ${v}%`).join(" ");
  if (label.every(([, v]) => v < OCX_LOW_USAGE_PERCENT)) {
    return `${head}: ${text} — 가짜 한도였을 가능성, 이 창은 esc 뒤 재개 필요(자동 재개 안 함)`;
  }
  return cached
    ? `${head}: ${text} — 아직 높음, 대체 실행기 고려`
    : `새로 받아도 한도(${text}) — 대체 실행기 고려`;
}
