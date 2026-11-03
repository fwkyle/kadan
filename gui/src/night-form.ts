// PR3b: 저장소 화면의 '나이트런 중 자동 머지' 정책 양식에서 쓰는 순수 계산.
// 초기값·바뀜 판정은 `settings`(카단 설정) 기준이다. `effective`(연결 문서 값 포함)로 채우면
// 한 칸만 고쳐 저장해도 다른 칸의 연결 문서 값이 카단 설정으로 굳어 버리기 때문이다.
import type { NightLine } from "./night-repos.ts";

export type NightForm = { deploy: string; merge: string };
export type NightChange = { deployBranch?: string; nightMerge?: string };

export const MERGE_CHOICES = ["허용", "금지"] as const;
const BRANCH = /^(?:없음|[A-Za-z0-9._/-]+)$/; // 서버(src/night-repo-policy.mjs)와 같은 규칙

const saved = (line: NightLine) => ({
  deploy: line.settings?.deployBranch ?? null,
  merge: line.settings?.nightMerge ?? null,
});

// 카단 설정 값이 없으면 빈 칸(= 그대로). 빈 칸은 서버도 '값 유지'로 받는다.
export function initialForm(line: NightLine): NightForm {
  const s = saved(line);
  return { deploy: s.deploy ?? "", merge: s.merge ?? "" };
}

// 보낼 칸: 비어 있지 않고 카단 설정 값과 다른 칸만. 지우기는 대시보드가 받지 않으므로 빈 칸을 보내지 않는다.
export function changesOf(line: NightLine, form: NightForm): NightChange {
  const s = saved(line), out: NightChange = {};
  const deploy = form.deploy.trim();
  if (deploy !== "" && deploy !== s.deploy) out.deployBranch = deploy;
  if (form.merge !== "" && form.merge !== s.merge) out.nightMerge = form.merge;
  return out;
}

export function problemOf(change: NightChange): string | null {
  if (change.deployBranch !== undefined && !BRANCH.test(change.deployBranch))
    return "배포 브랜치는 브랜치 이름(영문·숫자·. _ / -) 또는 '없음'이어야 합니다";
  return null;
}

export const canSave = (change: NightChange) =>
  (change.deployBranch !== undefined || change.nightMerge !== undefined) && problemOf(change) === null;

// 저장 전 확인 줄. 카단 설정이 비어 있던 칸을 채우면 연결 문서 값보다 우선하게 된다는 점을 함께 말한다.
export function confirmText(line: NightLine, change: NightChange): string {
  const s = saved(line), parts: string[] = [], notes: string[] = [];
  const show = (v: string | null) => v ?? "카단 설정 없음";
  if (change.deployBranch !== undefined) {
    parts.push(`배포 브랜치 ${show(s.deploy)}→${change.deployBranch}`);
    const card = line.effective.deployBranch;
    if (s.deploy === null && card.from === "ontology") notes.push(`배포 브랜치는 카단 설정으로 덮어씀 → 연결 문서 값(${card.value})보다 우선`);
  }
  if (change.nightMerge !== undefined) {
    parts.push(`나이트런 중 자동 머지 ${show(s.merge)}→${change.nightMerge}`);
    const card = line.effective.nightMerge;
    if (s.merge === null && card.from === "ontology") notes.push(`나이트런 중 자동 머지는 카단 설정으로 덮어씀 → 연결 문서 값(${card.value})보다 우선`);
  }
  return `${line.github}: ${parts.join(", ")}로 바꿉니다${notes.length ? ` (${notes.join("; ")})` : ""}`;
}

// 칸 옆 안내: 카단 설정이 비어 있고 연결 문서 값이 있을 때만.
export function cardHint(line: NightLine, field: "deployBranch" | "nightMerge"): string | null {
  const eff = line.effective[field];
  const own = field === "deployBranch" ? saved(line).deploy : saved(line).merge;
  return own === null && eff.from === "ontology" && eff.value ? `연결 문서 값: ${eff.value}` : null;
}

export const fieldsOf = (line: NightLine, change: NightChange): Record<string, string> => ({ repo: line.github, ...change });
