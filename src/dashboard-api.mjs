import { prepareCenterWall } from "./center-wall.mjs";
import {
  buildHumanBrief,
  currentProgressReport,
  stateText,
  isExecution,
} from "./human-brief.mjs";
import {
  workspaceModel,
  filterWorkspaceRows,
  sortWorkspaceRows,
  workspacePresetCounts,
} from "./dashboard-workspace.mjs";
import { boardProgressCounts } from "./board-progress.mjs";
import {
  renderWatchVerdict,
  renderWatchOverview,
} from "./watch-overview-wall.mjs";
import { executionBucket } from "./dashboard-execution.mjs";
import { readActiveHierarchy } from "./hierarchy-register.mjs";
import { renderCardDocument } from "./card-content.mjs";
import {
  detailEvents,
  instructionSections,
  renderDetailSummary,
} from "./dashboard-detail.mjs";
import {
  failureReason,
  recentExecutionEvents,
  staleCleanupRequest,
} from "./dashboard-status.mjs";
import { cardForms, workForms, createForm } from "./dashboard-forms.mjs";
import { workLetters } from "./work-mail.mjs";
import { readMailBody } from "./ledger.mjs";
import { mailboxLetters } from "./mailbox.mjs";
import { filterMail, mailStatus, listPageSize } from "./dashboard-inbox.mjs";
import {
  ledgerView,
  filterLedgerRows,
  isWatchRoutine,
  ledgerOriginal,
  eventLabel,
  eventSummary,
} from "./ledger-table.mjs";
import {
  readSettings,
  runnerChoices,
  launchFor,
  PROFILE_ROLES,
} from "./runner-settings.mjs";
import { RUNNER_ROLE_LABELS } from "./runner-settings-wall.mjs";

const modelCache = new WeakMap();
const pick = (value, keys) =>
  Object.fromEntries(keys.map((key) => [key, value[key] ?? null]));
const rowFields =
  "key workKey workType id kind repo title originalTitle state stateLabel stored board owner at reportAt reportLabel model modelTitle effort purpose scope summary next turnLabel turnReason turnSource flowLabel flowTitle flowPhase rallyStep healthKind healthLabel healthReason signalAt signalLabel revision parentWorkKey bucket".split(
    " ",
  );
function model(snapshot) {
  const cached = modelCache.get(snapshot);
  if (cached) return cached;
  if (snapshot.centerError || !snapshot.center)
    throw new Error(snapshot.centerError || "카드 상태를 읽을 수 없습니다");
  const { works, workError } = prepareCenterWall(snapshot),
    briefs = buildHumanBrief(snapshot.center, snapshot.home);
  const cards = snapshot.center.cards,
    byKey = new Map(cards.map((c) => [c.key, c]));
  const parent = new Map(
    (works || []).flatMap((w) => w.executions.map((e) => [e.key, w.key])),
  );
  const rows = [
    ...(works || []).map((w) => pick(w, rowFields)),
    ...workspaceModel(snapshot.center, briefs).map((r) =>
      pick(
        {
          ...r,
          kind: "execution",
          workType: byKey.get(r.key).workType,
          parentWorkKey: parent.get(r.key) || "",
          revision: byKey.get(r.key).revision,
          bucket: executionBucket({ ...byKey.get(r.key), ...r }),
        },
        rowFields,
      ),
    ),
  ];

  const result = {
    rows,
    works,
    workError,
    briefs,
    cards,
    byKey,
    hierarchy: readActiveHierarchy(snapshot.entries || []),
  };
  modelCache.set(snapshot, result);
  return result;
}
const compact = (row) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      ["scope", "summary", "purpose", "next"].includes(key) &&
      typeof value === "string"
        ? value.slice(0, 220)
        : value,
    ]),
  );
const page = (rows, url, key = "page") => {
  const pages = Math.max(1, Math.ceil(rows.length / listPageSize)),
    current = Math.min(
      pages,
      Math.max(1, Number.parseInt(url.searchParams.get(key), 10) || 1),
    );
  return {
    items: rows.slice((current - 1) * listPageSize, current * listPageSize),
    page: current,
    pages,
    total: rows.length,
    pageSize: listPageSize,
  };
};
function letters(snapshot) {
  if (
    snapshot.ledgerLines === null ||
    (snapshot.entries || []).some((e) => e.broken)
  )
    throw new Error("원장 확인 불가 · 우편 상태 모름");
  return mailboxLetters(snapshot.entries || []);
}
function mailRow(m) {
  return {
    ...pick(m, [
      "mailId",
      "digest",
      "t",
      "by",
      "role",
      "currentSender",
      "currentRecipient",
      "preview",
      "replyStatus",
      "read",
      "replyTo",
      "workKey",
      "executionKey",
      "taskId",
      "completionTaskId",
    ]),
    status: mailStatus(m),
  };
}
function bodyOf(snapshot, m) {
  try {
    return snapshot.home && m.digest
      ? readMailBody(m.digest, snapshot.home)
      : null;
  } catch {
    return null;
  }
}

export function dashboardData(snapshot, url) {
  const route = url.pathname.slice("/api/dashboard/".length),
    stamp = {
      collectedAt: snapshot.collectedAt,
      runtime: snapshot.runtime ?? null,
    };
  if (route === "create")
    return { ...stamp, form: createForm(url.searchParams.get("kind")) };
  if (route === "decisions") {
    if (snapshot.decisionError) throw new Error(snapshot.decisionError);
    return {
      ...stamp,
      items: (snapshot.decisions || []).map((d) => ({
        ...d,
        reasonHtml: renderCardDocument(d.reason),
      })),
    };
  }
  if (route === "mail-body") {
    const m = letters(snapshot).find(
      (m) => (m.mailId || m.digest) === url.searchParams.get("id"),
    );
    if (!m)
      throw Object.assign(new Error("편지를 찾을 수 없습니다"), {
        status: 404,
      });
    const body = bodyOf(snapshot, m);
    return {
      ...stamp,
      mail: mailRow(m),
      body,
      error: body === null ? "본문 없음 또는 읽기 불가" : null,
    };
  }
  if (route === "mail") {
    const all = letters(snapshot),
      filtered = filterMail(all, url, { bodyOf: (m) => bodyOf(snapshot, m) })
        .slice()
        .reverse();
    const selected = page(filtered, url, "mailPage");
    return {
      ...stamp,
      ...selected,
      items: selected.items.map((m) => ({
        ...mailRow(m),
        preview:
          m.preview ||
          String(bodyOf(snapshot, m) || "")
            .replace(/\s+/g, " ")
            .slice(0, 120),
      })),
      roles: [
        ...new Set(
          all
            .flatMap((m) => [
              m.currentSender || m.by,
              m.currentRecipient || m.role,
            ])
            .filter(Boolean),
        ),
      ].sort(),
      waiting: all.filter((m) => m.replyStatus === "waiting").length,
      unread: all.filter((m) => m.read === false).length,
    };
  }
  if (route === "ledger") {
    letters(snapshot); // Fail visibly when the shared ledger could not be read.
    const all = ledgerView(
      snapshot.entries || [],
      snapshot.home,
      url.searchParams.get("ledgerDomain") || "all",
    );
    const filtered = filterLedgerRows(all, {
      kind: url.searchParams.get("ledgerKind") || "",
      card: url.searchParams.get("ledgerCard") || "",
      role: url.searchParams.get("ledgerRole") || "",
      date: url.searchParams.get("ledgerDate") || "",
    })
      .filter(
        (e) =>
          url.searchParams.get("ledgerRoutine") === "1" || !isWatchRoutine(e),
      )
      .slice()
      .reverse();
    const selected = page(filtered, url, "logPage");
    return {
      ...stamp,
      ...selected,
      items: selected.items.map((e) => ({
        at: e.t,
        kind: e.kind,
        label: eventLabel(e),
        summary: eventSummary(e),
        by: e.by || "모름",
        target: e.role || e.to || e.board || "모름",
        card: e.executionKey || null,
        original: ledgerOriginal(e),
      })),
    };
  }
  if (route === "runners") {
    const settings = readSettings(snapshot.home);
    if (!settings)
      return {
        ...stamp,
        settings: null,
        catalog: {},
        roles: RUNNER_ROLE_LABELS,
        history: [],
      };
    const catalog = Object.fromEntries(
      Object.entries(settings.runners).map(([name, spec]) => {
        try {
          return [
            name,
            {
              spawn: spec.spawn,
              needsEffort: spec.spawn.includes("{effort}"),
              models: [...runnerChoices(settings, name)].map(
                ([model, efforts]) => ({ model, efforts }),
              ),
            },
          ];
        } catch (error) {
          return [
            name,
            {
              spawn: spec.spawn,
              needsEffort: spec.spawn.includes("{effort}"),
              models: [],
              error: error.message,
            },
          ];
        }
      }),
    );
    const commands = Object.fromEntries(
      Object.keys(PROFILE_ROLES).map((role) => {
        try {
          return [role, launchFor(settings, role)?.cmd || "미설정"];
        } catch (error) {
          return [role, "모름: " + error.message];
        }
      }),
    );
    return {
      ...stamp,
      settings,
      catalog,
      commands,
      roles: RUNNER_ROLE_LABELS,
      history: (snapshot.entries || [])
        .filter((e) => e.kind === "runner-settings")
        .slice(-10)
        .reverse(),
    };
  }
  const m = model(snapshot);
  if (route === "summary") {
    let waiting = null;
    try {
      waiting = letters(snapshot).filter(
        (m) => m.replyStatus === "waiting",
      ).length;
    } catch {}
    return {
      ...stamp,
      decisions: snapshot.decisionError
        ? null
        : (snapshot.decisions || []).filter((d) => d.status === "open").length,
      waiting,
      counts: {
        work:
          m.works === null
            ? null
            : m.rows.filter((r) => r.kind === "work").length,
        executions: m.rows.filter((r) => r.kind !== "work").length,
        unlinked: m.rows.filter((r) => r.kind !== "work" && !r.parentWorkKey)
          .length,
      },
      errors: [
        snapshot.error,
        snapshot.resourceError,
        m.workError,
        snapshot.decisionError,
      ].filter(Boolean),
    };
  }
  if (route === "workspace") {
    const collection = url.searchParams.get("collection") || "work";
    if (["work", "unlinked"].includes(collection) && m.workError)
      throw new Error(m.workError);
    const all = m.rows.filter((r) =>
      collection === "work"
        ? r.kind === "work"
        : r.kind !== "work" && (collection !== "unlinked" || !r.parentWorkKey),
    );
    const state = { ...Object.fromEntries(url.searchParams), collection };
    const filtered = sortWorkspaceRows(
      filterWorkspaceRows(all, state).filter(
        (r) => !state.bucket || r.bucket === state.bucket,
      ),
      state.sort || "attention",
      state.dir || "desc",
    );
    const selected = page(filtered, url),
      wide = ["wall", "map"].includes(state.layout);
    return {
      ...stamp,
      ...selected,
      items: undefined,
      rows: (wide ? filtered : selected.items).map(compact),
      workRows:
        state.layout === "map"
          ? m.rows.filter((r) => r.kind === "work").map(compact)
          : undefined,
      hierarchy: m.hierarchy,
      workError: m.workError,
      presets: workspacePresetCounts(all, state),
      facets: Object.fromEntries(
        ["board", "repo", "healthLabel", "flowTitle"].map((key) => [
          key,
          [...new Set(all.map((r) => r[key]).filter(Boolean))].sort(),
        ]),
      ),
      doneButOpen: (snapshot.center.doneButOpen || []).map((c) =>
        pick(c, ["key", "title", "revision", "role", "doneAt", "doneBy"]),
      ),
    };
  }
  if (route === "status")
    return {
      ...stamp,
      works: m.rows.filter((r) => r.kind === "work").map(compact),
      cleanupRequest: staleCleanupRequest(
        m.cards.filter((c) => isExecution(c) && executionBucket(c) === "stale"),
      ),
      rows: m.rows
        .filter(
          (r) =>
            r.kind !== "work" &&
            isExecution(r) &&
            !["done", "cancelled", "superseded", "archived"].includes(r.state),
        )
        .map((r) =>
          r.bucket === "stuck" || r.bucket === "stale"
            ? { ...r, failureReason: failureReason(m.byKey.get(r.key) || {}) }
            : r,
        )
        .map(compact),
      resources: snapshot.resources,
      resourceError: snapshot.resourceError,
      workError: m.workError,
      boards: snapshot.center.boards.map((b) => ({
        name: b.name,
        ...boardProgressCounts(b, { buckets: true }),
        watchHtml: renderWatchOverview(snapshot.center, b),
      })),
      watchHtml: renderWatchVerdict(snapshot.center, {
        runtime: snapshot.runtime,
      }),
      decisions: snapshot.decisionError
        ? null
        : (snapshot.decisions || []).filter((d) => d.status === "open"),
      recent: recentExecutionEvents(m.cards)
        .slice(0, 50)
        .map((e) => ({
          ...pick(e, ["at", "kind", "label", "role"]),
          card: pick(e.card, ["key", "title"]),
        })),
    };
  if (route === "sessions")
    return {
      ...stamp,
      known: snapshot.center.runtimeKnown,
      roles: snapshot.center.roles.map((r) => ({
        role: r.role,
        harness: r.harness || null,
        model: r.model || null,
        life: pick(r.life || {}, ["state", "pidState"]),
      })),
    };
  if (route === "runs") {
    const rows = m.cards
      .flatMap((c) =>
        (c.runs || []).map((r) => ({ ...r, key: c.key, title: c.title })),
      )
      .concat(snapshot.center.unregistered || [])
      .sort(
        (a, b) =>
          (Date.parse(b.at || b.sentAt) || 0) -
          (Date.parse(a.at || a.sentAt) || 0),
      );
    const q = (url.searchParams.get("q") || "").toLowerCase();
    return {
      ...stamp,
      ...page(
        rows.filter((r) => !q || JSON.stringify(r).toLowerCase().includes(q)),
        url,
      ),
    };
  }
  if (route === "detail") {
    const key = url.searchParams.get("card") || "",
      w = m.works?.find((w) => w.key === key),
      c = m.byKey.get(key);
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
        history: [...w.history].reverse(),
        mail: w.letters.slice(0, 5).map(mailRow),
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
        ["카드 상태", stateText[c.status] || c.status],
        ["실행 상태", row.healthLabel],
        ["담당", c.role],
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
      mail: mail.slice(0, 5).map(mailRow),
      mailTotal: mail.length,
    };
  }
  throw Object.assign(new Error("대시보드 API 없음"), { status: 404 });
}

export function sendDashboardData(snapshot, url, response) {
  const body = JSON.stringify(dashboardData(snapshot, url));
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}
