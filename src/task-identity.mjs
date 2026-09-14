// Why: 같은 카드의 두 주소를 화면·감시·완료가 함께 해석한다. 저장 원문은 바꾸지 않는다.
// 저장소/카드ID가 정식 주소이며 짧은 ID는 유일할 때만 별칭이다.
export function taskIdentity(cards = []) {
  const keys = new Map(), ids = new Map();
  for (const card of cards) {
    keys.set(card.key, card);
    if (!ids.has(card.id)) ids.set(card.id, []);
    ids.get(card.id).push(card);
  }
  const taskIdFor = card => ids.get(card.id)?.length === 1 ? card.id : card.key;
  const resolve = (taskId, executionKey) => {
    const address = executionKey || taskId;
    const matches = address?.includes('/') ? (keys.has(address) ? [keys.get(address)] : []) : (ids.get(address) || []);
    if (matches.length !== 1) return {state:matches.length ? 'ambiguous' : address?.includes('/') ? 'missing-address' : 'unregistered',
      taskId, candidates:matches.map(c => c.key), reason:matches.length ? '짧은 카드 ID가 여러 저장소에 있습니다. 정식 주소가 필요합니다.' : address?.includes('/') ? '해당 정식 주소의 중앙 카드가 없습니다.' : '중앙 카드 미등록'};
    const card = matches[0];
    if (executionKey && taskId && taskId !== card.id && taskId !== card.key) return {state:'conflict',taskId,candidates:[],reason:'taskId와 executionKey가 다른 카드입니다.'};
    return {state:'resolved',taskId:taskIdFor(card),key:card.key,card};
  };
  const write = (taskId, executionKey) => {
    const found = resolve(taskId, executionKey);
    if (!['resolved','unregistered'].includes(found.state)) throw new Error(`기록 연결 실패: ${taskId} — ${found.reason}`);
    return found.key ? {taskId:found.taskId,executionKey:found.key,...(taskId!==found.taskId?{rawTaskId:taskId}:{})} : {taskId};
  };
  const project = entries => {
    const seen = new Set();
    return entries.map(entry => {
      if (entry?.kind === 'handover' && Array.isArray(entry.taskIds)) return {...entry,taskIds:entry.taskIds.map(id => resolve(id).taskId)};
      if (!entry?.taskId) return entry;
      const found = resolve(entry.taskId, entry.executionKey);
      return {...entry,taskId:found.taskId,rawTaskId:entry.rawTaskId ?? entry.taskId,
        ...(found.key ? {executionKey:found.key} : {}),taskConnection:{state:found.state,reason:found.reason,candidates:found.candidates}};
    }).filter(entry => {
      if (entry?.kind !== 'done' || !entry.role || !entry.taskId) return true;
      // 별칭 해석 뒤에 최초 완료만 남긴다. 역할이 다르면 별개 실행이다.
      const connection=entry.taskConnection;
      const key = `${entry.role}\0${connection?.state==='resolved'?entry.executionKey:`${connection?.state}:${entry.taskId}:${entry.executionKey||''}`}`;
      if (seen.has(key)) return false;
      seen.add(key);return true;
    });
  };
  return {resolve,write,project,taskIdFor};
}

export const taskConnectionError = entry => Boolean(entry?.taskConnection && !['resolved','unregistered'].includes(entry.taskConnection.state));
export const taskEventKey = entry => taskConnectionError(entry) ? JSON.stringify(['unlinked',entry.taskId,entry.executionKey||'']) : entry.executionKey || entry.taskId;
