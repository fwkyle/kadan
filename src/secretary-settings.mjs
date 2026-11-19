// Why: kyle이 비서의 모델·강도를 다른 역할처럼 실행 모델 설정에서 정한다(2026-11-19). 비서는 start --profile로 띄우지 않고
// 체크포인트(secretary-resume.json)에 저장된 명령으로 같은 대화를 다시 열기 때문에, 설정값은 그 명령을 **실행하려고 만드는 순간**에
// 입힌다. 비서를 다시 여는 세 길(restart 비서·up 복원·로티 탭 복원)이 모두 이 함수 하나를 지난다.
//
// 규칙
// - 바꾸는 것은 모델과 추론 강도 두 값뿐이다. 실행 파일·대화 ID·다른 옵션·순서는 그대로다(codex-option-merge.mjs replaceModelOptions).
// - 활성 프리셋의 비서 자리가 비어 있으면 받은 문자열을 그대로 돌려준다(글자 하나 바꾸지 않는다).
// - 체크포인트 경로가 codex 전용이라 codex 자리 값만 쓴다.
// - 던지지 않는다. 설정을 못 읽거나 값을 쓸 수 없으면 받은 명령 그대로 돌려주고 이유 낱말을 알린다 — 복원이 설정 때문에 막히면
//   1분마다 도는 up --auto가 되살리기 상한과 사람 호출로 번진다.
import {commandWords, launchIdentityOf} from './ai-identity.mjs';
import {replaceModelOptions, serializeWords} from './codex-option-merge.mjs';
import {SECRETARY_ROLE, SECRETARY_RUNNER, findBlocked, isArgvSafeModel, readSettings} from './runner-settings.mjs';

// 원장 start의 modelFromSettingsSkipped 칸에 남는 이유 낱말과 사람이 읽는 풀이.
export const SECRETARY_SKIP_REASONS = {
  'settings-unreadable': '실행 모델 설정 파일을 읽지 못함',
  'slot-invalid': '비서 자리의 실행기·모델·강도 값이 이름 규칙 밖',
  'runner-differs': `비서 자리의 실행기가 ${SECRETARY_RUNNER}가 아님(비서 다시 열기는 ${SECRETARY_RUNNER}만 지원)`,
  'model-blocked': '비서 자리의 모델이 정책으로 막혀 있음',
  'command-shape': `저장된 명령이 ${SECRETARY_RUNNER} resume 꼴이 아니거나 모델·강도 옵션 자리를 하나로 읽지 못함`,
  'quote-failed': '바꾼 명령을 안전하게 인용하지 못함',
  'verify-failed': '바꾼 명령이 설정값으로 다시 읽히지 않음',
  internal: '설정값을 입히다 알 수 없는 오류',
};
export const secretarySkipNote = reason =>
  `비서 실행 모델 설정을 적용하지 못해 저장된 명령 그대로 연다(${SECRETARY_SKIP_REASONS[reason] ?? reason})`;

// 활성 프리셋의 비서 자리를 읽는다. 반환: {slot, settings}(자리가 비었으면 slot null) 또는 {skipped: 이유 낱말}.
function readSlot(home, read) {
  let settings;
  try { settings = read(home); } catch { return {skipped: 'settings-unreadable'}; }
  const slot = settings?.presets?.[settings.activePreset]?.roles?.[SECRETARY_ROLE] ?? null;
  if (!slot) return {slot: null};
  const {runner, model} = slot;
  // 강도 칸이 없거나 빈 글자면 "강도는 바꾸지 않는다"로 읽는다.
  const effort = slot.effort == null || slot.effort === '' ? null : slot.effort;
  if (typeof slot !== 'object' || !isArgvSafeModel(runner) || !isArgvSafeModel(model)
    || (effort !== null && !isArgvSafeModel(effort))) return {skipped: 'slot-invalid'};
  if (runner !== SECRETARY_RUNNER) return {skipped: 'runner-differs'};
  if (findBlocked(settings, SECRETARY_ROLE, model)) return {skipped: 'model-blocked'};
  return {slot: {runner, model, effort}, settings};
}

// command: 인라인 화면 옵션을 붙이기 전의 `codex resume <대화> …` 명령.
// 반환: {command, extra, applied, skipped}
// - command: 실행할 명령. 자리가 비었거나 적용하지 못했거나 값이 이미 같으면 받은 문자열 그대로다.
// - extra: start 원장에 더할 칸. 적용했으면 restart --model-from-settings(#362)와 같은 칸, 못 했으면 modelFromSettingsSkipped.
// - applied: 적용했을 때만 {changed, model, effort, previousModel, previousEffort, revision, preset}.
// - skipped: 적용하지 못한 이유 낱말. 자리가 비어 있는 것은 이유가 아니다(null).
export function secretaryCommandFromSettings({home, command, read = readSettings}) {
  const keep = (skipped = null) =>
    ({command, extra: skipped ? {modelFromSettingsSkipped: skipped} : {}, applied: null, skipped});
  try {
    const {slot, settings, skipped} = readSlot(home, read);
    if (skipped) return keep(skipped);
    if (!slot) return keep();
    const words = commandWords(command);
    const resumeShape = words && words.length >= 3 && words[0].split('/').pop() === SECRETARY_RUNNER && words[1] === 'resume';
    if (!resumeShape) return keep('command-shape');
    const head = words.slice(0, 3);
    const swapped = replaceModelOptions(words.slice(3), slot);
    if (!swapped) return keep('command-shape');
    let next = command;
    if (swapped.changed) {
      next = serializeWords([...head, ...swapped.args]);
      if (!next) return keep('quote-failed');
      // 스스로 확인: 두 값 말고 모든 낱말이 같고, 모델·강도 키가 하나씩 설정값이며, 원장이 읽는 모델도 설정값이다.
      const again = replaceModelOptions(commandWords(next).slice(3), slot);
      const identity = launchIdentityOf(next);
      const sameRest = again && !again.changed && JSON.stringify(again.rest) === JSON.stringify(swapped.rest);
      const sameIdentity = identity.ok && identity.harness === SECRETARY_RUNNER && identity.model === slot.model;
      if (!sameRest || !sameIdentity) return keep('verify-failed');
    }
    const {model, effort} = slot, {previous} = swapped;
    const previousModel = previous.model !== model ? previous.model : null;
    const previousEffort = effort !== null && previous.effort !== effort ? previous.effort : null;
    return {
      command: next, skipped: null,
      extra: {
        modelFromSettings: true, settingsRevision: settings.revision, settingsPreset: settings.activePreset,
        runnerChoice: {runner: slot.runner, model, ...(effort ? {effort} : {})},
        ...(previousModel ? {previousModel} : {}), ...(previousEffort ? {previousEffort} : {}),
      },
      applied: {changed: swapped.changed, model, effort, previousModel: previous.model, previousEffort: previous.effort,
        revision: settings.revision, preset: settings.activePreset},
    };
  } catch { return keep('internal'); }
}

// 설정 화면·runners show의 '무엇이 일어나는가' 한 줄. 자리가 비어 있으면 null이다.
export function secretaryCommandLabel(value) {
  if (!value) return null;
  if (value.runner !== SECRETARY_RUNNER) return `적용 안 됨 — 비서 다시 열기는 ${SECRETARY_RUNNER}만 지원한다(지금 값: ${value.runner})`;
  const effort = value.effort ? ` -c model_reasoning_effort="${value.effort}"` : '';
  return `비서를 다시 열 때(restart·up 복원·로티 탭 복원) 저장된 명령의 모델·강도만 바꾼다: --model ${value.model}${effort}`;
}

// 적용하지 못했을 때 사람이 볼 한 줄을 표준 오류에 낸다(호출자가 다른 출력 길을 주지 않았을 때의 기본).
export const warnSecretarySkip = result => { if (result.skipped) console.error(secretarySkipNote(result.skipped)); };
