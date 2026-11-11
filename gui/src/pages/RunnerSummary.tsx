import { fallbackLabels } from "../runner-draft";
import { HARD_ROLE } from "../preset-draft";
import type { Choice, RunnersData, Settings } from "./Runners";

const text = (c: Choice) => [c.runner, c.model, c.effort].filter(Boolean).join(" / ");

// 요약표 한 줄의 글. 어려운 일 작업자는 값이 없는 것이 기본이라 "미설정" 대신 "작업자와 같음"으로 말한다.
export function summaryCells(data: RunnersData, role: string, settings: Settings = data.settings!) {
  const current = settings.presets[settings.activePreset].roles[role] as Choice | undefined;
  const fallbacks = fallbackLabels(settings, role);
  if (role === "senior")
    return { value: fallbacks.join(" + ") || "미설정", fallbacks: [], note: "없음 (등록된 시니어 전원에게 동시에 묻습니다)", command: data.commands[role] };
  if (role === HARD_ROLE)
    return {
      value: current ? text(current) : "비어 있음 — 작업자와 같음",
      fallbacks: [],
      note: "없음 (폴백 없음)",
      command: data.commands[role] ?? "작업자와 같은 명령으로 띄웁니다",
    };
  return { value: current ? text(current) : "미설정", fallbacks, note: "없음", command: data.commands[role] };
}

export function RunnerSummary({ data }: { data: RunnersData }) {
  return (
    <div className="table-scroll runners-summary">
      <table>
        <thead>
          <tr>
            <th>역할</th>
            <th>지금 값</th>
            <th>대체 후보 (순서대로)</th>
            <th>발령 때 채워질 명령</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(data.roles).map(([role, label]) => {
            const cells = summaryCells(data, role);
            return (
              <tr key={role}>
                <th>{label}</th>
                <td>{cells.value}</td>
                <td>
                  {cells.fallbacks.length ? (
                    <ol>
                      {cells.fallbacks.map((item, i) => (
                        <li key={i}>{item}</li>
                      ))}
                    </ol>
                  ) : (
                    cells.note
                  )}
                </td>
                <td>
                  <code>{cells.command}</code>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
