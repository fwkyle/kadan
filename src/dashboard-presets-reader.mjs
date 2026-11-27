// Why: 늘 켜진 외부 화면이 자주 부르는 프리셋 읽기 창구다. 실행기 표·이력·화면 모델은 계산하지 않고
// 설정 파일 한 번, 업무 증분 읽기, 원장 증분 읽기만 쓴다. 10배 이력에서도 바뀐 업무·새 사건만 다시 적용한다
// (업무 head 대조와 열린 업무의 책임자 계산은 업무 수에 비례한다).
import {readSettings, HARD_ROLE} from './runner-settings.mjs';
import {readLedgerIncremental} from './ledger-incremental.mjs';
import {storageSnapshot} from './storage.mjs';
import {createDashboardStoreReader} from './dashboard-store-reader.mjs';
import {effectiveWorkOwner} from './handover-state.mjs';
import {sessionName} from './cli-basics.mjs';

export const MAX_PRESET_SESSIONS = 64;
const SLOTS = ['conductor', 'worker', HARD_ROLE, 'reviewer'];
const OPEN_STATUSES = new Set(['open', 'hold']);
// sessionName은 남는 글자가 없으면 프로세스를 끝낸다(die). 요청 값이 그 길에 가지 않게 먼저 거른다.
const NAME_CHAR = /[\p{L}\p{N}\p{Extended_Pictographic}_]/u;

export function roleOfSession(session) {
  const role = session.replace(/^kadan-/, '');
  return NAME_CHAR.test(role) && sessionName(role) === session ? role : null;
}

// 설정 값은 통째로 펼치지 않고 보일 칸만 고른다(실행 명령 틀은 싣지 않는다).
const pick = value => value
  ? {runner: value.runner, model: value.model, effort: value.effort} : null;

function presetView(name, preset, activePreset) {
  const fallback = {};
  for (const slot of SLOTS) {
    const list = preset.fallback?.[slot];
    if (list?.length) fallback[slot] = list.map(pick);
  }
  return {name, label: preset.label ?? name, active: name === activePreset,
    roles: Object.fromEntries(SLOTS.map(slot => [slot, pick(preset.roles?.[slot])])), fallback};
}

// names는 지금 설정의 프리셋 이름이다. 설정 파일이 없으면 빈 집합, 못 읽었으면 null(모름).
function readSettingsPart(home) {
  try {
    const value = readSettings(home);
    if (!value) return {settings: null, names: new Set()};
    const {revision, activePreset, compare, presets} = value;
    return {
      settings: {revision, activePreset,
        compare: {enabled: compare?.enabled ?? false, presets: compare?.presets ?? []},
        presets: Object.entries(presets)
          .map(([name, preset]) => presetView(name, preset, activePreset))},
      names: new Set(Object.keys(presets)),
    };
  } catch (error) {
    // JSON 해석 오류 문구에는 파일 내용 조각(실행 명령일 수 있다)이 섞이므로 싣지 않는다.
    const settingsError = error instanceof SyntaxError
      ? '실행 모델 설정 손상: JSON 해석 실패' : String(error.message).split('\n')[0];
    return {settings: null, settingsError, names: null};
  }
}

function workView(work, names) {
  const preset = work.preset || null;
  return {key: work.key, title: work.title, status: work.status, preset,
    presetSource: !preset ? 'default' : work.presetAuto === true ? 'auto' : 'explicit',
    // 설정을 못 읽었으면 없는 이름이라고 단정하지 않는다.
    presetMissing: Boolean(preset && names && !names.has(preset))};
}

// 요청한 역할마다 지금 책임자(인계 반영)인 열린 업무를 업무 키 순으로 모은다.
function openWorksByRole(home, readWorks, roles) {
  // 업무와 원장은 같은 시점에서 읽는다.
  const {works, entries} = storageSnapshot(home,
    () => ({works: readWorks(), entries: readLedgerIncremental(home)}));
  const found = new Map(roles.map(role => [role, []]));
  for (const work of works) {
    if (OPEN_STATUSES.has(work.status)) found.get(effectiveWorkOwner(work, entries))?.push(work);
  }
  for (const list of found.values()) list.sort((a, b) => (a.key < b.key ? -1 : 1));
  return found;
}

// readWorks: 대시보드 서버는 요약과 같은 업무 기억을 넘긴다. 없으면 자기 증분 읽기를 만든다.
export function createDashboardPresetsReader(home, {
  readWorks = createDashboardStoreReader(home, 'works', {facts: true}).readRows, now = Date.now,
} = {}) {
  return url => {
    const requested = url.searchParams.getAll('session');
    if (requested.length > MAX_PRESET_SESSIONS) {
      throw Object.assign(new Error(
        `session은 최대 ${MAX_PRESET_SESSIONS}개까지 줄 수 있습니다: ${requested.length}개`),
      {status: 400});
    }
    const sessions = [...new Set(requested)]
      .map(session => ({session, role: roleOfSession(session)}));
    const {settings, settingsError, names} = readSettingsPart(home);
    const roles = sessions.map(item => item.role).filter(role => role !== null);
    const works = roles.length ? openWorksByRole(home, readWorks, roles) : new Map();
    return {
      collectedAt: new Date(now()).toISOString(),
      settings,
      ...(settingsError ? {settingsError} : {}),
      sessions: sessions.map(({session, role}) => role === null
        ? {session, role, works: [], error: '세션 이름 규칙 밖'}
        : {session, role, works: works.get(role).map(work => workView(work, names))}),
    };
  };
}
