import { useRef } from "react";
import { fallbackLabels } from "../runner-draft";
import { HARD_ROLE, SECRETARY_ROLE } from "../preset-draft";
import type { Choice, RunnersData, Settings } from "./Runners";

// 모델을 아직 안 고른 초안은 빈 글자로 두지 않고 그렇다고 말한다.
const text = (c: Choice) => [c.runner, c.model || "(모델 안 골랐음)", c.effort].filter(Boolean).join(" / ");

// 요약표 한 줄의 글. 어려운 일 작업자는 값이 없는 것이 기본이라 "미설정" 대신 "작업자와 같음"으로 말한다.
// 대체 후보는 다른 역할과 같이 저장된 목록을 그대로 보인다(없으면 "없음").
// commandTitle: 명령 팝업을 여는 버튼의 글. 없으면 "발령 명령 보기"다.
// seniors: 시니어 줄의 '지금 값'에 번호 목록으로 보일 등록 목록(그 밖의 역할은 null).
type Cells = { value: string; seniors: string[] | null; fallbacks: string[]; note: string; command: string; commandTitle?: string };
export function summaryCells(data: RunnersData, role: string, settings: Settings = data.settings!): Cells {
  const current = settings.presets[settings.activePreset].roles[role] as Choice | undefined;
  const fallbacks = fallbackLabels(settings, role);
  if (role === "senior")
    return { value: fallbacks.join(" + ") || "미설정", seniors: fallbacks, fallbacks: [], note: "없음 (등록된 시니어 전원에게 동시에 묻습니다)", command: data.commands[role] };
  if (role === HARD_ROLE)
    return {
      value: current ? text(current) : "비어 있음 — 작업자와 같음",
      seniors: null,
      fallbacks,
      note: "없음",
      command: data.commands[role] ?? "작업자와 같은 명령으로 띄웁니다",
    };
  // 비서 자리도 값이 없는 것이 기본이다. 띄우는 명령이 아니라 다시 열 때 모델·강도만 바꾸는 값이고 대체 후보는 없다.
  if (role === SECRETARY_ROLE)
    return {
      value: current ? text(current) : "비어 있음 — 저장된 명령 그대로 다시 엽니다",
      seniors: null,
      fallbacks: [],
      note: "없음 (대체 후보를 두지 않습니다)",
      command: data.commands[role] ?? "비서를 다시 열 때 저장된 명령 그대로 엽니다",
      commandTitle: "다시 열 때 동작 보기",
    };
  return { value: current ? text(current) : "미설정", seniors: null, fallbacks, note: "없음", command: data.commands[role] };
}

// 대체 후보와 시니어 등록 목록이 같이 쓰는 번호 목록. 비어 있으면 안내 글만 보인다.
export function NumberedList({ items, empty }: { items: string[]; empty: string }) {
  return items.length ? <ol>{items.map((item, i) => <li key={i}>{item}</li>)}</ol> : <>{empty}</>;
}

// 시니어 줄의 '지금 값'은 대체 후보와 같은 번호 목록으로 아래로 보인다(옆으로 'A + B'로 잇지 않는다).
export const ValueCell = ({ cells }: { cells: Cells }) =>
  cells.seniors?.length ? <NumberedList items={cells.seniors} empty="" /> : <>{cells.value}</>;

// 발령 때 채워질 명령은 길어서 표 칸에 두지 않는다. 줄마다 작은 버튼으로 기본 <dialog> 팝업을 열어 지금 값과 대체 후보의 명령을 본다.
// 읽기 전용 화면에서도 같은 길로 본다. 명령 글은 서버가 만든 값을 그대로 보인다(화면에서 틀을 다시 조립하지 않는다).
export function CommandButton({ data, role, label, cells }: { data: RunnersData; role: string; label: string; cells: Cells }) {
  const ref = useRef<HTMLDialogElement>(null);
  const title = cells.commandTitle ?? "발령 명령 보기";
  const seniors = role === "senior" ? (data.seniorCommands ?? []) : [];
  const fallbacks = data.fallbackCommands?.[role] ?? [];
  return (
    <>
      <button type="button" className="row-command" onClick={() => ref.current?.showModal()}>{title}</button>
      <dialog ref={ref} className="command-dialog" aria-label={`${label} ${title}`}>
        <h3>{label} · {title.replace(/ 보기$/, "")}</h3>
        <h4>지금 값</h4>
        {seniors.length > 1
          ? <ol>{seniors.map((line, i) => <li key={i}><code>{line}</code></li>)}</ol>
          : <code>{cells.command}</code>}
        {fallbacks.length > 0 && <>
          <h4>대체 후보 (순서대로)</h4>
          <ol>{fallbacks.map((line, i) => <li key={i}><code>{line}</code></li>)}</ol>
        </>}
        <form method="dialog"><button>닫기</button></form>
      </dialog>
    </>
  );
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
          </tr>
        </thead>
        <tbody>
          {Object.entries(data.roles).map(([role, label]) => {
            const cells = summaryCells(data, role);
            return (
              <tr key={role}>
                <th>{label}</th>
                <td>
                  <ValueCell cells={cells} />
                  <CommandButton data={data} role={role} label={label} cells={cells} />
                </td>
                <td>
                  <NumberedList items={cells.fallbacks} empty={cells.note} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
