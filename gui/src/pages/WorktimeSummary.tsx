import { useState } from "react";
import { useResource } from "../resource";
import type { WorktimeData } from "../types";
import { ErrorMessage, Loading } from "../ui";
import {
  durationLabel,
  kindLabel,
  modelLabel,
  periodLabels,
  profileLabel,
  unknownReasonLabel,
} from "../worktime";

type Period = (typeof periodLabels)[number][0];

// 모델별 카드 작업 시간 요약. 펼칠 때만 읽는다(접혀 있으면 요청도 갱신도 하지 않는다).
export default function WorktimeSummary() {
  const [open, setOpen] = useState(false),
    [period, setPeriod] = useState<Period>("today");
  return (
    <section className="worktime" data-open={open}>
      <details onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>모델별 작업 시간</summary>
        {open && <Body period={period} onPeriod={setPeriod} />}
      </details>
    </section>
  );
}

function Body({ period, onPeriod }: { period: Period; onPeriod: (p: Period) => void }) {
  const resource = useResource<WorktimeData>("worktime?period=" + period),
    data = resource.data;
  const unknown = Object.entries(data?.unknownReasons ?? {});
  return (
    <div className="worktime-body">
      <div className="segmented" aria-label="기간">
        {periodLabels.map(([value, label]) => (
          <button key={value} aria-pressed={period === value} onClick={() => onPeriod(value)}>
            {label}
          </button>
        ))}
        <small className="segmented-hint">결과 등록 시각(한국 시간) 기준</small>
      </div>
      <ErrorMessage error={resource.error} retry={() => void resource.refresh(true)} />
      {!data ? (
        <Loading />
      ) : data.rows.length === 0 ? (
        <p className="muted">이 기간에 결과가 등록된 카드가 없습니다.</p>
      ) : (
        <div className="table-scroll worktime-scroll">
          <table className="worktime-table">
            <thead>
              <tr>
                <th>역할</th>
                <th>모델(강도)</th>
                <th>종류</th>
                <th>건수</th>
                <th>중간값</th>
                <th>평균</th>
                <th>비고</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => {
                const total = row.step === "all",
                  notes = [
                    row.assignedBasis > 0 && `배정 기준 ${row.assignedBasis}건`,
                    row.reworkCards > 0 && `2라운드 이상 ${row.reworkCards}건`,
                  ].filter(Boolean);
                return (
                  <tr key={[row.profile, row.model, row.effort, row.step].join("|")} className={total ? "worktime-total" : ""}>
                    <td>{total ? profileLabel(row.profile) : ""}</td>
                    <td>{total ? modelLabel(row.model, row.effort) : ""}</td>
                    <td>{kindLabel(row.step)}</td>
                    <td>{row.count}</td>
                    <td>{durationLabel(row.medianMs)}</td>
                    <td>{durationLabel(row.meanMs)}</td>
                    <td>{notes.join(" · ")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && (
        <p className="muted">
          {data.count}건 계산
          {data.noDuration > 0 && ` · 시각이 부족해 뺀 카드 ${data.noDuration}건`}
          {unknown.length > 0 &&
            ` · 모델을 몰라 '모름'으로 묶은 카드: ${unknown.map(([reason, n]) => `${unknownReasonLabel(reason)} ${n}건`).join(", ")}`}
        </p>
      )}
      <p className="muted">
        작업 시간은 카드의 첫 '작업 중' 보고에서 결과 등록까지입니다. 시작 보고가 없으면 배정에서 결과 등록까지로 계산하고 '배정 기준'으로 표시합니다.
        모델은 담당 세션을 띄울 때의 실행 명령 기준이라, 세션 안에서 나중에 바꾼 모델은 알 수 없습니다. '수정'은 2라운드 이상의 구현 카드이고, 재작업 횟수는 같은 티키타카 묶음의 앞선 라운드 수입니다.
      </p>
    </div>
  );
}
