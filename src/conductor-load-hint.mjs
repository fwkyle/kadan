// 슈퍼감독이 일반감독에게 새 일을 우편으로 맡기는 순간, 받는 감독이 쥔 업무 수를 한 줄로 보여 준다.
// Why: "일이 쌓이면 감독을 나눈다"는 규칙이 있어도, 맡기는 사람 눈앞에 숫자가 없으면 한 감독에게 일이 몰린다.
// 같은 안내(`work create`의 "열린 업무 N건")는 업무를 만드는 일반감독에게만 보였다. 막지 않고 보여 주기만 한다.
// 비용: 조건에 맞는 우편(슈퍼 → 일반감독 새 맥락 우편)에서만 업무 요약을 한 번 읽는다. 원장은 전송 경로가 이미 읽은 것을 쓴다.
// 업무가 10배면 이 한 번의 읽기가 10배가 된다(감시기가 쓰는 요약 조회라 업무당 최신 한 줄 + 이력 최대 네 줄만 남긴다).
import {WorkStore} from './work-store.mjs';
import {withEffectiveOwner} from './handover-state.mjs';
import {isSuperRole, superProfiles} from './super-role.mjs';
import {readActiveHierarchy} from './hierarchy-register.mjs';
import {inferDispatchProfile} from './role-instructions.mjs';
import {readConductorOpenWorks} from './heavy-limit.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const NAMES_SHOWN = 3;

// 새 맥락 우편: 발령(taskId)·답장·--raw·감시 알림·자동 생성 우편이 아닌 것.
const isContextMail = e => e?.kind === 'send' && !e.taskId && !e.replyTo && e.replyFinal !== true
  && e.notificationOnly !== true && !e.systemGenerated;

// 받는 역할의 프로필. 시작 기록의 프로필이 먼저고, 없으면 이번 전송이 정한 프로필(receiptProfile),
// 그것도 없으면(보관 경로의 옛 역할) 전송 경로와 같은 추론 규칙을 쓴다. 이름으로 추측하지 않는다.
function recipientProfile({home, entries, recipient, profiles, receiptProfile}) {
  if (profiles.has(recipient)) return profiles.get(recipient);
  if (receiptProfile) return receiptProfile;
  return inferDispatchProfile({home, role: recipient, entries}).profile;
}

// 한 줄 문장(순수 함수). threshold가 0이면 기준 문장만 뺀다.
export function formatLoadHint({recipient, open, hold, recentMails, threshold}) {
  const names = open.slice(0, NAMES_SHOWN).join(', ') + (open.length > NAMES_SHOWN ? ` 외 ${open.length - NAMES_SHOWN}건` : '');
  const parts = [
    `받는 감독 ${recipient}: 진행 중 업무 ${open.length}건${open.length ? `(${names})` : ''}`,
    `보류 ${hold}건`,
    `최근 24시간 슈퍼감독이 맡긴 새 우편 ${recentMails}통(이번 포함)`,
  ];
  const rule = threshold > 0 && open.length >= threshold
    ? ` — 기준 ${threshold}개 이상: 고칠 파일이 겹치지 않으면 새 감독을 띄워 맡긴다(kyle 승인 불필요)`
    : '';
  return parts.join(' · ') + rule;
}

// 조건에 맞으면 안내 한 줄, 아니면 null. 싼 검사부터 하고, 업무 목록은 조건이 모두 맞은 뒤에만 읽는다.
// newContext: 이번 우편이 발령·답장·--raw가 아닌가(호출부가 플래그로 정한다). entries: 전송 준비 때 읽은 원장(이번 우편은 아직 없다).
export function conductorLoadHint({home, entries, by, recipient, receiptProfile, newContext, now = Date.now(),
  readWorks = () => new WorkStore(home).listWatch()}) {
  if (!newContext || !by || !recipient || by === recipient || !Array.isArray(entries)) return null;
  const profiles = superProfiles(entries);
  const parents = readActiveHierarchy(entries);
  const isSuper = role => isSuperRole(role, parents, profiles);
  if (!isSuper(by)) return null;
  if (recipientProfile({home, entries, recipient, profiles, receiptProfile}) !== 'conductor') return null;
  const mine = readWorks().map(w => withEffectiveOwner(w, entries)).filter(w => w.owner === recipient);
  const since = now - DAY_MS;
  const recentMails = 1 + entries.filter(e => isContextMail(e) && e.role === recipient
    && Date.parse(e.t) >= since && isSuper(e.by)).length;
  return formatLoadHint({
    recipient,
    open: mine.filter(w => w.status === 'open').map(w => w.key),
    hold: mine.filter(w => w.status === 'hold').length,
    recentMails,
    threshold: readConductorOpenWorks(home),
  });
}

// 전송(또는 보관) 영수증을 다 낸 뒤 stderr에 낸다. stdout은 건드리지 않는다(마지막 줄을 JSON으로 읽는 호출자가 있다).
// 조회가 실패하면 안내만 생략한다: 전송 결과·종료 코드는 그대로다.
export function printConductorLoadHint(input, print = line => console.error(line)) {
  try {
    const line = conductorLoadHint(input);
    if (line) print(line);
  } catch { /* 안내는 선택이다 */ }
}
