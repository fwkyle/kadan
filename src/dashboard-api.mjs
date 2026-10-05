import { prepareCenterWall, registeredCenterWorks } from "./center-wall.mjs";
import { buildReviewFlows, readReviewResult } from "./review-flow.mjs";
import {
  buildHumanBrief,
  currentProgressReport,
  stateText,
  isExecution,
  waitingText,
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
import { decisionContent, RUN_STATE_LABELS } from "./decision-wall.mjs";
import { taskIdentity } from "./task-identity.mjs";
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
import { isUnreadLetter } from "./mailbox-state.mjs";
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
  watchJudgeCommand,
  PROFILE_ROLES,
  WATCH_RUNNER,
  WATCH_MAX_ATTEMPTS,
} from "./runner-settings.mjs";
import { RUNNER_ROLE_LABELS } from "./runner-settings-wall.mjs";
import { seniorCommandLabel } from "./senior.mjs";
import { buildCardWorktimes, summarizeWorktimes, modelUnknownLabel, WORKTIME_PERIODS } from "./card-worktime.mjs";
import { liveSessions, flowSummary, openAlerts, supervisorSummary, supervisorOf } from "./dashboard-band.mjs";

const modelCache = new WeakMap();
const executionModelCache = new WeakMap();
const pick = (value, keys) =>
  Object.fromEntries(keys.map((key) => [key, value[key] ?? null]));
const rowFields =
  "key workKey workType id kind repo title originalTitle state stateLabel stored board owner at reportAt reportLabel model modelTitle effort purpose scope summary next turnLabel turnReason turnSource flowLabel flowTitle flowPhase rallyStep healthKind healthLabel healthReason signalAt signalLabel revision parentWorkKey bucket workMs workBasis waitMs closeMs reworks profile modelState".split(
    " ",
  );
// 카드별 작업 시간·실제 모델. 원장 색인을 수집당 한 번만 만든다(요청·화면마다 다시 계산하지 않는다).
const worktimeCache = new WeakMap();
function worktimes(snapshot) {
  let value = worktimeCache.get(snapshot);
  if (!value) {
    value = buildCardWorktimes(snapshot.center.cards, snapshot.entries || []);
    worktimeCache.set(snapshot, value);
  }
  return value;
}
// 목록 칸에 싣는 값. 모델은 그 카드를 시작한 세션의 실행 명령으로 판정한 값이고, 끝난 카드도 말한다.
// 시작·결과가 아직 없는 카드는 판정하지 않고 기존 값(진행 중 역할의 현재 모델)을 그대로 둔다.
function runFields(w) {
  if (!w) return {};
  const fields = { workMs: w.workMs, workBasis: w.basis, waitMs: w.waitMs, closeMs: w.closeMs, reworks: w.reworks, profile: w.profile };
  const m = w.model;
  if (m.state === "known")
    return { ...fields, modelState: "known", model: m.model.split("/").at(-1), effort: m.effort,
      modelTitle: [m.harness, m.model, m.effort ? "강도 " + m.effort : "", "시작 명령 기준"].filter(Boolean).join(" · ") };
  if (w.startAt == null && w.resultAt == null) return fields;
  return { ...fields, modelState: "unknown", model: "", effort: "", modelTitle: modelUnknownLabel(m.reason) };
}
function model(snapshot, includeWorks = true) {
  const cache = includeWorks ? modelCache : executionModelCache;
  const cached = modelCache.get(snapshot) || cache.get(snapshot);
  if (cached) return cached;
  if (snapshot.centerError || !snapshot.center)
    throw new Error(snapshot.centerError || "카드 상태를 읽을 수 없습니다");
  const { works, workError } = includeWorks ? prepareCenterWall(snapshot) : registeredCenterWorks(snapshot),
    briefs = buildHumanBrief(snapshot.center, snapshot.home);
  const cards = snapshot.center.cards,
    byKey = new Map(cards.map((c) => [c.key, c])),
    times = worktimes(snapshot);
  const parent = new Map(
    (works || []).flatMap((w) => w.executions.map((e) => [e.key, includeWorks ? w.key : "work:" + w.key])),
  );
  const rows = [
    ...(includeWorks ? works || [] : []).map((w) => pick(w, rowFields)),
    ...workspaceModel(snapshot.center, briefs).map((r) =>
      pick(
        {
          ...r,
          kind: "execution",
          workType: byKey.get(r.key).workType,
          parentWorkKey: parent.get(r.key) || "",
          revision: byKey.get(r.key).revision,
          bucket: executionBucket({ ...byKey.get(r.key), ...r }),
          ...runFields(times.get(r.key)),
        },
        rowFields,
      ),
    ),
  ];

  const reviewFlows = buildReviewFlows(cards);
  const reviewByCard = new Map(reviewFlows.flatMap(flow => flow.cardKeys.map(key => [key, flow])));
  for (const row of rows) row.reviewLabel = reviewByCard.get(row.key)?.summary || "";
  const result = {
    rows,
    works,
    workError,
    briefs,
    cards,
    byKey,
    reviewFlows,
    reviewByCard,
    identity: taskIdentity(cards),
    hierarchy: readActiveHierarchy(snapshot.entries || []),
  };
  cache.set(snapshot, result);
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
function mailRow(m, identity) {
  const target = identity.resolve(
    m.completion ? m.completionTaskId || m.executionKey : m.taskId || m.executionKey,
    m.executionKey,
  );
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
    card: target.state === "resolved"
      ? { key: target.key, title: target.card.title || target.key }
      : null,
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

// 담당자 상태에는 창이 열려 있거나 아직 안 닫힌 카드를 맡은 담당만 보인다(2026-10-02 [kyle]).
// 창도 닫히고 맡은 카드도 끝난 담당은 숨긴다. 세션 상태를 모르면 거르지 않는다.
const CLOSED_CARD_STATES = ["done", "cancelled", "superseded", "archived"];
export function visibleSessionRoles(center) {
  if (!center.runtimeKnown) return center.roles;
  const owners = new Set(
    center.cards
      .filter((c) => c.role && !CLOSED_CARD_STATES.includes(c.displayState))
      .map((c) => c.role),
  );
  return center.roles.filter(
    (r) => r.life?.state === "alive" || owners.has(r.role),
  );
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
        ...decisionContent(d),
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
      mail: mailRow(m, taskIdentity(snapshot.center?.cards || [])),
      body,
      error: body === null ? "본문 없음 또는 읽기 불가" : null,
    };
  }
  if (route === "mail") {
    const all = letters(snapshot),
      filtered = filterMail(all, url, { bodyOf: (m) => bodyOf(snapshot, m) })
        .slice()
        .reverse();
    const selected = page(filtered, url, "mailPage"),
      identity = taskIdentity(snapshot.center?.cards || []);
    return {
      ...stamp,
      ...selected,
      items: selected.items.map((m) => ({
        ...mailRow(m, identity),
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
      unread: all.filter(isUnreadLetter).length,
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
    commands.watch =
      watchJudgeCommand(settings.presets[settings.activePreset].roles.watch) ||
      "미설정 — 감시 프로필의 KADAN_JUDGE_MODEL 사용";
    commands.senior =
      seniorCommandLabel(settings.presets[settings.activePreset].roles.senior) ||
      "미설정 — kadan senior가 거절한다";
    return {
      ...stamp,
      settings,
      catalog,
      commands,
      // 감시 AI는 codex만 고를 수 있고, 1순위 포함 최대 N개를 자동으로 차례로 시도한다.
      watch: { runner: WATCH_RUNNER, maxAttempts: WATCH_MAX_ATTEMPTS },
      // 시니어도 codex만 고르고(senior.sh), 폴백 없이 한 번 부른다.
      senior: { runner: WATCH_RUNNER },
      roles: RUNNER_ROLE_LABELS,
      history: (snapshot.entries || [])
        .filter((e) => e.kind === "runner-settings")
        .slice(-10)
        .reverse(),
    };
  }
  if (snapshot.centerError || !snapshot.center)
    throw new Error(snapshot.centerError || "카드 상태를 읽을 수 없습니다");
  if (route === "worktime") {
    const period = url.searchParams.get("period") || "today";
    if (!WORKTIME_PERIODS.includes(period))
      throw Object.assign(new Error("기간은 today·7d·all 중 하나입니다"), {status: 400});
    return { ...stamp, ...summarizeWorktimes(worktimes(snapshot).values(), { period }) };
  }
  if (route === "summary") {
    const { works, workError } = registeredCenterWorks(snapshot),
      cards = snapshot.center.cards,
      linked = new Set((works || []).flatMap((work) => work.executions.map((e) => e.key)));
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
        work: works === null ? null : works.length,
        executions: cards.length,
        unlinked: cards.filter((card) => !linked.has(card.key)).length,
      },
      errors: [
        snapshot.error,
        snapshot.resourceError,
        workError,
        snapshot.decisionError,
      ].filter(Boolean),
    };
  }
  const includeWorks = route !== "workspace" ||
    (url.searchParams.get("collection") || "work") === "work" ||
    url.searchParams.get("layout") === "map";
  const m = model(snapshot, includeWorks);
  if (route === "review-result") {
    const card = m.byKey.get(url.searchParams.get("card") || "");
    if (!card) throw Object.assign(new Error("카드를 찾을 수 없습니다"), {status: 404});
    const result = readReviewResult(card);
    return {...stamp, ...result, html: result.body ? renderCardDocument(result.body, card) : null};
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
  if (route === "status") {
    const recent = recentExecutionEvents(m.cards);
    const statusWorks = m.rows.filter((r) => r.kind === "work").map(compact);
    const openDecisions = snapshot.decisionError ? null : (snapshot.decisions || []).filter((d) => d.status === "open");
    // 상단 띠의 나머지 세 질문. 세션 상태·원장을 모르면 null이다(dashboard-band.mjs).
    const live = liveSessions(snapshot.center);
    // 화면에는 최근 20건만 보이지만 슈퍼감독별 묶기는 열린 경보 전부로 센다.
    const allAlerts = snapshot.ledgerLines === null ? null : openAlerts(snapshot.entries || [], { limit: Infinity });
    const alerts = allAlerts && { count: allAlerts.count, items: allAlerts.items.slice(0, 20) };
    const statusRows = m.rows
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
      .map(compact);
    const supervisors = supervisorSummary({ hierarchy: m.hierarchy, rows: statusRows, works: statusWorks, decisions: openDecisions, alerts: allAlerts, live });
    // ?super=<역할>: 그 슈퍼감독 몫만. 감독(AI)이 경보를 받고 행동 전에 자기 판의 지금 상태를 작게 읽는 용도(2026-10-05 [kyle]).
    // 사람 화면과 같은 계산을 쓰고, 담당·요청자·수신자를 사슬 끝으로 올려 거른다.
    const superFilter = url.searchParams.get("super");
    if (superFilter) {
      if (!supervisors) throw Object.assign(new Error("관계표를 읽지 못해 슈퍼감독별로 거를 수 없습니다"), { status: 400 });
      const item = supervisors.items.find((s) => s.super === superFilter);
      if (!item) throw Object.assign(new Error(`관계표에서 사용자 바로 아래가 아닌 역할: ${superFilter}`), { status: 400 });
      const mine = (role) => supervisorOf(m.hierarchy, role) === superFilter;
      const myAlerts = (allAlerts?.items ?? []).filter((a) => mine(a.recipient));
      return {
        ...stamp,
        super: superFilter,
        supervisor: item,
        rows: statusRows.filter((r) => mine(r.owner)),
        works: statusWorks.filter((w) => mine(w.owner)),
        decisions: openDecisions === null ? null : openDecisions.filter((d) => mine(d.requestedBy)),
        alerts: allAlerts === null ? null : { count: myAlerts.length, items: myAlerts.slice(0, 20) },
        recent: recent.filter((e) => mine(e.role)).slice(0, 20).map((e) => ({ ...pick(e, ["at", "kind", "label", "role"]), card: pick(e.card, ["key", "title"]) })),
      };
    }
    return {
      ...stamp,
      works: statusWorks,
      cleanupRequest: staleCleanupRequest(
        m.cards.filter((c) => isExecution(c) && executionBucket(c) === "stale"),
      ),
      rows: statusRows,
      resources: snapshot.resources,
      resourceError: snapshot.resourceError,
      workError: m.workError,
      executionCount: m.cards.filter(isExecution).length,
      waitingQuestions: (() => {
        try { return letters(snapshot).filter(letter => letter.replyStatus === "waiting").length; }
        catch { return null; }
      })(),
      boards: snapshot.center.boards.map((b) => ({
        name: b.name,
        state: b.state,
        ...boardProgressCounts(b, { buckets: true }),
        watchHtml: renderWatchOverview(snapshot.center, b),
      })),
      watchHtml: renderWatchVerdict(snapshot.center, {
        runtime: snapshot.runtime,
      }),
      decisions: openDecisions,
      live,
      flow: flowSummary(m.reviewFlows),
      alerts,
      // 슈퍼감독마다 한 줄(관계표 기준). 관계표를 모르면 null.
      supervisors,
      // 전략 맵이 역할을 슈퍼감독 기지로 묶는 데 쓴다(2026-10-05). 관계표를 모르면 null.
      hierarchy: m.hierarchy ?? null,
      recentCounts: Object.fromEntries(["done", "failed", "send"].map(kind => [kind, recent.filter(event => event.kind === kind).length])),
      recent: recent
        .slice(0, 50)
        .map((e) => ({
          ...pick(e, ["at", "kind", "label", "role"]),
          card: pick(e.card, ["key", "title"]),
        })),
    };
  }
  if (route === "sessions") {
    const roles = visibleSessionRoles(snapshot.center);
    return {
      ...stamp,
      known: snapshot.center.runtimeKnown,
      hidden: snapshot.center.roles.length - roles.length,
      roles: roles.map((r) => ({
        role: r.role,
        harness: r.harness || null,
        model: r.model || null,
        life: pick(r.life || {}, ["state", "pidState"]),
      })),
    };
  }
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
    const q = (url.searchParams.get("q") || "").toLowerCase(),
      state = url.searchParams.get("runState") || "",
      runState = Object.hasOwn(RUN_STATE_LABELS, state) ? state : "",
      searched = rows.map((r) => ({
        ...r,
        stateLabel: Object.hasOwn(RUN_STATE_LABELS, r.state) ? RUN_STATE_LABELS[r.state] : r.state || r.result || "모름",
      })).filter((r) => !q || JSON.stringify(r).toLowerCase().includes(q));
    return {
      ...stamp,
      states: Object.entries(RUN_STATE_LABELS).map(([value, label]) => ({
        value, label, count: searched.filter((r) => r.state === value).length,
      })),
      all: searched.length,
      ...page(
        searched.filter((r) => !runState || r.state === runState),
        url,
        url.searchParams.has("runPage") ? "runPage" : "page",
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
        ["카드 상태", stateText[c.status] || c.status],
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
