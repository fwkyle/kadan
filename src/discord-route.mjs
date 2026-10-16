// 디코 우편의 받는이 정하기. 레포 포럼 글은 그 레포의 슈퍼감독이 받고, 찾지 못하면 비서가 받는다(이유를 우편 머리에 적는다).
// 새 대응표는 없다. 업무 글은 업무 책임자(owner)에서, 일반 글은 그 레포의 카드·업무 담당에서 관계표를 거슬러 올라가
// 가장 가까운 슈퍼감독을 찾는다(kadan tree의 supervisorSummary와 같은 nearestSuper). 레포 이름과 판 이름은 달라도 된다.
import {readLedger} from './ledger.mjs';
import {readActiveHierarchy} from './hierarchy-register.mjs';
import {superProfiles, nearestSuper} from './super-role.mjs';
import {readThreads} from './notify-threads.mjs';
import {CardStore} from './card-store.mjs';
import {WorkStore} from './work-store.mjs';
import {SECRETARY} from './mailbox.mjs';
import {floor} from './floor.mjs';

const DECISION_KEY = /\/__decisions__$/;

// 스레드 id로 그 글이 맡은 업무 키를 거꾸로 찾는다(notify-threads.json). 레포 '결정' 글은 업무가 아니다. 없거나 못 읽으면 null.
export function workKeyOf(home, threadId) {
  if (!home || !threadId) return null;
  try {
    const key = Object.entries(readThreads(home)).find(([, e]) => e.threadId === threadId)?.[0] ?? null;
    return key && !DECISION_KEY.test(key) ? key : null;
  } catch { return null; }
}

const defaultLive = () => new Set(floor.list().filter(s => s.alive !== false).map(s => s.session));

// 반환: {to, reason, workKey}. reason은 비서로 보낼 때만 있다("담당 슈퍼 없음 → 비서" 같은 이유).
// 포럼 글이 아니거나(#비서) 못 찾으면 defaultTo(비서). liveSessions: () => Set<세션 이름>, 시험에서 바꾼다.
export function resolveMailTarget(line, {home, defaultTo = SECRETARY, liveSessions = defaultLive} = {}) {
  const forum = typeof line.channel === 'string' && line.channel ? line.channel : null;
  if (!forum) return {to: defaultTo, reason: null, workKey: null};
  const workKey = workKeyOf(home, line.threadId);
  const fallback = reason => ({to: defaultTo, reason: `${reason} → ${defaultTo}`, workKey});
  let entries, parents, profiles, live;
  try {
    entries = readLedger(home);
    parents = readActiveHierarchy(entries);
    profiles = superProfiles(entries);
  } catch { return fallback('관계표를 읽지 못함'); }
  if (!parents) return fallback('관계표를 모름');
  try { live = liveSessions(); } catch { return fallback('살아 있는 세션을 확인하지 못함'); }
  const owners = new Set();
  try {
    if (workKey) owners.add(new WorkStore(home).get(workKey).owner);
    else {
      for (const c of new CardStore(home).listSummaries()) if (c.repo === forum && c.role) owners.add(c.role);
      for (const w of new WorkStore(home).list()) if (w.repo === forum && w.status === 'open' && w.owner) owners.add(w.owner);
    }
  } catch { return fallback('업무·카드를 읽지 못함'); }
  const supers = new Set([...owners].map(o => nearestSuper(o, parents, profiles)).filter(Boolean));
  if (!supers.size) return fallback('담당 슈퍼 없음');
  const alive = [...supers].filter(s => live.has(`kadan-${s}`));
  if (alive.length === 1) return {to: alive[0], reason: null, workKey};
  return fallback(alive.length ? `담당 슈퍼 ${alive.length}명이라 한 명으로 정하지 못함` : '담당 슈퍼 세션 없음');
}
