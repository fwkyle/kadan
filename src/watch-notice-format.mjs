// 감시기가 역할 창에 넣는 알림 본문의 틀. 항목 이름(보낸이·받는이·대상 등)을 붙여 누가·누구에게·무엇을 한눈에 읽게 한다.
// 미확인 우편의 '보낸이'는 원래 우편을 보낸 역할이다(감시기가 아니다). 값은 호출한 쪽이 원장에서 가져온다(2026-10-21 [kyle]).
import { shellQuote } from "./mail-instructions.mjs";
import { scrubForAI } from "./explain-input.mjs";

// 해소 우편이 없으므로(2026-10-05 [kyle]) 경보를 받은 감독은 행동 전에 지금 상태를 스스로 확인한다.
export const WATCH_ALERT_FOOTER='행동 전 지금 상태를 확인하라(감독 템플릿의 현황 확인 절차). 풀렸으면 따로 알리지 않는다.';
export const MAIL_NOTICE_MAX = 5;
export const FIRST_LINE_MAX = 80;
const INSTRUCTIONS_BLOCK = /<!-- kadan:receiver-instructions -->[\s\S]*?(?:<!-- \/kadan:receiver-instructions -->|$)/u;
const recipientOf = mail => mail.currentRecipient || mail.role;

// KST(Asia/Seoul) 'YYYY-MM-DD HH:MM'
export function kstTime(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '시각 모름';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(date).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// 원장 preview(이미 한 줄로 펴진 앞부분)에서 지침 블록을 걷고 비밀을 가려 80자 이내로 자른다.
export function firstLine(preview) {
  const flat = scrubForAI(String(preview ?? '').replace(INSTRUCTIONS_BLOCK, ' ')).split(/\r?\n/u)[0].replace(/\s+/gu, ' ').trim();
  if (!flat) return '(본문 미리보기 없음)';
  const chars = [...flat];
  return chars.length <= FIRST_LINE_MAX ? flat : `${chars.slice(0, FIRST_LINE_MAX - 1).join('')}…`;
}

function mailBlock(mail, {status, ack}, textOf) {
  const to = recipientOf(mail), id = mail.mailId;
  return [`보낸이: ${mail.currentSender || mail.by || '모름'}`, `받는이: ${to}`, `보낸 시각: ${kstTime(mail.t)}`,
    `첫 줄: ${firstLine(textOf(mail))}`, ...(status ? [`상태: ${status}`] : []),
    `확인: kadan inbox read ${id} --role ${shellQuote(to)}`,
    ...(ack ? [`읽음 기록: kadan inbox ack ${id} --role ${shellQuote(to)}`] : [])].join('\n');
}

// 수신자 앞 미확인 우편 재알림. 우편마다 블록 하나, 5통까지 쓰고 넘으면 '외 N건'.
export function unreadMailMessage(mails, target, textOf = m => m.preview) {
  const rest = mails.length - MAIL_NOTICE_MAX;
  return [`미확인 우편 ${mails.length}건\n${mails.slice(0, MAIL_NOTICE_MAX).map(m => mailBlock(m, {ack: true}, textOf)).join('\n\n')}`,
    ...(rest > 0 ? [`외 ${rest}건 — kadan inbox --role ${shellQuote(target)} --unread`] : []),
    '읽은 우편만 직접 ack하세요. 최종 답변은 읽음 확인과 별개입니다.'].join('\n\n');
}

// 직속 상위 앞 알림. 읽음 확인은 수신자 몫이라 읽음 기록 명령은 넣지 않는다.
export function escalationNotice(items, textOf = m => m.preview) {
  const rest = items.length - MAIL_NOTICE_MAX;
  const blocks = items.slice(0, MAIL_NOTICE_MAX).map(({mail, kind, minutes}) =>
    mailBlock(mail, {status: kind === 'unknown' ? '결과 불명' : `${minutes}분째 미읽음`, ack: false}, textOf));
  return [`[감시sh] 하위 역할의 미읽음 우편 ${items.length}건\n${blocks.join('\n\n')}`,
    ...(rest > 0 ? [`외 ${rest}건`] : []),
    '읽음 확인은 수신자 몫이니 대신 ack하지 마세요.'].join('\n\n');
}
