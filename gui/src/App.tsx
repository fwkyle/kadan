import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ErrorInfo, ReactNode } from "react";
import { useResource } from "./resource";
import {
  navigate,
  setNavigationGuard,
  useLocation,
  viewOf,
} from "./navigation";
import type { Summary } from "./types";
import { AppContext, ErrorMessage, Loading, time } from "./ui";
import { usePaneScroll } from "./scroll";
import { readTheme, saveTheme, type Theme } from "./theme";
const Status = lazy(() => import("./pages/Status")),
  Workspace = lazy(() => import("./pages/Workspace")),
  Decisions = lazy(() => import("./pages/Decisions")),
  Runners = lazy(() => import("./pages/Runners")),
  Operations = lazy(() => import("./pages/Operations")),
  Create = lazy(() => import("./pages/Create"));
const Mailbox = lazy(() =>
    import("./pages/Records").then((m) => ({ default: m.Mailbox })),
  ),
  Ledger = lazy(() =>
    import("./pages/Records").then((m) => ({ default: m.Ledger })),
  ),
  Runs = lazy(() =>
    import("./pages/Records").then((m) => ({ default: m.Runs })),
  ),
  Sessions = lazy(() =>
    import("./pages/Records").then((m) => ({ default: m.Sessions })),
  );
const links = [
  ["status", "전체 현황"],
  ["dashboard", "업무"],
  ["decisions", "내 결정"],
  ["runner-settings", "실행 모델"],
  ["mailbox", "우편함"],
  ["ledger", "기록"],
  ["runs", "실행 이력"],
  ["operations-flow", "업무 진행 이력"],
  ["sessions", "담당자 상태"],
  ["work-create", "새 업무"],
  ["card-create", "실행 추가"],
];
const primaryLinks = links.slice(0, 6);
export default function App() {
  const href = useLocation(),
    url = useMemo(() => new URL(href), [href]),
    view = viewOf(url),
    section = ["dashboard", "operations-flow", "work-create", "card-create"].includes(view)
      ? "dashboard" : view === "sessions" ? "status" : view === "runs" ? "ledger" : view,
    session = useResource<{ token: string }>("session", {
      pollMs: 0,
      staleMs: 300_000,
    }),
    summary = useResource<Summary>("summary");
  const drafts = useRef(new Set<string>()),
    [notice, setNotice] = useState(""),
    [theme, setTheme] = useState(readTheme);
  const mainScroll = usePaneScroll("page:" + view);
  const draft = useCallback((key: string, dirty: boolean) => {
    if (dirty) drafts.current.add(key);
    else drafts.current.delete(key);
  }, []);
  const context = useMemo(
    () => ({ token: session.data?.token || "", draft, notice: setNotice }),
    [session.data?.token, draft],
  );
  useEffect(() => {
    const guard = () =>
      !drafts.current.size ||
      confirm(
        "저장하지 않은 작성 내용이 있습니다. 이동하면 작성 내용을 버립니다. 계속할까요?",
      );
    setNavigationGuard(guard);
    const before = (e: BeforeUnloadEvent) => {
      if (drafts.current.size) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => {
      setNavigationGuard(() => true);
      window.removeEventListener("beforeunload", before);
    };
  }, []);
  useEffect(() => {
    document.title =
      (links.find(([key]) => key === view)?.[1] || "작업") + " · 카단";
  }, [view]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 7000);
    return () => clearTimeout(timer);
  }, [notice]);
  const content =
    view === "status" ? (
      <Status url={url} />
    ) : view === "dashboard" ? (
      <Workspace url={url} />
    ) : view === "decisions" ? (
      <Decisions url={url} />
    ) : view === "mailbox" ? (
      <Mailbox url={url} />
    ) : view === "ledger" ? (
      <Ledger url={url} />
    ) : view === "runs" ? (
      <Runs url={url} />
    ) : view === "sessions" ? (
      <Sessions />
    ) : view === "runner-settings" ? (
      <Runners />
    ) : view === "operations-flow" ? (
      <Operations url={url} />
    ) : view === "work-create" || view === "card-create" ? (
      <Create kind={view === "work-create" ? "work" : "execution"} />
    ) : (
      <section>
        <h1>화면을 찾을 수 없습니다.</h1>
        <a href="#status">현황으로</a>
      </section>
    );
  return (
    <AppContext value={context}>
      <div
        className="dw-shell"
        data-view={view}
        onClick={(event) => {
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          const anchor = (event.target as Element).closest("a");
          if (!anchor || anchor.target || anchor.hasAttribute("download"))
            return;
          const target = new URL(anchor.href);
          if (
            target.origin === location.origin &&
            target.pathname === "/" &&
            !target.searchParams.has("legacy")
          ) {
            event.preventDefault();
            navigate(target);
          }
        }}
      >
        <a
          className="skip-link"
          href="#main-content"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            document.getElementById("main-content")?.focus();
          }}
        >
          본문으로 건너뛰기
        </a>
        <header className="dw-top">
          <a className="dw-brand" href="#status">카단 라이트</a>
          <nav id="app-nav" aria-label="주 메뉴">
            {primaryLinks.map(([key, label]) => (
              <a
                key={key}
                href={key === "dashboard" ? "/?collection=work#dashboard" : "#" + key}
                aria-current={section === key ? "page" : undefined}
              >
                <span>{label}</span>
                {key === "decisions" && <span className="dw-decision-count">{summary.data?.decisions ?? "?"}</span>}
              </a>
            ))}
          </nav>
          <button type="button" className="dw-theme" aria-label="화면 테마 바꾸기" onClick={() => {
            const order: Theme[] = ["auto", "dark", "light"];
            const next = order[(order.indexOf(theme) + 1) % order.length];
            saveTheme(next);
            setTheme(next);
          }}>테마: {{auto:"자동",dark:"어둡게",light:"밝게"}[theme]}</button>
        </header>
        <main id="main-content" tabIndex={-1} {...mainScroll}>
          {(view === "ledger" || view === "runs") && <nav className="record-tabs" aria-label="기록 종류">
            <a href="#ledger" aria-current={view === "ledger" ? "page" : undefined}>활동 기록</a>
            <a href="#runs" aria-current={view === "runs" ? "page" : undefined}>실행 이력</a>
          </nav>}
          {view === "sessions" && <nav className="inline-nav" aria-label="상위 화면"><a href="#status">전체 현황으로</a></nav>}
          <ErrorMessage
            error={session.error}
            retry={() => void session.refresh(true)}
          />
          {notice && (
            <div className="toast" role="status">
              {notice}
              <button onClick={() => setNotice("")}>닫기</button>
            </div>
          )}
          {!session.data ? (
            <Loading />
          ) : (
            <Boundary key={view}>
              <Suspense fallback={<Loading />}>{content}</Suspense>
            </Boundary>
          )}
        </main>
        <footer>
          <span>실행 코드 {summary.data?.runtime?.commit?.slice(0, 7) || "모름"} · 시작 {time(summary.data?.runtime?.startedAt)}</span>
          <div id="dashboard-freshness" />
        </footer>
      </div>
    </AppContext>
  );
}
class Boundary extends Component<
  { children: ReactNode },
  { error: string | null }
> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }
  render() {
    return this.state.error ? (
      <ErrorMessage
        error={"화면을 표시하지 못했습니다: " + this.state.error}
        retry={() => location.reload()}
      />
    ) : (
      this.props.children
    );
  }
}
