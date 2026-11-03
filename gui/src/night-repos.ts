// PR3: `/api/night/repos`의 줄을 사이드 탭·저장소 화면 머리에 붙이는 순수 함수 모음.
// 저장소 키는 `repo`(업무 키 첫 마디)와 대소문자까지 정확히 같을 때만 붙인다(합치거나 추측하지 않는다).
// `card.folder`·`sources`는 다음 PR(C2a)에서 바뀌므로 쓰지 않는다.
export type NightLine = {
  github: string;
  repo?: string | null;
  effective: { deployBranch: { value: string | null; from: string | null }; nightMerge: { value: string | null; from: string | null } };
  verdict: { action: string; reason: string; detail?: string | null; exceptBranch?: string | null };
};
export type NightRepos = { corrupt: string | null; repos: NightLine[]; legacy: { name: string; value?: string }[] };
// 서버가 이미 읽은 원장·결정으로 센 나이트런 상태(src/dashboard/night-view.mjs). on이 null이면 모름.
export type NightStrip = {
  on: boolean | null; reason?: string; since?: string | null; until?: string | null; level?: string | null; onlyRunning?: boolean;
  last?: { since: string | null; endedAt: string | null; phase: string } | null;
};
export type BadgeKind = "allow" | "except" | "forbid" | "setup" | "unknown";
export type Badge = { kind: BadgeKind; text: string; detail: string | null };

// 판정 → 뱃지 문구. 모르는 판정은 '함'으로 꾸미지 않고 "판정 모름"으로 둔다. '밤 머지'라는 말은 쓰지 않는다.
export function badgeOf(line: NightLine): Badge {
  const { reason, exceptBranch, detail } = line.verdict;
  if (reason === "allowed") {
    return exceptBranch
      ? { kind: "except", text: `안 함(배포 브랜치 ${exceptBranch})`, detail: `${exceptBranch} 브랜치로 가는 PR만 자동 머지하지 않습니다` }
      : { kind: "allow", text: "함", detail: null };
  }
  if (reason === "night-merge-forbidden") return { kind: "forbid", text: "금지", detail: null };
  if (reason === "setup-needed") return { kind: "setup", text: "설정 필요", detail: detail ?? null };
  return { kind: "unknown", text: "판정 모름", detail: reason || null };
}

// 나이트런 켜짐과의 관계: 글자는 항상 판정 문구이고, 설명만 켜짐/꺼짐/모름에 따라 다르다.
export function badgeTitle(on: boolean | null, badge: Badge): string {
  const lead = on === true ? "나이트런 켜짐 · 자동 머지" : on === false ? "나이트런 꺼짐 · 켜지면 자동 머지" : "나이트런 상태 모름 · 켜지면 자동 머지";
  return `${lead}: ${badge.text}${badge.detail ? ` (${badge.detail})` : ""}`;
}

// 저장소 키(사이드 탭에 있는 이름)로 줄을 나눈다. 사이드 탭에 없거나 repo가 없는 줄은 orphans(기타 GitHub 저장소).
export function groupByRepo(lines: NightLine[], known: Iterable<string>) {
  const names = new Set(known);
  const byRepo = new Map<string, NightLine[]>();
  const orphans: NightLine[] = [];
  for (const line of lines) {
    if (line.repo && names.has(line.repo)) byRepo.set(line.repo, [...(byRepo.get(line.repo) ?? []), line]);
    else orphans.push(line);
  }
  return { byRepo, orphans };
}

// 사이드 탭용 한 칸: 줄이 하나면 그 문구, 여럿이 모두 같으면 "문구 N개", 다르면 "섞임".
export function sidebarBadge(lines: NightLine[]): Badge | null {
  if (lines.length === 0) return null;
  const badges = lines.map(badgeOf);
  const same = badges.every((b) => b.text === badges[0].text);
  if (lines.length === 1) return badges[0];
  return same ? { ...badges[0], text: `${badges[0].text} ${lines.length}개` } : { kind: "unknown", text: "섞임", detail: [...new Set(badges.map((b) => b.text))].join(" · ") };
}

const SOURCE: Record<string, string> = { kadan: "카단 설정", card: "연결 문서" };
export const sourceLabel = (from: string | null | undefined) => (from ? SOURCE[from] ?? from : "없음");
// 머리 줄에 쓰는 배포 브랜치·나이트런 중 자동 머지 값. nightMerge가 null이면 "기본 허용".
export function headFacts(line: NightLine) {
  const { deployBranch, nightMerge } = line.effective;
  return {
    deploy: deployBranch.value ?? "정해지지 않음",
    deployFrom: sourceLabel(deployBranch.from),
    policy: nightMerge.value ?? "기본 허용",
    policyFrom: nightMerge.value === null ? null : sourceLabel(nightMerge.from),
  };
}
