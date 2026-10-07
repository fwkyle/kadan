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
import { AppContext, ErrorMessage, Loading, Roll, time } from "./ui";
import SecretaryNotice from "./SecretaryNotice";
import { useFreshMarks } from "./fresh";
import { usePaneScroll } from "./scroll";
import { readTheme, saveTheme, THEME_LABEL, THEME_ORDER } from "./theme";
import Comms from "./Comms";
const Status = lazy(() => import("./pages/Status")),
  Workspace = lazy(() => import("./pages/Workspace")),
  Decisions = lazy(() => import("./pages/Decisions")),
  Runners = lazy(() => import("./pages/Runners")),
  Operations = lazy(() => import("./pages/Operations")),
  Create = lazy(() => import("./pages/Create")),
  StrategyMap = lazy(() => import("./pages/StrategyMap"));
const Mailbox = lazy(() =>
    import("./pages/Records").then((m) => ({ default: m.Mailbox })),
  ),
  Ledger = lazy(() =>
    import("./pages/Records").then((m) => ({ default: m.Ledger })),
  ),
  Runs = lazy(() =>
    import("./pages/Records").then((m) => ({ default: m.Runs })),
  );
const links = [
  ["status", "전체 현황"],
  ["strategy-map", "전략 맵"],
  ["dashboard", "워크·카드"],
  ["decisions", "내 결정"],
  ["runner-settings", "실행 모델"],
  ["mailbox", "우편함"],
  ["ledger", "기록"],
  ["runs", "실행 이력"],
  ["operations-flow", "워크 진행 이력"],
  ["work-create", "새 워크"],
  ["card-create", "카드 추가"],
];
const primaryLinks = links.slice(0, 7);
export default function App() {
  const href = useLocation(),
    url = useMemo(() => new URL(href), [href]),
    view = viewOf(url),
    section = ["dashboard", "operations-flow", "work-create", "card-create"].includes(view)
      ? "dashboard" : view === "runs" ? "ledger" : view,
    session = useResource<{ token: string }>("session", {
      pollMs: 0,
      staleMs: 300_000,
    }),
    summary = useResource<Summary>("summary");
  const drafts = useRef(new Set<string>()),
    [notice, setNotice] = useState(""),
    [theme, setTheme] = useState(readTheme);
  const mainScroll = usePaneScroll("page:" + view);
  useFreshMarks(view);
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
    ) : view === "strategy-map" ? (
      <StrategyMap />
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
    ) : view === "runner-settings" ? (
      <Runners url={url} />
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
          <a className="dw-brand" href="#status">카단</a>
          <nav id="app-nav" aria-label="주 메뉴">
            {primaryLinks.map(([key, label]) => (
              <a
                key={key}
                href={key === "dashboard" ? "/?collection=work#dashboard" : "#" + key}
                aria-current={section === key ? "page" : undefined}
              >
                <span>{label}</span>
                {key === "decisions" && <span className="dw-decision-count">{typeof summary.data?.decisions === "number" ? <Roll value={summary.data.decisions} /> : "?"}</span>}
              </a>
            ))}
          </nav>
          <button type="button" className="dw-theme" aria-label="화면 테마 바꾸기" onClick={() => {
            const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
            saveTheme(next);
            setTheme(next);
          }}>테마: {THEME_LABEL[theme]}</button>
        </header>
        <main id="main-content" tabIndex={-1} {...mainScroll}>
          {(view === "ledger" || view === "runs") && <nav className="record-tabs" aria-label="기록 종류">
            <a href="#ledger" aria-current={view === "ledger" ? "page" : undefined}>활동 기록</a>
            <a href="#runs" aria-current={view === "runs" ? "page" : undefined}>실행 이력</a>
          </nav>}
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
          <SecretaryNotice on={summary.data?.secretary} />
          {!session.data ? (
            <Loading />
          ) : (
            <Boundary key={view}>
              <Suspense fallback={<Loading />}>{content}</Suspense>
            </Boundary>
          )}
        </main>
        {theme === "space" && <Comms />}
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
