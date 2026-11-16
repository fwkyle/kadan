// Why: 상위가 kadan stop으로 일부러 끈 세션은 죽음 경보 대상이 아니다. 감독·작업자·검수자 감시가 같은 판정을 쓴다.
// 일부러 끈 것 = 그 세션의 마지막 수명 사건(start·stop)이 stop이고 restart: true가 아니다. 그 뒤 start(reopen 포함)가 있으면 해당 없다.
// 기억하는 값이 없다: 감시가 넘기는 entries는 순회마다 다시 만든 배열이라(카드 주소 재해석·거름) 순번 캐시는 앞부분이 빠지고
// 새 start가 붙어 길이가 같아지면 새 start를 건너뛰어 진짜 죽음을 숨긴다(검수 exec-62bf4611). 넘어온 배열에서 매번 뒤에서 찾는다.
// 비용: 죽은 세션이 범위에 있을 때만 부르고, 그 세션의 마지막 수명 사건까지의 거리만큼 훑는다(원장이 10배면 그 거리가 10배까지).
export function intendedStop(entries, session) {
  const e = entries.findLast(x => (x?.kind === 'start' || x?.kind === 'stop') && x.session === session);
  return e?.kind === 'stop' && e.restart !== true;
}
