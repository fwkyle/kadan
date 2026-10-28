// 모든 우편 본문 맨 앞에 붙는 한 줄: `<보낸 사람> → <받는 사람>[ · <업무키>]` + 빈 줄.
// 역할 지침 템플릿 밖의 본문 내용이라 templateDigest·전문/요약 판정에 들어가지 않는다.
export function mailHeaderLine({by,role,workKey}={}) {
  const from=typeof by==='string'&&by.trim()?by.trim():'모름';
  const to=typeof role==='string'&&role.trim()?role.trim():'모름';
  const work=typeof workKey==='string'&&workKey.trim()?` · ${workKey.trim()}`:'';
  return `${from} → ${to}${work}\n\n`;
}

// 표시·판정용: 우편 기록에 `header: true`가 있을 때만, 저장 당시의 보낸 사람·받는 사람(`role`)·업무로 만든 머리말을 뗀다.
// 지금 주소(`currentRecipient`)나 표지 없는 옛 편지의 손으로 쓴 첫 줄은 건드리지 않는다.
export function stripStoredHeader(body, entry) {
  if (typeof body !== 'string' || entry?.header !== true) return body;
  const header = mailHeaderLine({by: entry.by, role: entry.role, workKey: entry.workKey});
  return body.startsWith(header) ? body.slice(header.length) : body;
}
