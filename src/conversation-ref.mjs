// Why: 같은 대화를 다시 여는 start(resume)와 새 대화를 여는 start(new·fork)를 가르려면 명령에서 대화 정보를 읽어야 한다.
// harness·model을 cmd에서 읽는 것(cli-start-support.mjs describeStartCmd)과 같은 일반 파싱이다. 실행기 어댑터나 대화 파일 읽기는 없고,
// 판단할 수 없는 명령은 new다. 문법은 adopt.mjs adoptCommand가 만드는 형태(claude --resume <id> --fork-session, codex fork <id>)를 따른다.
const quoteless = value => String(value).replace(/^["']+|["']+$/g, '');

export function conversationOf(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return {conversationMode: 'new'};
  const tokens = cmd.trim().split(/\s+/);
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
  const harness = tokens[index]?.split('/').pop(), rest = tokens.slice(index + 1);
  if (harness === 'claude') {
    let ref = null;
    rest.forEach((token, i) => {
      const inline = token.match(/^(?:--resume|-r)=(.+)$/);
      if (inline) ref = quoteless(inline[1]);
      else if ((token === '--resume' || token === '-r') && rest[i + 1] && !rest[i + 1].startsWith('-')) ref = quoteless(rest[i + 1]);
    });
    if (!ref) return {conversationMode: 'new'};
    return {conversationMode: rest.includes('--fork-session') ? 'fork' : 'resume', conversationRef: ref};
  }
  if (harness === 'codex') {
    // 첫 하위 명령만 본다. 옵션(-c 값 등) 뒤에 우연히 나온 낱말은 보지 않는다.
    const sub = rest.findIndex(token => !token.startsWith('-'));
    const mode = rest[sub];
    const ref = rest[sub + 1];
    if ((mode === 'resume' || mode === 'fork') && ref && !ref.startsWith('-')) return {conversationMode: mode, conversationRef: quoteless(ref)};
  }
  return {conversationMode: 'new'};
}
