// `kadan help`가 보여 주는 명령 설명의 유일한 원본이다.
// 짧은 목록(SHORT_LIST)·묶음 목록(GROUPS)·README 짧은 목록 표·시험이 모두 여기서 읽는다.
// 설명 문장은 docs/commands.md에 복사하지 않는다. 그쪽과는 명령 이름만 시험으로 맞춘다.

export const ATTACH_NOTE = "기본 설정에서는 `kadan up`이 출력한 tmux 명령으로 비서에 접속하세요. 창을 설정했다면 `kadan attach 비서`로 엽니다.";

export const INTRO = "카단 — 여러 AI 도구를 역할별로 띄워 함께 일하기";

// 처음 쓰는 사람이 꼭 필요한 9개. 위에서 아래가 쓰는 순서다.
export const SHORT_LIST = [
  ["kadan init", "처음 한 번, 환경 확인하고 준비하기"],
  ["kadan up", "비서·대시보드 켜기 (매일)"],
  ["kadan attach 비서", "비서 창 열기 (창 설정 시)"],
  ["kadan adopt <이름> --model <모델>", "지금 하던 대화를 감독으로 이어 열기"],
  ["kadan status", "지금 켜진 역할 보기"],
  ["kadan mail <역할> <말>", "역할에게 메시지 보내기"],
  ["kadan stop <역할>", "역할 끝내기"],
  ["kadan doctor", "막힌 곳 한 번에 점검하기"],
  ["kadan help --all", "전체 명령 목록 보기"],
];

// help --all의 묶음. 최상위 명령 이름 하나가 한 줄이다.
export const GROUPS = [
  ["처음 준비", [
    ["init", "처음 한 번, 환경 확인하고 준비하기"],
    ["up", "비서·대시보드 켜기 (매일)"],
    ["doctor", "막힌 곳 한 번에 점검하기 (읽기 전용)"],
    ["autostart", "로그인할 때 자동으로 켜기 (macOS)"],
    ["help", "명령 목록 보기 (--all은 전체)"],
  ]],
  ["역할 다루기", [
    ["start", "역할 세션 만들기"],
    ["adopt", "하던 AI 대화를 감독으로 이어 열기"],
    ["attach", "역할 창 열기 (창 설정 시)"],
    ["read", "역할 화면 끝부분 읽기"],
    ["wait", "완료나 조용함 기다리기"],
    ["done", "확인한 완료를 원장에 적기"],
    ["restore", "끊어진 로티 탭 다시 붙이기"],
    ["restart", "역할 프로그램만 다시 띄우기"],
    ["stop", "역할 끝내기"],
    ["handover", "맡은 일을 후임에게 넘기기"],
    ["hierarchy", "끝난 역할의 관계 정리하기"],
  ]],
  ["판과 현황", [
    ["status", "지금 켜진 역할 보기"],
    ["tree", "판·카드·역할 요약 보기 (JSON)"],
    ["log", "원장 최근 기록 보기"],
    ["wall", "관제 화면 열기 (대시보드)"],
    ["plan", "판을 열고 카드 목록 적기"],
  ]],
  ["감시", [
    ["watch", "멈춤·끊김을 감독에게 알리기"],
    ["watch-report", "감시 AI의 판정 받기"],
  ]],
  ["업무와 결정", [
    ["work", "결과 중심 업무 한 장 다루기"],
    ["card", "중앙 카드 다루기"],
    ["dispatch", "카드를 역할에게 발령하기"],
    ["decision", "사람의 결정 요청하기"],
    ["night", "자는 동안 위임 켜고 끄기"],
    ["senior", "시니어에게 결정 자문 받기"],
    ["slot", "검수용 작업 폴더 빌려 쓰기"],
  ]],
  ["우편", [
    ["mail", "역할에게 메시지 보내기"],
    ["inbox", "받은·보낸 우편 보기"],
  ]],
  ["설정", [
    ["runners", "역할별 AI와 모델 정하기"],
    ["window", "터미널 창 방식 정하기"],
    ["notify", "알림 보낼 곳 정하기"],
    ["secrets", "비밀 파일 위치 정하기"],
    ["discord", "디스코드 글 주고받기"],
    ["stop-hook", "AI 종료 알림 연결하기"],
  ]],
  ["자원과 저장", [
    ["limit", "무거운 명령 동시 개수 제한하기"],
    ["storage", "원장 저장소 점검·전환하기"],
  ]],
  ["복구", [
    ["recovery", "재부팅 뒤 역할과 AI 대화 다시 맞추기"],
  ]],
];

// 다른 이름이나 옛 이름. COMMANDS 키가 GROUPS 줄이나 여기 중 정확히 한 곳에 있어야 한다.
export const ALIASES = [
  ["advise", "senior", "옛 이름"],
  ["dashboard", "wall", "다른 이름"],
  ["send", "mail·dispatch", "옛 호출 호환"],
];

// 터미널 칸 수. 한글·전각은 2칸으로 센다.
export function displayWidth(text) {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const wide = (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

const pad = (text, width) => text + " ".repeat(Math.max(0, width - displayWidth(text)));

function table(rows, indent = "  ") {
  const width = Math.max(...rows.map(([name]) => displayWidth(name)));
  return rows.map(([name, text]) => `${indent}${pad(name, width + 3)}${text}`);
}

export function formatShortHelp() {
  return [
    INTRO,
    "",
    ...table(SHORT_LIST),
    "",
    ATTACH_NOTE,
    "",
    "전체: `kadan help --all` · 명령어 사전: docs/commands.md",
  ].join("\n");
}

export function formatFullHelp() {
  const width = Math.max(...GROUPS.flatMap(([, rows]) => rows.map(([name]) => displayWidth(`kadan ${name}`))));
  const lines = [INTRO, ""];
  for (const [title, rows] of GROUPS) {
    lines.push(title);
    for (const [name, text] of rows) lines.push(`  ${pad(`kadan ${name}`, width + 3)}${text}`);
    lines.push("");
  }
  lines.push("다른 이름");
  for (const [name, target, note] of ALIASES) lines.push(`  ${pad(`kadan ${name}`, width + 3)}${target}의 ${note}`);
  lines.push("", "옵션은 `kadan <명령> --help`나 명령어 사전(docs/commands.md)에 있습니다.");
  return lines.join("\n");
}

// COMMANDS 키 전부가 묶음 줄이나 별칭 목록 중 정확히 한 곳에 있는지 본다. 어긋난 이름을 문장으로 돌려준다(시험이 쓴다).
export function coverageProblems(keys, groups = GROUPS, aliases = ALIASES) {
  const places = new Map();
  const put = (name, place) => places.set(name, [...(places.get(name) ?? []), place]);
  for (const [title, rows] of groups) for (const [name] of rows) put(name, title);
  for (const [name] of aliases) put(name, "다른 이름");
  const problems = [];
  for (const key of keys) {
    const found = places.get(key) ?? [];
    if (found.length === 0) problems.push(`${key}: help --all에 없다`);
    if (found.length > 1) problems.push(`${key}: ${found.length}곳에 있다 (${found.join(", ")})`);
  }
  for (const name of places.keys()) if (!keys.includes(name)) problems.push(`${name}: COMMANDS에 없는 이름이다`);
  return problems;
}
