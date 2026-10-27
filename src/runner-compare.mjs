// Why: 프리셋을 손으로 바꾸지 않고, 짧은 예약 잠금 안에서 가장 적게 고른 쪽을 정한다.
import {randomUUID} from 'node:crypto';
import {appendLedger, resolveLedgerBy} from './ledger.mjs';
import {storageSnapshot, storageVersion} from './storage.mjs';
import {change, checkChoice, checkFamilies, launchFor, lockedSettings, readSettings} from './runner-settings.mjs';
import {assertCompareShape, COMPARE_OFF_HINT} from './compare-policy.mjs';

export const PICK_COUNT_SQL = `SELECT json_extract(payload,'$.preset') AS preset, count(*) AS count
  FROM events NOT INDEXED WHERE rowid > ? AND stream = 'system/events.jsonl'
  AND json_extract(payload,'$.kind') = 'compare-pick'
  AND json_extract(payload,'$.epoch') = ? GROUP BY preset`;

export function validateCompare(settings, options = {}) {
  assertCompareShape(settings.compare);
  for (const name of settings.compare.presets) {
    try {
      const preset = Object.hasOwn(settings.presets, name) && settings.presets[name];
      if (!preset) throw new Error('없는 프리셋');
      for (const role of ['worker', 'reviewer']) {
        if (!preset.roles?.[role]) throw new Error(`${role} 역할 값 없음`);
        checkChoice(settings, role, preset.roles[role], options);
      }
      checkFamilies(preset.roles, settings.families);
    } catch (error) {
      throw new Error(`비교 프리셋 ${name}: ${error.message} — ${COMPARE_OFF_HINT}`);
    }
  }
}

export function setCompare(home, {enabled, presets, now = () => new Date().toISOString(),
  readCodexModels, ...meta}) {
  if (typeof enabled !== 'boolean') throw new Error('비교 모드는 on 또는 off');
  return change(home, {...meta, action: 'compare'}, next => {
    const before = next.compare ?? null;
    if (!enabled) {
      next.compare = {...(before ?? {presets: [], enabledAt: null}), enabled: false};
    } else {
      const names = typeof presets === 'string' ? presets.split(',').map(name => name.trim()) : presets;
      const afterRowid = storageVersion(home) ?? 0;
      // 첫 회차 경계도 보존한다. --since는 비교 도입 전 원장을 읽지 않는다.
      const historyStartRowid = before?.historyStartRowid ?? before?.afterRowid ?? afterRowid;
      const timestamp = now();
      const enabledAt = before?.enabledAt && Date.parse(timestamp) <= Date.parse(before.enabledAt)
        ? new Date(Date.parse(before.enabledAt) + 1).toISOString() : timestamp;
      next.compare = {enabled: true, presets: names, enabledAt, afterRowid, historyStartRowid};
      validateCompare(next, readCodexModels ? {readCodexModels} : {});
    }
    return {before, after: next.compare};
  });
}

export function compareCounts(home, compare) {
  if (!compare?.enabledAt) return {};
  return storageSnapshot(home, db => db ? Object.fromEntries(
    db.prepare(PICK_COUNT_SQL).all(compare.afterRowid ?? 0, compare.enabledAt)
      .map(row => [row.preset, row.count])) : {});
}

export function compareState(home) {
  const settings = readSettings(home);
  const compare = settings?.compare ?? {enabled: false, presets: [], enabledAt: null};
  return {revision: settings?.revision ?? null, ...compare, picks: compareCounts(home, compare)};
}

export function pickCompareLaunch(home, role, {readCodexModels, record = entry => appendLedger(entry, home)} = {}) {
  const current = readSettings(home);
  if (!current?.compare?.enabled) return launchFor(current, 'worker');
  // 설정 변경과 같은 잠금: 회차를 읽기 → 검증 → 예약 기록까지 설정이 바뀌지 않는다.
  // 세션/창 생성은 이 함수가 돌아온 뒤라 잠금을 쥔 채 외부 실행을 기다리지 않는다.
  return lockedSettings(home, () => {
    const settings = readSettings(home);
    if (!settings?.compare?.enabled) return launchFor(settings, 'worker');
    validateCompare(settings, readCodexModels ? {readCodexModels} : {});
    const counts = compareCounts(home, settings.compare);
    const preset = settings.compare.presets.reduce((best, name) =>
      (counts[name] ?? 0) < (counts[best] ?? 0) ? name : best);
    const launch = launchFor(settings, 'worker', preset);
    const pickId = randomUUID();
    record({kind: 'compare-pick', pickId, epoch: settings.compare.enabledAt,
      settingsRevision: settings.revision, preset, role, by: resolveLedgerBy(),
      worker: settings.presets[preset].roles.worker, reviewer: settings.presets[preset].roles.reviewer});
    return {...launch, compareMode: true, pickId};
  });
}
