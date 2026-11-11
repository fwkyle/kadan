import { useResource } from "./resource";
import AutopilotPolicyForm from "./AutopilotPolicyForm";
import { time } from "./ui";
import { badgeOf, badgeTitle, groupByRepo, headFacts, sidebarBadge, LEVEL_LABEL, type AutopilotLine, type AutopilotRepos, type AutopilotStrip } from "./autopilot-repos";

// PR3: Autopilot 상태 띠 · 저장소별 'Autopilot 중 자동 머지' 뱃지와 머리 줄. 저장소 화면 머리의 양식만 쓰기다.
// `/api/autopilot/repos`는 정책이 바뀔 때만 바뀐다(약 1초·5.5KB). 타이머로 반복해 부르지 않는다:
// 페이지를 열 때와 저장소 화면을 열 때(30초 넘게 지났을 때)만 읽는다. 저장하면 save()가 한 번 다시 읽는다(PR3b).
export function useAutopilotRepos() {
  return useResource<AutopilotRepos>("/api/autopilot/repos", { pollMs: 0, staleMs: 30_000 });
}

const END_TEXT: Record<string, string> = { off: "kyle이 껐음", expired: "끝 시각이 지났음", "ended-by-input": "kyle의 새 입력이 있었음" };
export function AutopilotBand({ autopilot }: { autopilot?: AutopilotStrip | null }) {
  if (!autopilot) return null;
  let text: string;
  if (autopilot.on === null) text = `Autopilot 상태 모름${autopilot.reason ? ` (${autopilot.reason})` : ""}`;
  else if (autopilot.on) text = `Autopilot 켜짐${autopilot.level ? ` · 단계 ${LEVEL_LABEL[autopilot.level] ?? autopilot.level}` : ""}${autopilot.level === "full" ? ` · 추천대로 진행 ${autopilot.decideAfterMs ? `${Math.round(autopilot.decideAfterMs / 60000)}분 뒤` : "안 함(대기 시간 모름)"}` : ""} · ${time(autopilot.since)} 시작 · ${autopilot.until ? `${time(autopilot.until)}까지` : "끝 없음(직접 끌 때까지)"}`;
  else if (autopilot.last) text = `Autopilot 꺼짐 · 마지막 ${time(autopilot.last.since)} ~ ${time(autopilot.last.endedAt)}${END_TEXT[autopilot.last.phase] ? ` (${END_TEXT[autopilot.last.phase]})` : ""}`;
  else text = "Autopilot 꺼짐 · 켠 기록이 없습니다";
  return <p id="status-autopilot" className={"st-autopilot" + (autopilot.on ? " st-autopilot-on" : "")} role="status"><span aria-hidden="true">🌙</span> {text}</p>;
}

// 정책을 읽지 못했거나 손상됐을 때 보이는 문장과 옛 형식 저장값 목록.
export function AutopilotPolicyNotes({ res }: { res: ReturnType<typeof useAutopilotRepos> }) {
  const { data, error } = res;
  return <>
    {error && !data && <p className="st-error" role="alert">저장소별 Autopilot 정책을 읽지 못했습니다: {error}</p>}
    {data?.corrupt && <p className="st-error" role="alert">저장소별 Autopilot 정책 파일이 손상됐습니다. 읽는 쪽은 자동 머지 안 함으로 봅니다: {data.corrupt}</p>}
    {data && data.legacy.length > 0 && <p className="st-hint" id="status-autopilot-legacy">다시 설정 필요(옛 형식 저장값, 판정에 쓰지 않음): {data.legacy.map((l) => l.name).join(", ")}</p>}
  </>;
}

const kindClass = (kind: string) => "st-autopilot-badge st-autopilot-" + kind;
// 사이드 탭 🌙 뱃지. 켜짐이면 강조하고, 줄이 없으면 아무것도 보이지 않는다(정책 없음을 단정하지 않는다).
export function SideAutopilotBadge({ lines, on }: { lines: AutopilotLine[] | undefined; on: boolean | null }) {
  const badge = lines && sidebarBadge(lines);
  if (!badge) return null;
  return <span className={kindClass(badge.kind) + (on ? " st-autopilot-lit" : "")} title={badgeTitle(on, badge) + (lines!.length > 1 ? ` · GitHub 저장소 ${lines!.length}개` : "")}>🌙 {badge.text}</span>;
}

// 저장소 화면 머리: github별 한 줄 — github · 배포 브랜치(출처) · Autopilot 중 자동 머지 · 판정 문구.
export function RepoAutopilotHead({ repo, res, on }: { repo: string; res: ReturnType<typeof useAutopilotRepos>; on: boolean | null }) {
  const { data, error } = res;
  const lines = data ? groupByRepo(data.repos, [repo]).byRepo.get(repo) ?? [] : [];
  return <section id="status-repo-autopilot" className="st-autopilot-head" aria-label="Autopilot 중 자동 머지">
    <h3>🌙 Autopilot 중 자동 머지</h3>
    {!data && !error && <p className="st-hint">불러오는 중…</p>}
    {error && !data && <p className="st-error" role="alert">정책을 읽지 못했습니다: {error}</p>}
    {data && lines.length === 0 && <p className="st-hint">이 저장소 이름과 맞는 GitHub 저장소 정책을 찾지 못했습니다(정책 없음으로 단정하지 않습니다).</p>}
    <ul className="st-autopilot-lines">{lines.map((line) => {
      const badge = badgeOf(line), facts = headFacts(line);
      return <li key={line.github} className="st-autopilot-line">
        <strong>{line.github}</strong>
        <span>배포 브랜치 {facts.deploy} <small>({facts.deployFrom})</small></span>
        <span>Autopilot 중 자동 머지 {facts.policy}{facts.policyFrom && <small> ({facts.policyFrom})</small>}</span>
        <span className={kindClass(badge.kind) + (on ? " st-autopilot-lit" : "")} title={badgeTitle(on, badge)}>{badge.text}</span>
        {badge.detail && <small className="st-autopilot-detail">{badge.detail}</small>}
        <AutopilotPolicyForm key={`${line.github}|${line.settings?.deployBranch}|${line.settings?.nightMerge}`} line={line} autopilotOn={on} />
      </li>;
    })}</ul>
    <p className="st-hint">원격 보기에서는 양식이 보이지 않습니다. 명령으로 정하려면 <code>kadan autopilot repo &lt;소유자/이름&gt; …</code></p>
  </section>;
}

// '전체' 화면 아래: 사이드 탭에 없는 저장소·repo가 없는 줄은 github 이름으로 모아 보인다.
export function OtherGithub({ res, known, on }: { res: ReturnType<typeof useAutopilotRepos>; known: string[]; on: boolean | null }) {
  const orphans = res.data ? groupByRepo(res.data.repos, known).orphans : [];
  if (orphans.length === 0) return null;
  return <details id="status-autopilot-others" className="st-fold">
    <summary>기타 GitHub 저장소 {orphans.length}개 · Autopilot 중 자동 머지</summary>
    <ul className="st-autopilot-lines">{orphans.map((line) => {
      const badge = badgeOf(line);
      return <li key={line.github} className="st-autopilot-line">
        <strong>{line.github}</strong>{line.repo && <small>업무 저장소 {line.repo}(사이드 탭에 없음)</small>}
        <span className={kindClass(badge.kind) + (on ? " st-autopilot-lit" : "")} title={badgeTitle(on, badge)}>{badge.text}</span>
        {badge.detail && <small className="st-autopilot-detail">{badge.detail}</small>}
      </li>;
    })}</ul>
  </details>;
}
