// 저장소 선택(PR2): 고른 저장소는 주소 `?repo=<저장소>`에 둔다. '전체'는 `?repo=` 없음.
// 메뉴·브랜드·화면 안 링크로 옮겨도 이 값이 유지되도록 주소를 만드는 순수 함수 모음.

// 상대 주소(`#status`, `/?collection=work#dashboard`)에 repo를 붙인다. repo가 없으면 그대로.
export function repoHref(href: string, repo: string | null) {
  if (!repo) return href;
  const url = new URL(href, "http://local/");
  url.searchParams.set("repo", repo);
  return url.pathname + url.search + url.hash;
}

// 링크 클릭 때: 지금 `?repo=`가 있고 목적지에 repo가 없으면 붙인다. '전체'처럼 일부러 푸는 링크는 clear=true.
export function carryRepo(target: URL, current: string | null, clear = false) {
  if (!current || clear || target.searchParams.has("repo") || target.pathname !== "/") return target;
  const next = new URL(target);
  next.searchParams.set("repo", current);
  return next;
}

// 사이드 탭에서 저장소를 바꾼 주소: 현재 화면(해시)을 유지하고 repo만 바꾼다. 쪽 번호는 버린다.
export function repoSwitchUrl(from: URL, repo: string | null) {
  const url = new URL(from);
  if (repo) url.searchParams.set("repo", repo);
  else url.searchParams.delete("repo");
  url.searchParams.delete("page");
  return url.pathname + url.search + url.hash;
}
