// 시간 초과 때 이전 화면을 그대로 두고 알리는 작은 문구. 마지막으로 읽은 뒤 얼마나 지났는지 보인다.
export function lastReadLabel(updatedAt: number, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
  return seconds < 60 ? `${seconds}초 전` : `${Math.floor(seconds / 60)}분 전`;
}
