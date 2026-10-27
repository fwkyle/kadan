// 실제 작업자 세대를 기준으로 검수자 후보를 고른다. 발령 입구의 검사는 바꾸지 않는다.
import {inspectCardSendIdentity, launchIdentityOf} from './ai-identity.mjs';
import {checkChoice, launchFor, launchForFallback, modelFamily} from './runner-settings.mjs';

export function reviewerLaunch({settings, entries, workerRole, workerSession, currentPid}) {
  const identity = inspectCardSendIdentity({entries, session: workerSession, currentPid});
  if (!identity.ok) throw new Error(`검수자 시작 거절: 작업자 실행 모델 확인 실패 — ${identity.message}`);
  const family = modelFamily(identity.model, settings?.families);
  if (!family) throw new Error(`검수자 시작 거절: 작업자 ${identity.model}의 계열을 모른다`);
  const presetName = identity.launch.compareMode ? identity.launch.settingsPreset : settings?.activePreset;
  const preset = settings?.presets[presetName];
  if (!preset?.roles.reviewer) throw new Error('검수자 시작 거절: 검수자 1순위 설정이 없다');
  const candidates = [preset.roles.reviewer, ...(preset.fallback?.reviewer ?? [])];
  const skipped = [];
  for (const [index, value] of candidates.entries()) {
    let candidate;
    try {
      candidate = index === 0 ? launchFor(settings, 'reviewer', presetName)
        : launchForFallback(settings, 'reviewer', index, presetName);
    } catch (error) { skipped.push(`${value.model}: ${error.message}`); continue; }
    // 설정의 model뿐 아니라 실제 명령에서도 같은 모델이 읽혀야 한다.
    const parsed = launchIdentityOf(candidate.cmd);
    const other = parsed.ok && modelFamily(parsed.model, settings.families);
    if (!other || other === family || parsed.model !== candidate.model) {
      // 명령에 박힌 모델이 설정과 다르면 계열 비교보다 먼저 그 원인을 적는다.
      const why = parsed.ok && parsed.model !== candidate.model ? '명령·설정 모델 다름'
        : other === family ? '작업자와 같은 계열' : '명령·계열 확인 불가';
      skipped.push(`${candidate.model}: ${why}`);
      continue;
    }
    try { checkChoice(settings, 'reviewer', candidate); }
    catch (error) { skipped.push(`${candidate.model}: ${error.message}`); continue; }
    return {
      ...candidate,
      ...(identity.launch.compareMode && index === 0
        ? {compareMode: true, pickId: identity.launch.pickId} : {}),
      reviewFor: {role: workerRole, session: workerSession, panePid: String(currentPid),
        model: identity.model, family, reviewerModel: parsed.model, reviewerFamily: other,
        reason: `작업자 ${identity.model}(${family})와 다른 계열 ${other} 선택`, skipped},
    };
  }
  throw new Error(`검수자 시작 거절: 작업자 ${identity.model}(${family})에 맞는 다른 계열 검수자 없음 — ${skipped.join('; ')}`);
}
