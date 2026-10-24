// 업무·실행 카드 상세 화면(DS-1-impl: dashboard-api.mjs에서 옮김).
import {
  currentProgressReport,
  waitingText,
} from "../human-brief.mjs";
import { storedStatusText } from "../status-labels.mjs";
import { renderCardDocument } from "../card-content.mjs";
import {
  detailEvents,
  instructionSections,
  renderDetailSummary,
} from "../dashboard-detail.mjs";
import { cardForms, workForms } from "../dashboard-forms.mjs";
import { workLetters } from "../work-mail.mjs";
import { pick, mailRow } from "./shared.mjs";
import { hydrateCardBody } from "../dashboard-card-body.mjs";

export function detailData(snapshot, url, stamp, m) {
  const key = url.searchParams.get("card") || "",
    w = m.works?.find((w) => w.key === key),
    c = hydrateCardBody(m.byKey.get(key));
  if (!w && !c)
    throw Object.assign(new Error("카드를 찾을 수 없습니다"), {
      status: 404,
    });
  if (w)
    return {
      ...stamp,
      key,
      kind: "work",
      revision: w.revision,
      title: w.title,
      row: m.rows.find((r) => r.key === key),
      facts: [
        ["약속한 결과", w.goal],
        ["전체 대상", w.scope],
        ["완료 조건", w.acceptance],
        ["진척", w.progress],
        ["다음 행동", w.next],
        ["현재 차례", w.turnLabel],
        ["실행 종료", w.flowPhase],
        ["최종 결과", w.result],
        ["책임 감독", w.owner],
      ],
      forms: workForms(w, m.cards, m.works),
      executions: w.executions.map((e) => ({
        ...pick(e, ["key", "phase", "round"]),
        row: m.rows.find((r) => r.key === e.key) || null,
      })),
      reviewFlows: m.reviewFlows.filter(flow => flow.cardKeys.some(key => w.executions.some(e => e.key === key))),
      history: [...w.history].reverse(),
      mail: w.letters.slice(0, 5).map((letter) => mailRow(letter, m.identity)),
      mailTotal: w.letters.length,
    };
  const row = m.rows.find((r) => r.key === key),
    report = currentProgressReport(c),
    events = detailEvents(c),
    brief = m.briefs?.get(key),
    instructions = instructionSections(c.body);
  const related = m.cards.filter(
      (x) =>
        c.rallyId &&
        x.repo === c.repo &&
        x.board === c.board &&
        x.rallyId === c.rallyId,
    ),
    reviews = related.filter(
      (x) =>
        x.rallyStep === "review" &&
        String(x.rallyRound) === String(c.rallyRound),
    );
  const mail = workLetters(
    { key: "execution:" + key, executions: [{ key }], mailRefs: [] },
    snapshot.entries || [],
    m.cards,
  );
  return {
    ...stamp,
    key,
    kind: "execution",
    revision: c.revision,
    title: brief?.title || c.title,
    row,
    reviewFlow: m.reviewByCard.get(key) || null,
    forms: cardForms(c),
    summaryHtml: renderDetailSummary(c, {
      brief,
      report,
      reviews,
      decisions: (snapshot.decisions || []).filter((d) => d.card === key),
      decisionError: snapshot.decisionError,
      events,
      compact: true,
      showRecent: false,
    }),
    facts: [
      ["카드 상태", storedStatusText(c)],
      // 결과 대기는 상세에서만 기다리는 이유를 붙인다(2026-10-05 [kyle]).
      ["실행 상태", row.healthKind === "waiting" ? waitingText(c) : row.healthLabel],
      ["담당", c.role],
      ["실행 모델", row.modelTitle || null],
      ["마지막 보고", row.reportLabel],
      ["카드 ID", c.key],
      ["원본 제목", c.title],
      ["작업 폴더", c.repoPath],
      ["카드 원본", c.path],
      ["원본 문서 기준", c.sourcePath || c.path],
    ],
    instructions: {
      prefixHtml: renderCardDocument(instructions.prefix, c),
      sections: instructions.sections.map((s) => ({
        ...pick(s, ["title", "label", "content"]),
        html: renderCardDocument(s.body, c),
      })),
      body: c.body,
    },
    report: { ...report, html: renderCardDocument(report.note, c) },
    runs: c.runs || [],
    history: events,
    related: related.map((c) =>
      pick(c, ["key", "title", "rallyRound", "rallyStep", "displayState"]),
    ),
    mail: mail.slice(0, 5).map((letter) => mailRow(letter, m.identity)),
    mailTotal: mail.length,
  };
}
