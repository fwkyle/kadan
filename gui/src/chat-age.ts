// 채팅으로 이미 물은 결정(decision request --chat)이 안 닫힌 채 흐른 시간. 요청 시각을 모르면 빈 문자열.
export function chatAge(at: string | undefined, now: number): string {
  const start = Date.parse(at ?? "");
  if (!Number.isFinite(start) || now < start) return "";
  const minutes = Math.floor((now - start) / 60000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 경과`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}시간 경과` : `${Math.floor(hours / 24)}일 경과`;
}
