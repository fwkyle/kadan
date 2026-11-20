import { JsonValue } from "../ui";
import { describeEvent, planRevert, type SettingsEvent } from "../revert";
import type { RunnersData, Settings } from "./Runners";

const stamp = (value?: string) => {
  const at = value ? new Date(value) : null;
  if (!at || Number.isNaN(at.getTime())) return value ?? "";
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
};

// '최근 변경' 표(서버가 주는 설정 변경 사건 최근 10건). 줄마다 '되돌리기': 그 변경이 바꾼 칸만 이전 값으로 변경안(저장 전)에 채운다.
// 저장은 하지 않고 기존 '저장'을 눌러야 반영된다. locked가 문구면 모든 줄의 되돌리기를 끄고 그 이유를 보인다
// (마지막으로 받은 설정으로 그리는 동안·원격 보기·비교 모드·저장 중·충돌).
export function RecentChanges({ data, saved, draft, locked, fill }: {
  data: RunnersData; saved: Settings | null; draft: Settings | null; locked: string | null;
  fill?: (event: SettingsEvent, apply: (draft: Settings) => Settings) => void;
}) {
  const history = (data.history ?? []) as SettingsEvent[];
  return (
    <details className="recent-changes" open>
      <summary>최근 변경 {history.length}건</summary>
      {history.length === 0 ? <p className="muted">기록 없음</p> : (
        <div className="table-scroll">
          <table className="change-table">
            <thead>
              <tr><th>시각</th><th>버전</th><th>무엇을</th><th>전 → 후</th><th>되돌리기</th></tr>
            </thead>
            <tbody>
              {history.map((event, i) => {
                const text = describeEvent(event, data.roles);
                const plan = saved && draft ? planRevert(event, saved, draft, data) : null;
                const why = locked ?? (plan?.state === "blocked" ? plan.reason : plan?.state === "filled" ? "변경안에 채웠습니다 — 저장하면 반영됩니다" : null);
                return (
                  <tr key={`${event.revision}:${i}`}>
                    <td data-label="시각">{stamp(event.t)}</td>
                    <td data-label="버전">{event.revision ?? ""}</td>
                    <td data-label="무엇을">{text.what}<small className="muted"> · {event.by ?? "모름"}{event.reason ? ` · ${event.reason}` : ""}</small></td>
                    <td data-label="전 → 후">
                      {text.change || <span className="muted">원문에서 확인</span>}
                      <details className="raw"><summary>원문</summary><JsonValue value={event} /></details>
                    </td>
                    <td data-label="되돌리기">
                      <button type="button" className="row-revert"
                        disabled={locked !== null || plan?.state !== "ready"}
                        onClick={() => plan?.state === "ready" && fill?.(event, plan.apply)}>
                        {plan?.state === "filled" && locked === null ? "채움" : "되돌리기"}
                      </button>
                      {why && <span className="why muted">{why}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
