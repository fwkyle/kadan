// 모든 우편 본문 맨 앞에 붙는 한 줄: `<보낸 사람> → <받는 사람>[ · <업무키>]` + 빈 줄.
// 역할 지침 템플릿 밖의 본문 내용이라 templateDigest·전문/요약 판정에 들어가지 않는다.
export function mailHeaderLine({by,role,workKey}={}) {
  const from=typeof by==='string'&&by.trim()?by.trim():'모름';
  const to=typeof role==='string'&&role.trim()?role.trim():'모름';
  const work=typeof workKey==='string'&&workKey.trim()?` · ${workKey.trim()}`:'';
  return `${from} → ${to}${work}\n\n`;
}

// 저장된 본문이 정확히 이 머리말로 시작할 때만 떼어 낸다(손으로 쓴 비슷한 첫 줄은 건드리지 않는다).
export function stripMailHeader(body, fields) {
  if (typeof body !== 'string') return body;
  const header = mailHeaderLine(fields);
  return body.startsWith(header) ? body.slice(header.length) : body;
}
