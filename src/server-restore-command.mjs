// Why: 서버 손실 뒤 옛 첫 프롬프트를 재전송하지 않고, 확인된 같은 대화만 이어 연다.
import fs from 'node:fs';
import path from 'node:path';
import {commandWords} from './ai-identity.mjs';
import {dedupeResumeCommand, quoteWord, serializeWords} from './codex-option-merge.mjs';

const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const WEEK = 7 * 24 * 60 * 60 * 1000;
// 값 개수가 확실한 옵션만 보존한다. 가변 개수·선택 값·실행 방식 변경 옵션은 자동 복원하지 않는다.
const OPTIONS = {
  claude: {
    value: new Set(['--model', '--effort', '--agent', '--name', '-n', '--permission-mode',
      '--append-system-prompt', '--system-prompt', '--settings', '--setting-sources']),
    flag: new Set(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions',
      '--verbose', '--strict-mcp-config']),
  },
  codex: {
    value: new Set(['--model', '-m', '-c', '--config', '--profile', '-p', '--sandbox', '-s',
      '--ask-for-approval', '-a', '--enable', '--disable']),
    flag: new Set(['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust',
      '--no-alt-screen', '--search', '--strict-config']),
  },
};

export function parseRestoreCommand(command) {
  const words = commandWords(command);
  const harness = words?.[0]?.split('/').pop()?.replace(/^kadan-/, '');
  const spec = OPTIONS[harness];
  if (!spec) throw new Error('복원 명령의 실행기·인자 경계 불명');
  let args = words.slice(1), id = null;
  if (harness === 'codex') {
    if (args[0] !== 'resume' || !UUID.test(args[1] ?? '')) {
      throw new Error('codex 명령에 명시적인 resume ID 없음');
    }
    id = args[1];
    args = args.slice(2);
  }
  const options = [];
  let prompts = 0;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--') {
      if (prompts || args.length - i - 1 > 1) throw new Error('첫 프롬프트 경계 불명');
      break;
    }
    if (!token.startsWith('-')) {
      if (++prompts > 1) throw new Error('첫 프롬프트 경계 불명');
      continue;
    }
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    const name = eq > 0 ? token.slice(0, eq) : token;
    if (harness === 'claude' && ['--resume', '-r'].includes(name)) {
      const ref = eq > 0 ? token.slice(eq + 1) : args[++i];
      if (id || !UUID.test(ref ?? '')) throw new Error('Claude resume ID 불명 또는 중복');
      id = ref;
    } else if (spec.value.has(name)) {
      const value = eq > 0 ? token.slice(eq + 1) : args[++i];
      if (!value || value.startsWith('-')) throw new Error('옵션 값 불명');
      options.push(name, value);
    } else if (eq < 0 && spec.flag.has(name)) options.push(name);
    else throw new Error('값 개수를 확인하지 못한 옵션');
  }
  return {executable: words[0], harness, options, id};
}

// 파일 전체를 메모리에 올리지 않는다. 표시는 청크 경계를 넘어도 찾는다. 원문은 반환·기록하지 않는다.
function containsMarker(file, marker) {
  const fd = fs.openSync(file, 'r');
  const bytes = Buffer.alloc(64 * 1024), needle = Buffer.from(marker);
  let tail = Buffer.alloc(0);
  try {
    for (;;) {
      const length = fs.readSync(fd, bytes, 0, bytes.length, null);
      if (!length) return false;
      const chunk = Buffer.concat([tail, bytes.subarray(0, length)]);
      if (chunk.includes(needle)) return true;
      tail = Buffer.from(chunk.subarray(Math.max(0, chunk.length - needle.length + 1)));
    }
  } finally { fs.closeSync(fd); }
}

export function findClaudeRestore({start, projectsDir, now}) {
  const since = Date.parse(start.t);
  if (!Number.isFinite(since)) throw new Error('마지막 시작 시각 불명');
  const dir = path.join(projectsDir, start.cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  let names;
  try { names = fs.readdirSync(dir); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('역할 표시가 있는 Claude 대화 없음');
    throw new Error('Claude 대화 폴더 조회 실패');
  }
  const matches = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl') || !UUID.test(name.slice(0, -6))) continue;
    const file = path.join(dir, name), st = fs.lstatSync(file);
    if (!st.isFile() || st.mtimeMs < Math.max(now - WEEK, since) || st.mtimeMs > now) continue;
    if (containsMarker(file, `수신 역할: ${start.role};`)) {
      matches.push({id: name.slice(0, -6), path: file, mtime: st.mtimeMs});
    }
  }
  if (matches.length !== 1) throw new Error(matches.length ? 'Claude 일치 대화 둘 이상' : '역할 표시가 있는 Claude 대화 없음');
  return matches[0];
}

export function restoreCommand({start, projectsDir, now = Date.now()}) {
  try {
    if (!start.cwd || !fs.statSync(start.cwd).isDirectory()) throw new Error('작업 폴더 없음');
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw new Error('작업 폴더 없음');
    throw error;
  }
  const parsed = parseRestoreCommand(start.cmd);
  const transcript = !parsed.id ? findClaudeRestore({start, projectsDir, now}) : null;
  const id = parsed.id ?? transcript.id;
  const head = parsed.harness === 'codex' ? ['resume', id] : ['--resume', id];
  const command = serializeWords([parsed.executable, ...head, ...parsed.options]);
  if (!command) throw new Error('복원 명령 직렬화 실패');
  // start의 실행기·모델 표시도 읽을 수 있게 평범한 낱말은 인용 없이 둔다.
  const normalized = commandWords(dedupeResumeCommand(command));
  const readable = normalized.map(word => /^[\w./:@=-]+$/.test(word) ? word : quoteWord(word)).join(' ');
  return {command: readable, ...(transcript ? {transcript} : {})};
}
