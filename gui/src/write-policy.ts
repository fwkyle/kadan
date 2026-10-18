// 원격 보기에서 막지 않는 쓰기는 결정 token을 든 /decisions/answer 하나뿐이다. 서버도 같은 한 길만 연다.
export const writeAllowed = (action: string, token: string, remoteReadOnly: boolean) =>
  !remoteReadOnly || (action === "/decisions/answer" && token !== "");
