// Why: agy 신뢰 창 판정의 근거를 손으로 지어낸 꼴이 아니라 실제 화면으로 둔다.
// 출처: 2026-11-26 실제 agy 세션의 출력 기록 앞부분을 격리 tmux pane에 재생해 `capture-pane -p -J`로 읽은 원문.
// 재생 폭은 그 화면을 그릴 때의 폭(커서 열로 확인한 80·120·152)에 맞췄다. 바꾼 것은 작업 폴더 경로의 글뿐이다.
// TRUNCATED_80만 2026-09-29 기록에서 같은 방법으로 얻었다.

// 폭 80, 상태 글이 'auto ·' 없이 그려진 첫 화면
export const HALF_80 = workdir => [
  "Accessing workspace:",
  "",
  workdir,
  "",
  "Do you trust the contents of this project?",
  "",
  "Antigravity CLI requires permission to read, edit, and execute files here.",
  "",
  "> Yes, I trust this folder",
  "  No, exit",
  "",
  "  ↑/↓ Navigate · enter Confirm",
  "                                                            Gemini 4 Neon · high",
  ...Array(27).fill(''),
].join('\n');

// 폭 120, 다시 그리는 중('auto ·' 덧그리기 전)
export const HALF_120 = workdir => [
  "Accessing workspace:",
  "",
  workdir,
  "",
  "Do you trust the contents of this project?",
  "",
  "Antigravity CLI requires permission to read, edit, and execute files here.",
  "",
  "> Yes, I trust this folder",
  "  No, exit",
  "",
  "  ↑/↓ Navigate · enter Confirm",
  "                                                                                                    Gemini 4 Neon · high",
  ...Array(27).fill(''),
].join('\n');

// 폭 120, 'auto ·'까지 그려진 화면
export const FULL_120 = workdir => [
  "Accessing workspace:",
  "",
  workdir,
  "",
  "Do you trust the contents of this project?",
  "",
  "Antigravity CLI requires permission to read, edit, and execute files here.",
  "",
  "> Yes, I trust this folder",
  "  No, exit",
  "",
  "  ↑/↓ Navigate · enter Confirm",
  "                                                                                             auto · Gemini 4 Neon · high",
  ...Array(27).fill(''),
].join('\n');

// 폭 152, 다 그려진 화면
export const FULL_152 = workdir => [
  "Accessing workspace:",
  "",
  workdir,
  "",
  "Do you trust the contents of this project?",
  "",
  "Antigravity CLI requires permission to read, edit, and execute files here.",
  "",
  "> Yes, I trust this folder",
  "  No, exit",
  "",
  "  ↑/↓ Navigate · enter Confirm",
  "                                                                                                                             auto · Gemini 4 Neon · high",
  ...Array(27).fill(''),
].join('\n');

// 2026-09-29 구버전 agy 기록, 폭 80: 강도 끝 글자가 잘린 'mediu'. 긴 경로를 agy가 두 줄로 나눠 그렸다(경로 두 줄의 글만 바꿨다).
export const TRUNCATED_80 = (head, rest) => [
  "Accessing workspace:",
  "",
  head,
  rest,
  "",
  "Do you trust the contents of this project?",
  "",
  "Antigravity CLI requires permission to read, edit, and execute files here.",
  "",
  "> Yes, I trust this folder",
  "  No, exit",
  "",
  "  ↑/↓ Navigate · enter Confirm",
  "                                                       Gemini 3.8 Flash · mediu",
  ...Array(26).fill(''),
].join('\n');

// 창이 닫힌 뒤 빈 입력창의 마지막 네 줄
export const INPUT_TAIL = [
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "? for shortcuts                                                                                                              auto · Gemini 4 Neon · high",
].join('\n');

// 답을 쓰는 중 화면의 마지막 네 줄
export const ANSWERING_TAIL = [
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  ">",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "esc to cancel                                                                                                                auto · Gemini 4 Neon · high",
].join('\n');
