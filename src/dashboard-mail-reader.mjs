// Why: 우편 목록과 본문은 전체 화면·tmux 수집 없이 현재 상태와 필요한 원문을 읽는다.
import {queryDashboardMail, queryDashboardMailBody} from './dashboard-mail-query.mjs';
import {createWatchStoreReaders} from './watch-store-cache.mjs';
import {taskIdentity} from './task-identity.mjs';
import {mailRow, bodyOf} from './dashboard/shared.mjs';

export function createDashboardMailReader(home, {runtime = null, now = Date.now, readCards} = {}) {
  const cards = readCards ? null : createWatchStoreReaders(home).cards;
  const metadata = () => {
    // 기존 mailData는 카드 수집 오류 때 링크 없이 우편 자체를 보여 준다.
    try {return (readCards ? readCards() : cards.read()).map(({key, id, title}) => ({key, id, title}));}
    catch {return [];}
  };
  const body = mail => bodyOf({home}, mail);
  return url => {
    const stamp = () => ({collectedAt:new Date(now()).toISOString(), runtime});
    if (url.pathname === '/api/dashboard/mail-body') {
      const found = queryDashboardMailBody(home, url, metadata), text = body(found.mail);
      return {...stamp(), mail:mailRow(found.mail, taskIdentity(found.cards)), body:text,
        error:text === null ? '본문 없음 또는 읽기 불가' : null};
    }
    const {page, cards} = queryDashboardMail(home, url, {bodyOf:body, readCards:metadata});
    const identity = taskIdentity(cards);
    return {...stamp(), ...page, items:page.items.map(mail => ({...mailRow(mail, identity),
      preview:mail.preview || String(body(mail) || '').replace(/\s+/g, ' ').slice(0, 120)}))};
  };
}
