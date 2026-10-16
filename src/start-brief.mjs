// Why: `kadan start <역할> --profile <p>`로 세운 역할이 첫 우편·발령 전까지 자기가 누구인지 모르는 빈 AI로 기다렸다(2026-10-15 실측).
// 새로 만든 AI 세션에만, 화면이 안정된 뒤 프로필 지침이 붙은 첫 안내를 내부 send로 한 번 보낸다.
// 지침·참고 파일은 send가 붙이는 receiver-instructions(role-instructions.mjs)가 맡고, 여기 본문은 짧은 두 문장이다.
import { normalizeAiCommand, AI_HARNESS_NAMES } from "./ai-identity.mjs";
import { startConversationCertainty } from "./conversation-ref.mjs";
import { waitForSettled } from "./quickstart.mjs";

// kadan up이 비서에게 쓰던 본문 그대로다(quickstart.mjs에서 옮김).
export const SECRETARY_BRIEF = "당신은 카단 비서입니다. 설치된 kadan-secretary 스킬을 읽고(/kadan-secretary), kadan status와 kadan tree로 현재 판을 확인한 뒤, 사용자에게 지금 무엇을 도울지 한 문장으로 물어보고 기다리세요. 사용자가 시키기 전에는 아무것도 발송하지 마세요.";

const SKILL_OF = { super: "kadan-super", conductor: "kadan-conductor", secretary: "kadan-secretary" };
const NAME_OF = { super: "슈퍼감독", conductor: "감독", worker: "작업자", reviewer: "검수자" };

export function briefSkill(profile) { return SKILL_OF[profile] ?? null; }

export function briefMessage({ role, profile }) {
  if (profile === "secretary") return SECRETARY_BRIEF;
  const skill = SKILL_OF[profile];
  if (skill) {
    return `당신은 카단 ${NAME_OF[profile]} \`${role}\`(${profile})입니다. 설치된 ${skill} 스킬을 읽고(/${skill}) kadan status와 kadan tree로 지금 판을 확인한 뒤, 우편이나 발령이 올 때까지 기다리세요. 사용자나 우편이 시키기 전에는 아무것도 발송하지 마세요.`;
  }
  return `당신은 카단 ${NAME_OF[profile] ?? profile} \`${role}\`(${profile})입니다. 이어서 받는 안내의 카드 계약(card-template)을 따르고, 발령이 올 때까지 기다리세요. 발령 전에는 아무것도 시작하거나 발송하지 마세요.`;
}

// 실행 명령이 AI 실행기인가: 정규화(env 앞붙임·경로·kadan-<실행기> 래퍼 제거) 뒤 실행기 이름이 등록 실행기다.
// --cmd sh·카단 도구 명령·셸 연산이 섞인 명령은 아니다 — 그러지 않으면 기존 시험마다 셸에 안내문이 붙는다.
export function isAiRunnerCommand(cmd, { known = AI_HARNESS_NAMES } = {}) {
  const normalized = normalizeAiCommand(cmd);
  return Boolean(normalized && known.has(normalized.harness));
}

// 보낼지 말지의 네 조건 + 이어 열기 제외. 이유를 돌려줘 시험과 출력이 같은 판단을 쓴다.
export function briefSkipReason({ reusing, roleProfile, noPrompt, cmd, known }) {
  if (reusing) return "reusing";
  if (!roleProfile) return "no-profile";
  if (noPrompt) return "no-prompt";
  if (!isAiRunnerCommand(cmd, known ? { known } : undefined)) return "not-ai-runner";
  // 같은 대화를 resume으로 다시 연 세션은 이미 안내를 받았다. 새 대화로 확실한 것(new·fork)만 안내하고,
  // 모르는 옵션·하위 명령이 섞여 판단할 수 없으면 보내지 않는다(기준: conversation-ref.mjs startConversationCertainty).
  const certainty = startConversationCertainty(cmd);
  if (certainty === "resume") return "resume";
  if (certainty === "unknown") return "resume-unknown";
  return null;
}

// 새로 만든 세션에 첫 안내를 보낸다. 실패해도 던지지 않는다(start는 성공으로 끝난다, 세션도 닫지 않는다).
// 반환: 'sent' | 'not-ready' | 'failed' | 'skipped:<이유>'. tries·intervalMs·sleep은 시험에서 주입한다.
export function briefStartedRole({ role, session, roleProfile, noPrompt, cmd, reusing, floor, send,
  tries, intervalMs, sleep, known, isCurrent, log = console.log, warn = console.error } = {}) {
  const skip = briefSkipReason({ reusing, roleProfile, noPrompt, cmd, known });
  if (skip) return `skipped:${skip}`;
  const skill = briefSkill(roleProfile);
  const hint = skill ? `창에서 직접 /${skill}` : "발령이 오면 그대로 진행";
  const settled = waitForSettled({ read: () => floor.read(session),
    ...(tries ? { tries } : {}), ...(intervalMs ? { intervalMs } : {}), ...(sleep ? { sleep } : {}) });
  if (!settled) { warn(`첫 안내 못 보냄(화면이 아직 준비되지 않음) — ${hint}`); return "not-ready"; }
  // 화면을 기다리는 동안 이 세대가 닫히고 다른 세대로 바뀌었을 수 있다. 대기 전에 고정한 세대와 같다고 확인될 때만 보낸다.
  // 조회가 던지거나 값을 못 얻으면 건너뛴다. start는 이미 성공했으므로 확인 실패가 start를 실패시키지 않는다.
  if (isCurrent) {
    let current;
    try { current = isCurrent(); } catch { current = undefined; }
    if (current === false) { warn("첫 안내 건너뜀 — 세대가 바뀜"); return "skipped:generation-changed"; }
    if (current !== true) { warn("첫 안내 건너뜀 — 세대 확인 실패"); return "skipped:generation-unknown"; }
  }
  try {
    const receipt = send({ role, session, message: briefMessage({ role, profile: roleProfile }), roleProfile });
    log(`첫 안내 전송됨: ${session} (${receipt.bytes}B, 우편ID ${receipt.mailId}) — 입력 접수·AI 실행 미확인`);
    return "sent";
  } catch (error) {
    warn(`첫 안내 못 보냄(${error.message}) — ${hint}`);
    return "failed";
  }
}
