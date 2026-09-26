// Forms describe existing commands. Validation and writes stay in createCenterHandler.
import { workPhases } from "./work-store.mjs";
const field = (
  name,
  label,
  value = "",
  type = "text",
  options = null,
  required = false,
) => ({ name, label, value: value ?? "", type, options, required });
const options = (values) =>
  values.map((value) => (Array.isArray(value) ? value : [value, value]));
const text = (name, label, value = "", required = false) =>
  field(name, label, value, "textarea", null, required);
const select = (name, label, value, values) =>
  field(name, label, value, "select", options(values));
const note = () => text("note", "변경 이유 / 기록 내용", "", true);
const form = (action, title, fields, disabled = false) => ({
  action,
  title,
  fields,
  disabled,
});
export function cardForms(c) {
  return [
    form("/cards/update", "기록 저장", [
      select("noteKind", "기록 종류", "decision", [
        ["decision", "내부 판단"],
        ["question", "감독에게 질문"],
        ["answer", "내부 답변"],
      ]),
      field("turnOwner", "현재 차례 (바꿀 때 입력)"),
      note(),
      field("title", "제목", c.title, "text", null, true),
      select("status", "카드 상태", c.status, [
        ["draft", "초안"],
        ["ready", "발령 가능"],
        ["assigned", "배정"],
        ["hold", "보류"],
        ["done", "완료"],
        ["cancelled", "취소"],
        ["superseded", "대체됨"],
        ["archived", "보관"],
      ]),
      text("statusReason", "현재 상태 이유"),
      field("replacedBy", "대체된 후속 카드", c.replacedBy),
      field("resolutionOwner", "후속 담당", c.resolutionOwner),
      text("nextAction", "다음 행동·해소 조건", c.nextAction),
      text("scope", "허용한 작업 범위", c.scope),
      field("board", "판", c.board),
      field("role", "담당 역할", c.role),
      select("workType", "카드 종류", c.workType || "execution", [
        ["execution", "실행 작업"],
        ["coordination", "관리·조율"],
      ]),
      field("rallyId", "티키타카 묶음 ID", c.rallyId),
      field("rallyTitle", "묶음 제목", c.rallyTitle),
      field("rallyRound", "라운드 (조사 0)", c.rallyRound ?? "", "number"),
      select("rallyStep", "연결 단계", c.rallyStep || "", [
        ["", "미연결"],
        ["implementation", "구현"],
        ["fix", "수정"],
        ["review", "검수"],
        ["research", "관련 조사"],
      ]),
    ]),
  ];
}
export function workForms(w, allCards, works) {
  const closed = ["done", "cancelled"].includes(w.status);
  if (closed) return [form("/works/reopen", "업무 다시 열기", [note()])];
  const used = new Set(
    works.flatMap((work) => work.executions.map((e) => e.key)),
  );
  const linked = w.executions.map((e) => [e.key, e.card?.title || e.key]);
  const phases = () => [
    select("phase", "실행 단계", "implementation", Object.entries(workPhases)),
    field("round", "라운드", w.round || 1, "number"),
  ];
  return [
    form("/works/update", "업무 기록 저장", [
      text("progress", "진척 · 처리 수 / 남은 대상 / 재개 위치", w.progress),
      field("turnOwner", "현재 차례", w.turnOwner),
      text("nextAction", "다음 행동·대기 이유", w.nextAction),
      note(),
      field(
        "title",
        "업무 제목",
        w.originalTitle || w.title,
        "text",
        null,
        true,
      ),
      text("goal", "약속한 결과", w.goal, true),
      text("scope", "전체 대상", w.scope, true),
      text("acceptance", "완료 조건", w.acceptance, true),
      field("owner", "책임 감독", w.owner, "text", null, true),
      field("board", "판", w.board),
      select("status", "업무 상태", w.status, [
        ["open", "진행 중"],
        ["hold", "보류"],
      ]),
    ]),
    form("/works/execute", "새 실행 등록", [
      ...phases(),
      field("title", "이번에 맡길 내용", "", "text", null, true),
      text("body", "실행 지시·허용 범위·결과물", "", true),
      note(),
    ]),
    form("/works/link", "기존 실행 연결", [
      select("execution", "실행", "", [
        ["", "실행 선택"],
        ...linked,
        ...allCards
          .filter((c) => !used.has(c.key))
          .map((c) => [c.key, c.title || c.key]),
      ]),
      ...phases(),
      note(),
    ]),
    ...(linked.length
      ? [
          form("/works/unlink", "연결 정정 기록", [
            select("execution", "잘못 연결한 실행", linked[0][0], linked),
            note(),
          ]),
        ]
      : []),
    form("/works/mail", "기존 편지 연결", [
      field("mail", "우편 ID", "", "text", null, true),
      note(),
    ]),
    form(
      "/works/complete",
      "업무 최종 완료 확인",
      [text("result", "확인한 최종 결과·검수 근거", "", true), note()],
      w.active.length > 0,
    ),
    form(
      "/works/cancel",
      "업무 취소 기록",
      [text("result", "취소 근거·남은 내용", "", true), note()],
      w.active.length > 0,
    ),
  ];
}
export function createForm(kind) {
  return kind === "work"
    ? form("/works/create", "업무 카드 만들기", [
        field("key", "업무 주소 (저장소/업무ID)", "", "text", null, true),
        field("title", "업무 제목", "", "text", null, true),
        field("owner", "책임 감독", "", "text", null, true),
        field("repoPath", "저장소 절대경로", "", "text", null, true),
        field("board", "판"),
        text("goal", "약속한 결과", "", true),
        text("scope", "전체 대상", "", true),
        text("acceptance", "완료 조건", "", true),
      ])
    : form("/cards/create", "실행 초안 등록", [
        field("repo", "저장소 이름", "", "text", null, true),
        field("repoPath", "저장소 절대경로", "", "text", null, true),
        field("id", "카드 ID", "", "text", null, true),
        field("title", "제목", "", "text", null, true),
        text("body", "작업 내용", "", true),
      ]);
}
