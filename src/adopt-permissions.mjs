// Read the exact conversation, never a newest-file guess or another role's defaults.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const modes = ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];
export const shellArg = value => `'${String(value).replace(/'/g, "'\\''")}'`;

export function conversationFile({harness, id, cwd = process.cwd(), userHome = os.homedir(),
  codexHome = process.env.CODEX_HOME || path.join(userHome, '.codex')}) {
  if (!/^[\w-]+$/.test(id)) throw new Error('대화 ID를 확인할 수 없습니다.');
  if (harness === 'claude') {
    return path.join(userHome, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`);
  }
  const root = path.join(codexHome, 'sessions');
  const files = fs.readdirSync(root, {recursive: true}).filter(name => name.endsWith(`-${id}.jsonl`));
  if (files.length !== 1) throw new Error('정확한 Codex 대화 기록을 하나로 확인하지 못했습니다.');
  const file = path.join(root, files[0]);
  const first = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
  if (first.type !== 'session_meta' || first.payload?.id !== id || first.payload?.cwd !== cwd) {
    throw new Error('Codex 대화 ID 또는 시작 폴더가 다릅니다.');
  }
  return file;
}

export function readConversationPermissions(file, harness) {
  let mode, context, sessionId, lastUser = null;
  // Permission changes are events too; a later plan/default must override an earlier bypass.
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); }
    catch { throw new Error('대화 기록이 쓰이는 중이거나 손상됐습니다. 원본은 보존합니다.'); }
    if (harness === 'claude') {
      if (['user', 'permission-mode'].includes(event.type) && event.permissionMode) {
        mode = event.permissionMode; sessionId = event.sessionId;
      }
      if (event.type === 'user' && (typeof event.message?.content === 'string'
        || event.message?.content?.some(part => part.type === 'text'))) lastUser = event.uuid;
    } else {
      if (event.type === 'turn_context') context = event.payload;
      if (event.type === 'event_msg' && event.payload?.type === 'user_message') {
        lastUser = event.timestamp;
      }
    }
  }
  if (harness === 'claude') {
    if (!modes.includes(mode)) throw new Error('원본 대화의 현재 권한 모드를 확인하지 못했습니다.');
    if (mode === 'default') mode = 'manual';
    return {args: ['--permission-mode', mode], mode, sessionId, lastUser};
  }
  const approval = context?.approval_policy;
  const sandbox = context?.sandbox_policy;
  if (!['never', 'on-request', 'on-failure', 'untrusted'].includes(approval)
    || !['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox?.type)) {
    throw new Error('원본 Codex 승인·샌드박스 설정을 안전하게 이어받을 수 없습니다.');
  }
  const args = ['-c', `approval_policy=${JSON.stringify(approval)}`,
    '-c', `sandbox_mode=${JSON.stringify(sandbox.type)}`];
  if (sandbox.type === 'workspace-write') {
    const supported = ['type', 'writable_roots', 'network_access', 'exclude_tmpdir_env_var', 'exclude_slash_tmp'];
    if (Object.keys(sandbox).some(key => !supported.includes(key))) {
      throw new Error('지원하지 않는 Codex 샌드박스 제한입니다.');
    }
    for (const key of supported.slice(1)) {
      const value = sandbox[key];
      if (value === undefined) throw new Error(`Codex 샌드박스 제한 누락: ${key}`);
      if (key === 'writable_roots' ? !Array.isArray(value) || value.some(v => typeof v !== 'string')
        : typeof value !== 'boolean') throw new Error('Codex 샌드박스 제한 형식이 다릅니다.');
      args.push('-c', `sandbox_workspace_write.${key}=${JSON.stringify(value)}`);
    }
  } else if (Object.keys(sandbox).some(key => key !== 'type')) {
    throw new Error('지원하지 않는 Codex 샌드박스 제한입니다.');
  }
  return {args, approval, sandbox, lastUser};
}
