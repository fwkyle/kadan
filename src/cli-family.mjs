// 역할 이름·모델 계열 표시와 계열 충돌 경고 (HW-3-impl: cli.mjs에서 옮김)
import { resolveLedgerBy } from "./ledger.mjs";
import { boardFromRole } from "./board.mjs";

export function dutyHead(role) {
  if (typeof role !== "string" || !role) return "";
  return role.slice((boardFromRole(role)?.length ?? -1) + 1).split("-")[0];
}

// 모델 이름 앞머리 규칙. 실행기별 어댑터가 아니다.
// openai-codex/gpt-6-astra 처럼 provider 접두가 있어도 마지막 이름 조각으로 읽는다.
export function modelFamily(model) {
  if (typeof model !== "string" || !model.trim()) return "모름";
  const name = model.trim().split("/").pop() ?? "";
  if (/^gpt/i.test(name)) return "gpt";
  if (/^claude/i.test(name)) return "claude";
  // claude 실행기는 짧은 별명으로 띄운다(--model fable, --model opus). 앞머리가 claude가 아니라 모름으로 빠졌다(2026-09-12 실측).
  if (/^(fable|opus|sonnet|haiku)/i.test(name)) return "claude";
  if (/^glm/i.test(name)) return "glm";
  if (/^kimi/i.test(name) || /^k3/i.test(name)) return "kimi";
  if (/^grok/i.test(name)) return "grok";
  if (/^deepseek/i.test(name)) return "deepseek";
  if (/^gemini/i.test(name)) return "gemini";
  // devin 실행기는 자기 모델을 swe-2-max 처럼 부른다. 모름으로 빠지면 계열 겹침 검사가 무력해진다(2026-09-13 실측).
  if (/^swe/i.test(name)) return "swe";
  return "모름";
}

export function startDisplay(start) {
  const harness =
    typeof start?.harness === "string" && start.harness.trim()
      ? start.harness.trim()
      : "모름";
  const model =
    typeof start?.model === "string" && start.model.trim()
      ? start.model.trim()
      : "모름";
  return {
    harness,
    model,
    family: modelFamily(model === "모름" ? undefined : model),
  };
}

function lastStartModel(entries, role) {
  const last = (entries ?? []).filter((entry) => entry?.kind === "start" && entry.role === role).at(-1);
  return typeof last?.model === "string" && last.model ? last.model : undefined;
}

// 검수자에게 보낼 때만 같은 판 작업자 최신 start 모델과 계열을 비교한다.
// 겹치거나 한쪽이 모름이면 경고·원장만 남기고, 전송은 막지 않는다.
export function familyConflictAlerts({ role, session, entries = [], source, env } = {}) {
  if (dutyHead(role) !== "검수자") return [];
  const board = boardFromRole(role);
  const latestWorkerStart = new Map();
  for (const entry of entries) {
    if (entry?.kind !== "start") continue;
    if (dutyHead(entry.role) !== "작업자") continue;
    if (boardFromRole(entry.role) !== board) continue;
    latestWorkerStart.set(entry.role, entry);
  }
  const reviewerModel = lastStartModel(entries, role);
  const reviewerFamily = modelFamily(reviewerModel);
  const out = [];
  for (const [workerRole, start] of latestWorkerStart) {
    const workerModel = typeof start.model === "string" && start.model ? start.model : undefined;
    const workerFamily = modelFamily(workerModel);
    if (reviewerFamily !== "모름" && workerFamily !== "모름" && reviewerFamily !== workerFamily) continue;
    const shownWorker = workerModel ?? "모름";
    const shownReviewer = reviewerModel ?? "모름";
    out.push({
      warning: `경고: 계열겹침 작업자=${workerRole} 모델=${shownWorker} 계열=${workerFamily} / 검수자=${role} 모델=${shownReviewer} 계열=${reviewerFamily}`,
      alert: {
        kind: "alert",
        alertKind: "계열겹침",
        level: "AMBER",
        role,
        session,
        counterpart: workerRole,
        ...(reviewerModel ? { model: reviewerModel } : {}),
        ...(workerModel ? { counterpartModel: workerModel } : {}),
        family: reviewerFamily,
        counterpartFamily: workerFamily,
        by: resolveLedgerBy({ source, env }),
      },
    });
  }
  return out;
}
