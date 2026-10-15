import path from 'node:path';
import {spawnSync} from 'node:child_process';

export function processIdentity(pid, run = spawnSync) {
  if (!/^\d+$/.test(String(pid)) || Number(pid) <= 1) throw new Error('프로세스 PID 확인 실패');
  const reply = run('ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'lstart=', '-o', 'comm='],
    {encoding: 'utf8', timeout: 3000, env: {...process.env, LC_ALL: 'C'}});
  const match = reply.stdout?.trim().match(/^(\d+)\s+(.{24})\s+(.+)$/);
  if (reply.status !== 0 || !match) throw new Error('프로세스 신원 확인 실패');
  return {pid: String(pid), parent: match[1], started: match[2], executable: match[3]};
}

export function ancestors(pid = process.pid, inspect = processIdentity) {
  const rows = [];
  const seen = new Set();
  while (Number(pid) > 1 && rows.length < 64) {
    if (seen.has(String(pid))) throw new Error('프로세스 관계가 순환합니다.');
    seen.add(String(pid));
    const row = inspect(pid);
    rows.push(row);
    pid = row.parent;
  }
  return rows;
}

export function rottieQuery(bin, args, run = spawnSync) {
  if (!path.isAbsolute(bin || '')) throw new Error('원본 Rottie 실행 파일 경로가 없습니다.');
  const result = run(bin, [...args, '--json'], {encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024});
  let reply;
  try { reply = JSON.parse(result.stdout); } catch { /* Never expose arbitrary process output. */ }
  if (result.status !== 0 || reply?.ok !== true) throw new Error('원본 Rottie 탭 조회 실패');
  if (!reply.runtime?.bundleId || !reply.runtime?.build) throw new Error('Rottie 실행 앱 신원 확인 실패');
  return reply;
}

export function sourceAgent({conversation, env = process.env, inspect = processIdentity,
  lineage = ancestors(process.pid, inspect), run = spawnSync}) {
  const current = conversation.harness === 'claude' ? env.CLAUDE_CODE_SESSION_ID : env.CODEX_THREAD_ID;
  if (current === conversation.id) {
    const ai = lineage.find(row => path.basename(row.executable) === conversation.harness);
    if (ai) return ai;
  }
  // A secretary can locate the original process by its exact open transcript, never by tab title.
  if (!conversation.file) return null;
  const result = run('lsof', ['-t', '--', conversation.file], {encoding: 'utf8', timeout: 3000});
  if (result.status !== 0) return null;
  const matches = [...new Set(result.stdout.trim().split(/\s+/))].filter(pid => /^\d+$/.test(pid))
    .map(pid => inspect(pid)).filter(row => path.basename(row.executable) === conversation.harness);
  return matches.length === 1 ? matches[0] : null;
}

export function captureSource({conversation, env = process.env, inspect = processIdentity,
  lineage = ancestors(process.pid, inspect), query = rottieQuery, run = spawnSync}) {
  if (!env.KADAN_ROTTIE_BIN) return null;
  const ai = sourceAgent({conversation, env, inspect, lineage, run});
  if (!ai) throw new Error('원본 대화 프로세스 확인이 필요합니다. 비서가 두 창을 확인할 동안 원본 탭은 보존합니다.');
  const reply = query(env.KADAN_ROTTIE_BIN, ['terminal', 'list']);
  const parents = ancestors(ai.pid, inspect);
  const matches = reply.result?.terminals?.filter(tab => tab.state === 'running'
    && parents.some(row => row.pid === String(tab.pid)));
  if (!Array.isArray(matches) || matches.length > 1) throw new Error('원본 Rottie 탭을 하나로 확인하지 못했습니다.');
  if (!matches.length) throw new Error('연결된 원본 Rottie 탭을 찾지 못했습니다. 비서 확인 전까지 보존합니다.');
  const tab = matches[0];
  return {bin: env.KADAN_ROTTIE_BIN, runtime: reply.runtime, terminalId: tab.id,
    shell: inspect(tab.pid), ai};
}

// Workspace/user settings are reloaded in the same cwd. Per-launch overrides need explicit handling;
// never silently drop a deny list or a restricted tool set while claiming equivalent permissions.
export function checkLaunchPermissions(ai, run = spawnSync) {
  if (!ai) return;
  const result = run('ps', ['-ww', '-p', ai.pid, '-o', 'args='], {encoding: 'utf8', timeout: 3000});
  if (result.status !== 0) throw new Error('원본 실행 권한 옵션을 확인하지 못했습니다.');
  const overrides = ['allowedTools', 'allowed-tools', 'disallowedTools', 'disallowed-tools',
    'tools', 'restricted', 'settings', 'setting-sources', 'add-dir', 'permission-prompt-tool'];
  const pattern = new RegExp(`(?:^|\\s)--(?:${overrides.join('|')})(?:[=\\s]|$)`);
  if (pattern.test(result.stdout)) {
    throw new Error('원본에 별도 도구·설정 권한 옵션이 있습니다. 비서가 그 옵션을 확인한 뒤 이어 주세요.');
  }
}

export function verifySource(source, {inspect = processIdentity, query = rottieQuery} = {}) {
  const reply = query(source.bin, ['terminal', 'show', '--terminal', source.terminalId]);
  const tab = reply.result?.terminal;
  if (reply.runtime.bundleId !== source.runtime.bundleId || reply.runtime.build !== source.runtime.build
    || reply.runtime.binarySha256 !== source.runtime.binarySha256
    || tab?.id !== source.terminalId || tab?.state !== 'running' || String(tab?.pid) !== source.shell.pid
    || JSON.stringify(inspect(source.shell.pid)) !== JSON.stringify(source.shell)
    || JSON.stringify(inspect(source.ai.pid)) !== JSON.stringify(source.ai)
    || !ancestors(source.ai.pid, inspect).some(row => row.pid === source.shell.pid)) {
    throw new Error('원본 탭 또는 프로세스가 바뀌었습니다. 닫지 않습니다.');
  }
}
