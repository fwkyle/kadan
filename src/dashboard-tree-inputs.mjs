// Why: 순회 시간표 같은 사건이 늘어도 역할 트리와 카드 상태를 다시 계산하지 않는다.
// 10배 이력에서도 정상 갱신은 새 사건만 분류한다. 과거 객체 보관은 별도 상태표 개선 대상이다.
// taskIdentity/workEntries/buildTree/buildCardCenter가 읽을 수 있는 사건은 모두 남긴다.
const relevant = e => Boolean(e?.role || e?.session || e?.taskId || e?.broken || e?.kind === 'handover');

export function createTreeInputCache() {
  let previous = null, length = 0, first, last, value = [], revision = 0;
  return entries => {
    if (entries === previous && entries.length === length) return {entries: value, revision};
    // 원장 읽기 모듈은 사건을 고치지 않고 새 배열에 추가한다. 교체/복구 때는 객체가 바뀐다.
    const appended = previous && entries.length >= length &&
      (!length || (entries[0] === first && entries[length - 1] === last));
    const added = [];
    for (let i = appended ? length : 0; i < entries.length; i++) {
      if (relevant(entries[i])) added.push(entries[i]);
    }
    if (!appended) { value = added; revision++; }
    else if (added.length) { value = value.concat(added); revision++; }
    previous = entries; length = entries.length; first = entries[0]; last = entries.at(-1);
    return {entries: value, revision};
  };
}
