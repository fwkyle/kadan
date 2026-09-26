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
import { AppContext, ErrorMessage, Loading } from "./ui";
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
  ["status", "현황"],
  ["dashboard", "작업"],
  ["decisions", "내 결정"],
  ["mailbox", "우편함"],
  ["ledger", "사건 기록"],
  ["runs", "실행 기록"],
  ["operations-flow", "업무 흐름"],
  ["sessions", "담당자 세션"],
  ["runner-settings", "실행 모델"],
];
export default function App() {
  const href = useLocation(),
    url = useMemo(() => new URL(href), [href]),
    view = viewOf(url),
    session = useResource<{ token: string }>("session", {
      pollMs: 0,
      staleMs: 300_000,
    }),
    summary = useResource<Summary>("summary");
  const drafts = useRef(new Set<string>()),
    [notice, setNotice] = useState(""),
    [mobile, setMobile] = useState(false);
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
    setMobile(false);
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
      <Status />
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
        className="app-shell"
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
        <header className="mobile-header">
          <strong>카단</strong>
          <button
            aria-expanded={mobile}
            aria-controls="app-nav"
            onClick={() => setMobile((x) => !x)}
          >
            메뉴
          </button>
        </header>
        <aside className={"sidebar" + (mobile ? " mobile-open" : "")}>
          <a className="brand" href="#status">
            카단 <small>작업 관제</small>
          </a>
          <nav id="app-nav" aria-label="주 메뉴">
            {links.map(([key, label]) => (
              <a
                key={key}
                href={"#" + key}
                aria-current={view === key ? "page" : undefined}
              >
                <span>{label}</span>
                {key === "decisions" && <b>{summary.data?.decisions ?? "?"}</b>}
                {key === "mailbox" && <b>{summary.data?.waiting ?? "?"}</b>}
              </a>
            ))}
          </nav>
          <div className="sidebar-foot">
            <span className="connection-dot" />
            로컬 대시보드
            <br />
            <small>화면별 15초 갱신</small>
            {summary.data?.runtime?.commit && (
              <small>{summary.data.runtime.commit.slice(0, 8)}</small>
            )}
          </div>
        </aside>
        <main id="main-content" tabIndex={-1}>
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
