import { useContext, useState } from "react";
import { save, useResource } from "../resource";
import { fallbackLabels } from "../runner-draft";
import type { Stamp } from "../types";
import { PresetEditor } from "./PresetEditor";
import { PresetManager } from "./PresetManager";
import { RunnerTables } from "./RunnerTables";
import {
  ActionForm,
  AppContext,
  ErrorMessage,
  Freshness,
  JsonValue,
  Loading,
} from "../ui";
export type Choice = { runner: string; model: string; effort?: string };
export type Settings = {
  revision: number;
  activePreset: string;
  presets: Record<
    string,
    {
      label?: string;
      roles: Record<string, Choice | Choice[]>;
      fallback?: Record<string, Choice[]>;
    }
  >;
  blocked?: { model: string; roles?: string[]; reason: string }[];
  favorites?: Choice[];
};
const label = (c: Choice) =>
  [c.runner, c.model, c.effort].filter(Boolean).join(" / ");
export type RunnersData = Stamp & {
  // 이 기계에 고정된 창 선택(KADAN_HOME 설정). 대시보드 프로세스의 환경변수가 아니다.
  window?: {
    kind: "rottie" | "none" | "unset" | "broken";
    label: string;
    rottieBin?: string;
    error?: string;
  };
  settings: Settings | null;
  roles: Record<string, string>;
  commands: Record<string, string>;
  catalog: Record<
    string,
    {
      spawn: string;
      needsEffort: boolean;
      error?: string;
      models: { model: string; efforts: string[] }[];
    }
  >;
  history: unknown[];
  // 감시 AI는 이 실행기만 고를 수 있고, 1순위 포함 최대 maxAttempts개를 자동으로 차례로 시도한다.
  watch?: { runner: string; maxAttempts: number };
  // 시니어는 안전 허용 목록의 실행기에서 최대 max명을 등록하고, 질문하면 전원에게 동시에 묻는다.
  senior?: { runners: string[]; max: number };
  // 설명 AI는 실행기 표에 한 번 호출(exec) 틀이 있는 실행기만 고를 수 있고, 1순위 포함 최대 maxAttempts개를 시도한다.
  explain?: { runners: string[]; maxAttempts: number };
};
// 설정 화면은 설정만 둔다(2026-10-25 [kyle]). 지금 열린 창의 생존·모델·다시 띄우기는 전략 맵 옆 칸에 있다.
export default function Runners() {
  const { readOnly } = useContext(AppContext),
    resource = useResource<RunnersData>("runners"),
    data = resource.data;
  return (
    <section>
      <h1>실행 모델 설정</h1>
      <p>다음 발령에 쓸 AI 도구·모델·강도를 역할별로 설정합니다. 설정 변경은 다음 발령부터 적용되며 열린 창은 그대로입니다.
        지금 열린 창이 살아 있는지·어느 모델인지는 <a href="#strategy-map">전략 맵</a>에서 유닛을 눌러 봅니다.</p>
      {data?.window && (
        <p id="window-setting">
          새 담당 창: <strong>{data.window.label}</strong>
          {data.window.rottieBin && <> · <code>{data.window.rottieBin}</code></>}
          {data.window.kind === "unset" && (
            <> — 고정 전에는 셸 환경변수를 따르고, 없으면 백그라운드입니다. <code>kadan window set rottie --rottie-bin 절대경로</code></>
          )}
          {data.window.error && <> · {data.window.error}</>}
        </p>
      )}
      <h2>다음 발령의 실행 모델</h2>
      <ErrorMessage error={resource.error} />
      <Freshness collectedAt={data?.collectedAt} {...resource} />
      {!data ? (
        <Loading />
      ) : !data.settings ? (
        <p>
          실행 모델 설정이 없습니다.{" "}
          <code>kadan runners init --reason 이유</code>로 먼저 설정하세요.
        </p>
      ) : (
        <>
          <p>
            활성 프리셋 <strong>{data.settings.activePreset}</strong> · 버전{" "}
            {data.settings.revision}
          </p>
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
                  const current = data.settings!.presets[
                    data.settings!.activePreset
                  ].roles[role] as Choice | undefined;
                  return (
                    <tr key={role}>
                      <th>{label}</th>
                      <td>
                        {role === "senior"
                          ? fallbackLabels(data.settings!, role).join(" + ") ||
                            "미설정"
                          : current
                            ? [current.runner, current.model, current.effort]
                                .filter(Boolean)
                                .join(" / ")
                            : "미설정"}
                      </td>
                      <td>
                        {role === "senior" ? (
                          "없음 (등록된 시니어 전원에게 동시에 묻습니다)"
                        ) : fallbackLabels(data.settings!, role).length ? (
                          <ol>
                            {fallbackLabels(data.settings!, role).map(
                              (text, i) => (
                                <li key={i}>{text}</li>
                              ),
                            )}
                          </ol>
                        ) : (
                          "없음"
                        )}
                      </td>
                      <td>
                        <code>{data.commands[role]}</code>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!readOnly && (
            <>
          <h2>모델·대체 후보 변경</h2>
          <p className="muted">
            대체 후보(폴백)는 원인이 확인된 쿼터·로그인·모델 오류에만 사용합니다. 자동
            전환은 없습니다. 검수자 시작 시 작업자를 지정한 경우에는 다른 계열의 첫 후보를 고릅니다.
          </p>
          <p className="muted">
            감시 AI만 예외입니다. 감시기가 스스로 부르므로, 1순위가 시간 초과·호출
            실패로 응답하지 못하면 대체 후보를 차례로 자동 시도합니다(1순위 포함 최대{" "}
            {data.watch?.maxAttempts ?? 3}개, 시도마다 5분 상한). 비워 두면 감시 프로필의
            KADAN_JUDGE_MODEL을 씁니다.
          </p>
          <p className="muted">
            시니어는 작업 결과에 결정할 부분이 있을 때 감독이 <code>kadan senior</code>로
            의견을 한 번 묻는 고급 모델입니다(Claude Code 어드바이저와는 다른 기능). 최대{" "}
            {data.senior?.max ?? 2}명을 등록하면 묻는 즉시 등록된 전원에게 동시에 묻고, 감독은 모델을 고르지 않습니다.
            대체 후보는 없고, 한도·실패는 재시도 없이 그 시니어 칸에 표시됩니다.
          </p>
          <p className="muted">
            설명 AI는 감시 AI가 아닙니다. 발령·완료·막힘·결정이 생긴 카드의 요약 칸만 채웁니다(1순위 포함 최대{" "}
            {data.explain?.maxAttempts ?? 2}개, 시도당 75초 상한). 이 칸이 비어 있거나 고른 실행기에
            exec 틀이 없으면 아무것도 하지 않고, 칸을 채운 시점 이후의 사건만 다룹니다.
          </p>
          <PresetEditor data={data} settings={data.settings} />
          <PresetManager settings={data.settings} />
          <Favorites settings={data.settings} />
          <RunnerTables catalog={data.catalog} revision={data.settings.revision} />
          <details>
            <summary>프리셋 전환</summary>
            <ActionForm
              revision={data.settings.revision}
              spec={{
                action: "/runners/preset",
                title: "프리셋 전환",
                fields: [
                  {
                    name: "preset",
                    label: "프리셋",
                    value: data.settings.activePreset,
                    type: "select",
                    options: Object.entries(data.settings.presets).map(
                      ([name, s]) => [name, s.label || name],
                    ),
                    required: true,
                  },
                  {
                    name: "reason",
                    label: "바꾸는 이유",
                    value: "",
                    type: "text",
                    options: null,
                    required: true,
                  },
                ],
              }}
            />
          </details>
            </>
          )}
          <details>
            <summary>최근 변경</summary>
            {data.history.map((h, i) => (
              <JsonValue key={i} value={h} />
            ))}
          </details>
        </>
      )}
    </section>
  );
}
// 즐겨찾기 관리: 목록 보기와 삭제. 추가는 각 역할의 '이 조합 즐겨찾기' 버튼으로 한다.
function Favorites({ settings }: { settings: Settings }) {
  const context = useContext(AppContext),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const list = settings.favorites || [];
  const remove = async (i: number) => {
    setBusy(true);
    setError(null);
    try {
      await save(
        "/runners/favorite",
        {
          op: "remove:" + (i + 1),
          reason: "즐겨찾기 삭제",
          revision: String(settings.revision),
        },
        context.token,
      );
      context.notice("즐겨찾기에서 뺐습니다: " + label(list[i]));
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setBusy(false);
    }
  };
  return (
    <details>
      <summary>즐겨찾기 관리 ({list.length}개)</summary>
      {list.length ? (
        <ul>
          {list.map((fav, i) => (
            <li key={i}>
              {label(fav)}{" "}
              <button type="button" disabled={busy} onClick={() => remove(i)}>
                삭제
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">
          아직 없습니다. 역할 바꾸기 칸에서 조합을 고르고 '이 조합 즐겨찾기'를
          누르세요.
        </p>
      )}
      <ErrorMessage error={error} />
    </details>
  );
}
