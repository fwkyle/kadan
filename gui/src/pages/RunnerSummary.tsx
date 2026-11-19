import { fallbackLabels } from "../runner-draft";
import { HARD_ROLE, SECRETARY_ROLE } from "../preset-draft";
import type { Choice, RunnersData, Settings } from "./Runners";

// 모델을 아직 안 고른 초안은 빈 글자로 두지 않고 그렇다고 말한다.
const text = (c: Choice) => [c.runner, c.model || "(모델 안 골랐음)", c.effort].filter(Boolean).join(" / ");

// 요약표 한 줄의 글. 어려운 일 작업자는 값이 없는 것이 기본이라 "미설정" 대신 "작업자와 같음"으로 말한다.
// 대체 후보는 다른 역할과 같이 저장된 목록을 그대로 보인다(없으면 "없음").
// commandTitle: 접힌 명령 칸의 제목. 없으면 "발령 명령 보기"다.
type Cells = { value: string; fallbacks: string[]; note: string; command: string; commandTitle?: string };
export function summaryCells(data: RunnersData, role: string, settings: Settings = data.settings!): Cells {
  const current = settings.presets[settings.activePreset].roles[role] as Choice | undefined;
  const fallbacks = fallbackLabels(settings, role);
  if (role === "senior")
    return { value: fallbacks.join(" + ") || "미설정", fallbacks: [], note: "없음 (등록된 시니어 전원에게 동시에 묻습니다)", command: data.commands[role] };
  if (role === HARD_ROLE)
    return {
      value: current ? text(current) : "비어 있음 — 작업자와 같음",
      fallbacks,
      note: "없음",
      command: data.commands[role] ?? "작업자와 같은 명령으로 띄웁니다",
    };
  // 비서 자리도 값이 없는 것이 기본이다. 띄우는 명령이 아니라 다시 열 때 모델·강도만 바꾸는 값이고 대체 후보는 없다.
  if (role === SECRETARY_ROLE)
    return {
      value: current ? text(current) : "비어 있음 — 저장된 명령 그대로 다시 엽니다",
      fallbacks: [],
      note: "없음 (대체 후보를 두지 않습니다)",
      command: data.commands[role] ?? "비서를 다시 열 때 저장된 명령 그대로 엽니다",
      commandTitle: "다시 열 때 동작 보기",
    };
  return { value: current ? text(current) : "미설정", fallbacks, note: "없음", command: data.commands[role] };
}

// 발령 때 채워질 명령은 길어서 표 칸으로 두지 않고 줄마다 접어 둔다. 읽기 전용 화면에서도 같은 길로 본다.
export const CommandFold = ({ command, title = "발령 명령 보기" }: { command: string; title?: string }) => (
  <details className="row-command">
    <summary>{title}</summary>
    <code>{command}</code>
  </details>
);

export function RunnerSummary({ data }: { data: RunnersData }) {
  return (
    <div className="table-scroll runners-summary">
      <table>
        <thead>
          <tr>
            <th>역할</th>
            <th>지금 값</th>
            <th>대체 후보 (순서대로)</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(data.roles).map(([role, label]) => {
            const cells = summaryCells(data, role);
            return (
              <tr key={role}>
                <th>{label}</th>
                <td>
                  {cells.value}
                  <CommandFold command={cells.command} title={cells.commandTitle} />
                </td>
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
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
