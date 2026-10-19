// Why: 입력칸의 흐린 추천 문구(claude `Try "…"`, codex `Ask Codex to do anything`)는 `capture-pane -p`(색 없음)로 보면
// 사람이 친 글과 같아 보인다. -e로 한 번만 떠서 입력칸 줄의 흐린 구간만 골라낸다(2026-10-19 격리 실측: 추천 문구만 `ESC[2m`,
// 친 글·빈 칸은 흐림 없음). 판정용은 흐린 구간을 뺀 글자, 표시용은 `(추천 문구: …)`로 바꾼 글자다.
const CSI = /\x1b\[([0-9;?]*)([ -/]*[@-~])/y;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;
const INPUT_LINE = /^\s*[❯›>]/u;

// SGR 파라미터를 순서대로 읽어 흐림 상태를 갱신한다. 38/48;5;n·38/48;2;r;g;b의 뒷 숫자는 건너뛴다.
function nextDim(dim, params) {
  const list = params === "" ? [0] : params.split(";").map(part => (part === "" ? 0 : Number(part)));
  for (let i = 0; i < list.length; i += 1) {
    const code = list[i];
    if (code === 38 || code === 48) i += list[i + 1] === 5 ? 2 : list[i + 1] === 2 ? 4 : 0;
    else if (code === 0 || code === 22) dim = false;
    else if (code === 2) dim = true;
  }
  return dim;
}

// 한 줄을 [{text, dim}] 글자 조각으로 나눈다. OSC(하이퍼링크 등)와 흐림 아닌 SGR은 글자에 넣지 않는다.
function cells(line, state) {
  const out = [];
  for (let i = 0; i < line.length;) {
    if (line[i] === "\x1b") {
      CSI.lastIndex = i;
      const csi = CSI.exec(line);
      if (csi) {
        if (csi[2] === "m") state.dim = nextDim(state.dim, csi[1]);
        i += csi[0].length;
        continue;
      }
      OSC.lastIndex = i;
      const osc = OSC.exec(line);
      i += osc ? osc[0].length : 1;
      continue;
    }
    const char = String.fromCodePoint(line.codePointAt(i));
    out.push({ char, dim: state.dim });
    i += char.length;
  }
  return out;
}

const plain = row => row.map(cell => cell.char).join("");

// -e로 뜬 화면 하나에서 { judge, view }를 낸다. 입력칸 줄(마지막 ❯·›·> 줄)의 흐린 구간만 다르다.
// 나머지 줄은 색만 벗겨 `-p`와 같은 글자다. tmux -p처럼 줄 끝 공백(U+0020)만 지운다.
export function splitGhostText(ansiScreen) {
  const state = { dim: false };
  const rows = ansiScreen.split("\n").map(line => cells(line, state));
  const judge = rows.map(plain);
  let index = -1;
  for (let i = judge.length - 1; i >= 0; i -= 1) {
    if (INPUT_LINE.test(judge[i])) { index = i; break; }
  }
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
