// The receiving agent acknowledges from its own process tree; screen echo is never an acknowledgement.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {conversationFile, readConversationPermissions, shellArg} from './adopt-permissions.mjs';
import {ancestors, processIdentity, verifySource} from './adopt-process.mjs';
import {closeRottieWindow, removeRottieWindow} from './floor-tmux.mjs';
import {appendLedger} from './ledger.mjs';
import {cleanWindowMessage} from './cli-start-support.mjs';

// 로티가 준 원인 문구는 코드 옆 `message`에 남긴다(#314 cleanWindowMessage 꼴). 문구가 비면 칸이 없다.
const messageField = message => { const text = cleanWindowMessage(message); return text ? {message: text} : {}; };
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n',
  {flag: 'wx', mode: 0o600});
function directory(home, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('올바른 인수 ID가 필요합니다.');
  return path.join(home, 'adoptions', id);
}

export function prepareTransfer({home, role, session, conversation, permissions, source, floor,
  inspect = processIdentity, cli = new URL('./cli.mjs', import.meta.url).pathname}) {
  if (!floor.alive(session)) throw new Error('새 감독 세션이 살아 있지 않습니다.');
  const target = inspect(floor.pid(session));
  if (source && ancestors(target.pid, inspect).some(row => row.pid === source.shell.pid)) {
    throw new Error('새 감독이 원본 탭 안에 있습니다. 원본 탭을 닫을 수 없습니다.');
  }
  const id = randomUUID();
  const dir = directory(home, id);
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  write(path.join(dir, 'request.json'), {id, role, session, conversation, permissions, source, target,
    createdAt: new Date().toISOString()});
  return {id, instruction: '대화에서 맡긴 목표·승인 범위·다음 행동을 먼저 확인하세요. '
    + '확인할 수 없으면 인수 명령을 실행하지 말고 막힌 점을 보고하세요. '
    + '확인했으면 이 새 감독 창에서 다음 명령의 설명을 실제 내용으로 바꾸어 한 번 실행하세요: '
    + `${shellArg(process.execPath)} ${shellArg(cli)} adopt accept ${id} `
    + '--summary "이어받은 목표·승인 범위와 다음 행동". '
    + '성공하면 원본 Rottie 탭이 닫힐 수 있습니다. 성공 결과를 확인한 뒤 맡은 일을 이어가세요.'};
}

export function acceptTransfer({home, id, flags, floor, env = process.env, inspect = processIdentity,
  lineage = () => ancestors(process.pid, inspect), verify = verifySource,
  readPermissions = readConversationPermissions, locate = conversationFile,
  close = closeRottieWindow, remove = removeRottieWindow, record = event => appendLedger(event, home)}) {
  const dir = directory(home, id);
  const request = JSON.parse(fs.readFileSync(path.join(dir, 'request.json'), 'utf8'));
  const resultPath = path.join(dir, 'result.json');
  if (fs.existsSync(resultPath)) return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  if (typeof flags.summary !== 'string' || !flags.summary.trim() || flags.summary.length > 4000
    || flags.summary === '이어받은 목표·승인 범위와 다음 행동') {
    throw new Error('이어받은 목표·승인 범위와 다음 행동을 --summary 한 문장으로 적어 주세요.');
  }
  const verifyReceiver = () => {
    if (env.KADAN_ROLE !== request.role || !floor.alive(request.session)
      || String(floor.pid(request.session)) !== request.target.pid
      || JSON.stringify(inspect(request.target.pid)) !== JSON.stringify(request.target)
      || !lineage().some(row => row.pid === request.target.pid)) {
      throw new Error('인수 확인은 생성한 새 감독 프로세스 안에서만 가능합니다.');
    }
  };
  verifyReceiver();
  const harness = request.conversation.harness;
  const currentId = harness === 'claude' ? env.CLAUDE_CODE_SESSION_ID : env.CODEX_THREAD_ID;
  if (!currentId || currentId === request.conversation.id) {
    throw new Error('새 감독의 복제 대화 ID를 확인하지 못했습니다.');
  }
  const currentFile = locate({harness, id: currentId, cwd: request.conversation.cwd});
  const currentPolicy = readPermissions(currentFile, harness);
  if ((harness === 'claude' && currentPolicy.sessionId !== currentId)
    || JSON.stringify(currentPolicy.args) !== JSON.stringify(request.permissions.args)) {
    throw new Error('새 감독의 실제 권한이 원본과 다릅니다. 원본 탭을 보존합니다.');
  }
  const original = readPermissions(request.conversation.file, harness);
  if (JSON.stringify(original) !== JSON.stringify(request.permissions)) {
    throw new Error('원본 대화의 지시 또는 권한이 바뀌었습니다. 원본 탭을 보존합니다.');
  }
  if (request.source) {
    verify(request.source);
    if (lineage().some(row => row.pid === request.source.shell.pid)) {
      throw new Error('인수 프로세스가 원본 탭 안에 있습니다. 닫지 않습니다.');
    }
  }
  // Exclusive receipt prevents duplicate closes, including an interrupted or ambiguous close.
  write(path.join(dir, 'accepted.json'), {role: request.role, conversation: currentId,
    summary: flags.summary, at: new Date().toISOString()});
  record({kind: 'adopt', phase: 'accepted', adoptionId: id, role: request.role, session: request.session,
    by: request.role, sourceTerminalId: request.source?.terminalId ?? null});
  let result = {id, status: 'accepted', source: 'retained', reason: '자동 종료할 원본 Rottie 탭 없음'};
  if (request.source) {
    // Recheck both ends after recording acceptance, immediately before closing the source.
    verifyReceiver();
    verify(request.source);
    const options = {bin: request.source.bin, terminalId: request.source.terminalId};
    const closed = close(options);
    result = {id, status: 'accepted', source: 'close-failed', code: closed.code, ...messageField(closed.message)};
    if (closed.closed) {
      const removed = remove(options);
      result = {id, status: 'accepted', source: removed.removed ? 'removed' : 'remove-failed', code: removed.code,
        ...(removed.removed ? {} : messageField(removed.message))};
    }
  }
  write(resultPath, result);
  record({kind: 'adopt', phase: 'finished', adoptionId: id, role: request.role, session: request.session,
    by: request.role, result});
  return result;
}

export function transferStatus(home, id) {
  const dir = directory(home, id);
  const request = JSON.parse(fs.readFileSync(path.join(dir, 'request.json'), 'utf8'));
  const result = path.join(dir, 'result.json');
  return {id, role: request.role, session: request.session, createdAt: request.createdAt,
    sourceTerminalId: request.source?.terminalId ?? null,
    ...(fs.existsSync(result) ? JSON.parse(fs.readFileSync(result, 'utf8')) :
      {status: fs.existsSync(path.join(dir, 'accepted.json')) ? 'accepted-unfinished' : 'awaiting-acceptance'})};
}
