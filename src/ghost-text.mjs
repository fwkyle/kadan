// Why: 입력칸의 흐린 추천 문구(claude `Try "…"`, codex `Ask Codex to do anything`)는 `capture-pane -p`(색 없음)로 보면
// 사람이 친 글과 같아 보인다. -e로 한 번만 떠서 입력칸 줄의 흐린 구간만 골라낸다(2026-10-19 격리 실측: 추천 문구만 `ESC[2m`,
// 친 글·빈 칸은 흐림 없음). 판정용은 흐린 구간을 뺀 글자, 표시용은 `(추천 문구: …)`로 바꾼 글자다.
const CSI = /\x1b\[([0-?]*)([ -/]*)([@-~])/y;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;
const CONTROL_STRING = /\x1b[PX^_][\s\S]*?\x1b\\/y;
const ESCAPE = /\x1b[ -/]*[0-~]/y;
const INPUT_LINE = /^\s*[❯›>]/u;
const RULE = /^\s*─{3,}\s*$/u;
const CLAUDE_STATUS = /^\s+(?:Haiku|Sonnet|Opus) \S+ \| effort:\w+(?: \| .*)?$/u;
const CLAUDE_FOOTER = /^\s+(?:(?:~\/|\/).+|⏵⏵ .+|Advisor Tool \(experimental\).+|Ctrl\+Y to paste deleted text)$/u;
const CODEX_STATUS = /^\s+\S+ (?:none|minimal|low|medium|high|xhigh|max|default) · (?:~\/|\/).+$/u;
const CODEX_SHORTCUTS = /^\s+(?:← for agents · )?\? for shortcuts(?:\s+⚠ .+)?$/u;

// 색(38/48/58)의 채널과 콜론 하위 매개변수는 독립 SGR 2(흐림)가 아니다.
function updateDim(state, params) {
  if (!/^[\d;:]*$/u.test(params)) { state.uncertain = true; return; }
  const list = params.split(";");
  for (let i = 0; i < list.length; i += 1) {
    const parts = list[i].split(":");
    const code = Number(parts[0]);
    if ([38, 48, 58].includes(code)) {
      if (parts.length > 1) {
        const valid = (parts[1] === "5" && parts.length === 3) ||
          (parts[1] === "2" && [5, 6].includes(parts.length));
        if (!valid) state.uncertain = true;
        continue;
      }
      const count = list[i + 1] === "5" ? 2 : list[i + 1] === "2" ? 4 : 0;
      if (!count || i + count >= list.length) { state.uncertain = true; return; }
      i += count;
    } else if ([0, 2, 22].includes(code)) {
      if (parts.length > 1) state.uncertain = true;
      else state.dim = code === 2;
    }
  }
}

// 한 줄을 [{text, dim}] 글자 조각으로 나눈다. OSC(하이퍼링크 등)와 흐림 아닌 SGR은 글자에 넣지 않는다.
function cells(line, state) {
  const out = [];
  for (let i = 0; i < line.length;) {
    if (line[i] === "\x1b") {
      CSI.lastIndex = i;
      const csi = CSI.exec(line);
      if (csi) {
        if (csi[2] === "" && csi[3] === "m") updateDim(state, csi[1]);
        else state.uncertain = true;
        i += csi[0].length;
        continue;
      }
      OSC.lastIndex = i;
      const osc = OSC.exec(line);
      if (osc) { i += osc[0].length; continue; }
      // 알 수 없는 제어 순서가 있으면 그 화면에서 추천을 지우지 않는다.
      // 순서 자체는 글자로 새지 않게 벗기고, 본문 글자는 남긴다.
      state.uncertain = true;
      CONTROL_STRING.lastIndex = i;
      ESCAPE.lastIndex = i;
      const control = CONTROL_STRING.exec(line);
      if (!control && /[\[\]PX^_]/u.test(line[i + 1] ?? "")) break;
      const escape = control ?? ESCAPE.exec(line);
      i += escape ? escape[0].length : 1;
      continue;
    }
    // tmux -e는 대체 문자 집합을 SO/SI로 감싼다. -p에는 이 바이트가 없다.
    if (line[i] === "\x0e" || line[i] === "\x0f") { i++; continue; }
    const char = String.fromCodePoint(line.codePointAt(i));
    out.push({ char, dim: state.dim });
    i += char.length;
  }
  return out;
}

const plain = row => row.map(cell => cell.char).join("");

// 실측 claude: 두 가로줄 사이 ❯ + 상태 바닥글. codex: › + 상태/단축키 바닥글(#180).
// 마지막 기호가 이 모양이 아니면 앞선 본문에서 다른 후보를 찾지 않고 보존한다.
function composerIndex(lines) {
  const index = lines.findLastIndex(line => INPUT_LINE.test(line));
  if (index < 0) return -1;
  const footer = lines.slice(index + 1).filter(line => line.trim() !== "");
  if (/^\s*❯/u.test(lines[index]) && RULE.test(lines[index - 1] ?? "") &&
      RULE.test(lines[index + 1] ?? "")) {
    const below = footer.slice(1);
    if (below.length <= 5 && below.some(line => CLAUDE_STATUS.test(line)) &&
        below.every(line => CLAUDE_STATUS.test(line) || CLAUDE_FOOTER.test(line))) return index;
  }
  if (/^\s*›/u.test(lines[index]) && lines[index + 1]?.trim() === "" &&
      CODEX_STATUS.test(footer[0] ?? "") &&
      (footer.length === 1 || (footer.length === 2 && CODEX_SHORTCUTS.test(footer[1])))) return index;
  return -1;
}

// -e로 뜬 화면 하나에서 { judge, view }를 낸다. 확인된 입력칸 한 줄의 흐린 구간만 다르다.
// 나머지 줄은 색만 벗겨 `-p`와 같은 글자다. tmux -p처럼 줄 끝 공백(U+0020)만 지운다.
export function splitGhostText(ansiScreen) {
  const state = { dim: false, uncertain: false };
  const rows = ansiScreen.split("\n").map(line => cells(line, state));
  const judge = rows.map(row => plain(row).replace(/ +$/u, ""));
  const index = state.uncertain ? -1 : composerIndex(judge);
  const view = judge.slice();
  if (index < 0) return { judge: judge.join("\n"), view: view.join("\n"), ghost: "" };
  const row = rows[index];
  // 입력 기호·앞 공백은 흐려도 보존한다. 낱말 사이 정상 공백만 같은 추천 구간에 포함한다.
  const prefix = [...judge[index].match(/^\s*[❯›>]\s*/u)[0]].length;
  const ghosts = [];
  let judged = plain(row.slice(0, prefix));
  let shown = judged;
  for (let i = prefix; i < row.length;) {
    if (!row[i].dim) {
      judged += row[i].char;
      shown += row[i++].char;
      continue;
    }
    const start = i;
    let end = i;
    while (i < row.length && (row[i].dim || /\s/u.test(row[i].char))) {
      if (row[i].dim) end = i + 1;
      i++;
    }
    const ghost = plain(row.slice(start, end)).trim();
    if (ghost) {
      ghosts.push(ghost);
      shown += `(추천 문구: ${ghost})`;
    } else {
      judged += plain(row.slice(start, end));
      shown += plain(row.slice(start, end));
    }
    i = end;
  }
  if (ghosts.length) {
    judge[index] = judged.replace(/ +$/u, "");
    view[index] = shown.replace(/ +$/u, "");
  }
  return { judge: judge.join("\n"), view: view.join("\n"), ghost: ghosts.join(" ") };
}
