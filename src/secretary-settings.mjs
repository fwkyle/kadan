// Why: kyle이 비서의 모델·강도를 다른 역할처럼 실행 모델 설정에서 정한다(2026-11-19). 비서는 start --profile로 띄우지 않고
// 체크포인트(secretary-resume.json)에 저장된 명령으로 같은 대화를 다시 열기 때문에, 설정값은 그 명령을 **실행하려고 만드는 순간**에
// 입힌다. 비서를 다시 여는 세 길(restart 비서·up 복원·로티 탭 복원)이 모두 이 함수 하나를 지난다.
//
// 규칙
// - 바꾸는 것은 모델과 추론 강도 두 값뿐이다. 실행 파일·대화 ID·다른 옵션·순서는 그대로다(codex-option-merge.mjs replaceModelOptions).
// - 활성 프리셋의 비서 자리가 비어 있으면 받은 문자열을 그대로 돌려준다(글자 하나 바꾸지 않는다).
// - 체크포인트 경로가 codex 전용이라 codex 자리 값만 쓴다.
// - 자리 값은 저장 단계와 같은 판정(runner-settings.mjs checkChoice: 모델이 목록에 있고 그 강도를 지원하는가)을 지나야 쓴다.
//   저장 뒤에 모델 목록이 바뀌었거나 파일을 손으로 고친 값이 실행 명령에 들어가 비서가 뜨지 못하는 일을 막는다.
// - 던지지 않는다. 설정을 못 읽거나 값을 쓸 수 없으면 받은 명령 그대로 돌려주고 이유 낱말을 알린다 — 복원이 설정 때문에 막히면
//   1분마다 도는 up --auto가 되살리기 상한과 사람 호출로 번진다.
import fs from 'node:fs';
import {commandWords, launchIdentityOf} from './ai-identity.mjs';
import {replaceModelOptions, serializeWords} from './codex-option-merge.mjs';
import {
  SECRETARY_ROLE, SECRETARY_RUNNER, checkChoice, codexModelsCachePath, findBlocked, isArgvSafeModel, readSettings, runnerChoices,
} from './runner-settings.mjs';

// 원장 start의 modelFromSettingsSkipped 칸에 남는 이유 낱말과 사람이 읽는 풀이.
export const SECRETARY_SKIP_REASONS = {
  'settings-unreadable': '실행 모델 설정 파일을 읽지 못함',
  'slot-invalid': '비서 자리의 실행기·모델·강도 값이 이름 규칙 밖',
  'runner-differs': `비서 자리의 실행기가 ${SECRETARY_RUNNER}가 아님(비서 다시 열기는 ${SECRETARY_RUNNER}만 지원)`,
  'model-blocked': '비서 자리의 모델이 정책으로 막혀 있음',
  'catalog-unreadable': '비서 자리 실행기의 모델 목록을 읽지 못해 값을 확인할 수 없음',
  'choice-rejected': '비서 자리의 모델이 목록에 없거나 그 모델이 지원하지 않는 강도',
  'command-shape': `저장된 명령이 ${SECRETARY_RUNNER} resume 꼴이 아니거나 모델·강도 옵션 자리를 하나로 읽지 못함`,
  'quote-failed': '바꾼 명령을 안전하게 인용하지 못함',
  'verify-failed': '바꾼 명령이 설정값으로 다시 읽히지 않음',
  internal: '설정값을 입히다 알 수 없는 오류',
};
export const secretarySkipNote = reason =>
  `비서 실행 모델 설정을 적용하지 못해 저장된 명령 그대로 연다(${SECRETARY_SKIP_REASONS[reason] ?? reason})`;

// 활성 프리셋의 비서 자리를 읽는다. 반환: {slot, revision, preset}(자리가 비었으면 slot null) 또는 {skipped: 이유 낱말}.
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
  // 저장 단계(setRole)와 같은 판정을 쓴다. 판정에 쓰는 모델 목록 파일은 한 번만 읽는다.
  // 목록을 읽지 못하면(파일 없음·깨짐, 실행기 미등록) 확인하지 못한 값이라 쓰지 않는다 — 저장된 명령은 직전에 실제로 뜬 명령이다.
  let cache;
  const options = {readCodexModels: () => cache ??= JSON.parse(fs.readFileSync(codexModelsCachePath(), 'utf8'))};
  try { runnerChoices(settings, runner, options); } catch { return {skipped: 'catalog-unreadable'}; }
  try { checkChoice(settings, SECRETARY_ROLE, {runner, model, ...(effort === null ? {} : {effort})}, options); }
  catch { return {skipped: 'choice-rejected'}; }
  return {slot: {runner, model, effort}, revision: settings.revision, preset: settings.activePreset};
}

// command: 인라인 화면 옵션을 붙이기 전의 `codex resume <대화> …` 명령.
// fresh: true면 새 비서의 첫 시작 명령(`codex` 또는 `codex <옵션…>`)을 받는다. resume 꼴을 요구하지 않고 실행 파일 낱말 하나 뒤에
//   두 값만 바꾼다(quickstart.mjs runUp의 startNew). 나머지 규칙은 그대로다. 주지 않으면 지금까지와 같다.
// pinned: 앞선 호출이 돌려준 pinned(확인을 마친 자리 값과 설정 버전). 주면 설정을 다시 읽지 않고 그 값을 그대로 입힌다.
//   restart 비서 --model-from-settings가 끄기 전에 확인한 값을 끈 뒤에도 그대로 쓰려고 넘긴다.
// 반환: {command, extra, applied, skipped, pinned}
// - command: 실행할 명령. 자리가 비었거나 적용하지 못했거나 값이 이미 같으면 받은 문자열 그대로다.
// - extra: start 원장에 더할 칸. 적용했으면 restart --model-from-settings(#362)와 같은 칸, 못 했으면 modelFromSettingsSkipped.
// - applied: 적용했을 때만 {changed, model, effort, previousModel, previousEffort, revision, preset}.
// - skipped: 적용하지 못한 이유 낱말. 자리가 비어 있는 것은 이유가 아니다(null).
// - pinned: 적용했을 때만 {slot, revision, preset}. 다음 호출의 pinned로 넘길 수 있다.
export function secretaryCommandFromSettings({home, command, read = readSettings, pinned = null, fresh = false}) {
  const keep = (skipped = null) =>
    ({command, extra: skipped ? {modelFromSettingsSkipped: skipped} : {}, applied: null, skipped, pinned: null});
  try {
    const {slot, revision, preset, skipped} = pinned ?? readSlot(home, read);
    if (skipped) return keep(skipped);
    if (!slot) return keep();
    const words = commandWords(command);
    const keepWords = fresh ? 1 : 3;
    const shape = words && words.length >= keepWords && words[0].split('/').pop() === SECRETARY_RUNNER
      && (fresh || words[1] === 'resume');
    if (!shape) return keep('command-shape');
    const head = words.slice(0, keepWords);
    const swapped = replaceModelOptions(words.slice(keepWords), slot);
    if (!swapped) return keep('command-shape');
    let next = command;
    if (swapped.changed) {
      next = serializeWords([...head, ...swapped.args]);
      if (!next) return keep('quote-failed');
      // 스스로 확인: 두 값 말고 모든 낱말이 같고, 모델·강도 키가 하나씩 설정값이며, 원장이 읽는 모델도 설정값이다.
      const again = replaceModelOptions(commandWords(next).slice(keepWords), slot);
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
        modelFromSettings: true, settingsRevision: revision, settingsPreset: preset,
        runnerChoice: {runner: slot.runner, model, ...(effort ? {effort} : {})},
        ...(previousModel ? {previousModel} : {}), ...(previousEffort ? {previousEffort} : {}),
      },
      applied: {changed: swapped.changed, model, effort, previousModel: previous.model, previousEffort: previous.effort,
        revision, preset},
      pinned: {slot, revision, preset},
    };
  } catch { return keep('internal'); }
}

// 새 비서의 첫 시작(quickstart.mjs runUp의 secretarySettings 자리)에 넣는 함수. 결과에 사람이 읽을 한 줄(note)을 더한다.
// 새 비서의 첫 시작 경고에 쓰는 풀이. 복원 전용 설명(저장된 명령·resume 꼴·다시 열기)이 든 두 낱말만 첫 시작에 맞게 바꾼다.
export const SECRETARY_FRESH_SKIP_REASONS = {
  ...SECRETARY_SKIP_REASONS,
  'runner-differs': `비서 자리의 실행기가 ${SECRETARY_RUNNER}가 아님(새 비서의 설정값 적용은 ${SECRETARY_RUNNER}만 지원)`,
  'command-shape': `실행기 명령이 ${SECRETARY_RUNNER}가 아니거나 모델·강도 옵션 자리를 하나로 읽지 못함`,
};
export const freshSecretarySettings = home => ({command}) => {
  const result = secretaryCommandFromSettings({home, command, fresh: true});
  return {...result, note: result.skipped
    ? `비서 실행 모델 설정을 적용하지 못해 실행기 명령 그대로 띄운다(${SECRETARY_FRESH_SKIP_REASONS[result.skipped] ?? result.skipped})` : null};
};

// 설정 화면·runners show의 '무엇이 일어나는가' 한 줄. 자리가 비어 있으면 null이다.
export function secretaryCommandLabel(value) {
  if (!value) return null;
  if (value.runner !== SECRETARY_RUNNER) return `적용 안 됨 — 비서 다시 열기는 ${SECRETARY_RUNNER}만 지원한다(지금 값: ${value.runner})`;
  const effort = value.effort ? ` -c model_reasoning_effort="${value.effort}"` : '';
  return `비서를 다시 열 때(restart·up 복원·로티 탭 복원) 저장된 명령의 모델·강도만 바꾼다: --model ${value.model}${effort}`;
}

// 적용하지 못했을 때 사람이 볼 한 줄을 표준 오류에 낸다(호출자가 다른 출력 길을 주지 않았을 때의 기본).
export const warnSecretarySkip = result => { if (result.skipped) console.error(secretarySkipNote(result.skipped)); };
