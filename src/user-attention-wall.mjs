import { userAttention } from './user-attention.mjs';
const escape = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;')
  .replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');

export function renderUserAttention(snapshot, token) {
  let items;
  try {
    if (snapshot.ledgerLines === null) throw new Error('사용자 확인 기록을 읽을 수 없습니다');
    items = userAttention(snapshot.entries ?? [], snapshot.home);
  } catch {
    return '<section><h3>내 확인 필요 · 모름</h3><p role="alert">사용자 확인 기록을 읽을 수 없습니다.</p></section>';
  }
  return `<section aria-label="내 확인 필요"><h3>내 확인 필요 ${items.length}건</h3>` +
    items.map(item => {
      const action = item.waiting ? 'reply' : 'ack';
      const form = item.type === 'mail' && item.body !== null ?
        `<form method="post" action="/attention/${action}">` +
        `<input type="hidden" name="token" value="${escape(token)}">` +
        `<input type="hidden" name="id" value="${escape(item.id)}">` +
        (item.waiting ? '<label>답변<textarea name="text" required></textarea></label>' : '') +
        `<button>${item.waiting ? '답변 보관' : '확인했습니다'}</button></form>` : '';
      return `<article class="dc-card"><h4>${escape(item.title)} · ${escape(item.from)}</h4>` +
        `<p class="dc-pre">${escape(item.body ?? '본문을 읽지 못했습니다.')}</p>${form}</article>`;
    }).join('') + '</section>';
}
