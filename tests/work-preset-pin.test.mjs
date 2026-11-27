// 기본 프리셋 변경은 새 업무부터 적용(kadan/work-preset-pin-on-create):
// (1) 업무 생성 때 기본 프리셋 고정 (2) 바꾼 뒤 다시 띄울 세션 미리 보기 (3) 열린 업무가 쓰는 프리셋 삭제·이름 변경 거절.
// 격리 홈·가짜 실행기만 쓰고, tmux는 격리 소켓(-L)만 쓴다(tests/helpers/preset-pin-rig.mjs).
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createWallServer} from '../src/wall.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {workCommand} from '../src/work-command.mjs';
import {runnersCommand} from '../src/runners-command.mjs';
import {launchFor, launchForFallback, readSettings, removePreset, renamePreset} from '../src/runner-settings.mjs';
import {exportPreset, importPreset} from '../src/runner-export.mjs';
import {setCompare} from '../src/runner-compare.mjs';
import {relaunchLines} from '../src/relaunch-preview.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {
  SETTINGS_FILE, cliRig, hasTmux, makeCard, makeHome, makeSettings, sendCard, startOf, workFields, writeSettings,
} from './helpers/preset-pin-rig.mjs';

const meta = home => ({revision: readSettings(home).revision, by: 'test', reason: '시험', record: () => {}});
const pairs = list => list.map(item => `${item.role}@${item.work ?? '-'}`).sort();
const staleRunner = pattern => error => {
  assert.equal(error.code, 'KADAN_STALE_RUNNER');
  assert.match(error.message, pattern);
  return true;
};

// 원장에 시작 기록만 있는 가짜 세션. 바닥(pids)이 살아 있다고 답한다. 명령은 설정이 만든 것과 같은 글이다.
function fakeSession(home, pids, role, profile, launch, extra = {}) {
  const pid = String(100 + Object.keys(pids).length);
  pids[`kadan-${role}`] = pid;
  appendLedger({kind: 'start', role, session: `kadan-${role}`, floor: 'fake', panePid: pid, cmd: launch.cmd, model: launch.model,
    roleProfile: profile, launchSource: 'settings', settingsPreset: launch.preset, settingsRevision: launch.revision, ...extra}, home);
  return startOf(home, role);
}
const fakeFloor = pids => ({name: 'fake', alive: session => Object.hasOwn(pids, session), pid: session => pids[session]});

test('업무 생성: 프리셋을 안 주면 그때의 기본 프리셋을 고정하고 presetAuto를 남긴다. 비교 모드·설정 없음·설정 손상은 고정하지 않는다', () => {
  const {home, repo} = makeHome();
  const ctx = {home, by: 'boss'}, base = workFields(repo);

  // 비교 꺼짐·설정 있음, --preset 없음 → preset=활성 이름, presetAuto: true. show·list·생성 기록에 모두 보인다.
  const auto = workCommand(['create', 'pin/w-auto'], base, ctx);
  assert.equal(auto.preset, 'B');
  assert.equal(auto.presetAuto, true);
  assert.equal(auto.history[0].presetAuto, true);
  assert.equal(workCommand(['show', 'pin/w-auto'], {}, ctx).presetAuto, true);
  assert.deepEqual((({preset, presetAuto}) => ({preset, presetAuto}))(workCommand(['list'], {}, ctx).find(w => w.key === 'pin/w-auto')),
    {preset: 'B', presetAuto: true});

  // --preset X → preset=X, presetAuto 없음(사람이 준 것).
  const manual = workCommand(['create', 'pin/w-manual'], {...base, preset: 'C'}, ctx);
  assert.equal(manual.preset, 'C');
  assert.equal('presetAuto' in manual, false);
  assert.equal('presetAuto' in workCommand(['list'], {}, ctx).find(w => w.key === 'pin/w-manual'), false);

  // 자동 고정한 업무의 프리셋을 사람이 바꾸거나 비우면 presetAuto가 사라진다.
  const changed = workCommand(['update', 'pin/w-auto'], {revision: '1', preset: 'C', note: '변경'}, ctx);
  assert.equal(changed.preset, 'C');
  assert.equal('presetAuto' in changed, false);
  const again = workCommand(['create', 'pin/w-auto2'], base, ctx);
  const cleared = workCommand(['update', 'pin/w-auto2'], {revision: String(again.revision), preset: '', note: '비우기'}, ctx);
  assert.equal('preset' in cleared, false);
  assert.equal('presetAuto' in cleared, false);
  // 프리셋과 상관없는 수정은 고정 표시를 그대로 둔다.
  const third = workCommand(['create', 'pin/w-auto3'], base, ctx);
  assert.equal(workCommand(['update', 'pin/w-auto3'], {revision: String(third.revision), progress: '진행', note: '진행'}, ctx).presetAuto, true);

  // 기본을 바꾼 뒤 만든 업무는 새 기본에 고정된다.
  runnersCommand(['preset', 'C'], {revision: '1', reason: '전환'}, {home, by: 'test', record: () => {}});
  assert.equal(workCommand(['create', 'pin/w-after'], base, ctx).preset, 'C');

  // 비교 모드가 켜져 있으면 고정하지 않는다(적으면 start --work가 비교 예약을 건너뛴다).
  setCompare(home, {enabled: true, presets: 'B,C', ...meta(home)});
  const compared = workCommand(['create', 'pin/w-compare'], base, ctx);
  assert.equal('preset' in compared, false);
  assert.equal('presetAuto' in compared, false);

  // 설정 파일 없음 → preset 없이 생성 성공. presetAuto는 저장소가 정하므로 호출자가 넣어도 남지 않는다(대시보드는 폼 칸을 그대로 넘긴다).
  const bare = makeHome({withSettings: false});
  const plain = new WorkStore(bare.home).create({key: 'pin/w-bare', title: '업무', goal: '목표', scope: '범위', acceptance: '조건',
    owner: 'boss', repoPath: bare.repo, presetAuto: true});
  assert.equal('preset' in plain, false);
  assert.equal('presetAuto' in plain, false);

  // 기본 프리셋에 작업자·검수자 값이 다 있지 않으면 고정하지 않는다(고정하면 검사 없이 가던 발령이 "역할 값 없음"으로 거절된다).
  const partial = makeHome({withSettings: false}), noReviewer = makeSettings();
  delete noReviewer.presets.B.roles.reviewer;
  writeSettings(partial.home, noReviewer);
  assert.equal('preset' in workCommand(['create', 'pin/w-partial'], workFields(partial.repo), {home: partial.home, by: 'boss'}), false);

  // 설정 파일이 손상돼도 업무 생성은 지금처럼 성공한다(고정만 하지 않는다).
  const broken = makeHome({withSettings: false});
  fs.writeFileSync(path.join(broken.home, SETTINGS_FILE), '{손상');
  const survived = workCommand(['create', 'pin/w-broken'], workFields(broken.repo), {home: broken.home, by: 'boss'});
  assert.equal(survived.status, 'open');
  assert.equal('preset' in survived, false);
});

test('발령 검사와 미리 보기: 고정 업무는 기본 전환 뒤에도 통과, 새 업무·프리셋 없는 옛 업무는 활성 기준, 미리 보기는 발령과 같은 판정', () => {
  // 프리셋 없는 옛 업무(자동 고정 전에 만든 업무)는 설정 파일이 생기기 전에 만든다.
  const {home, repo} = makeHome({withSettings: false});
  const ctx = {home, by: 'boss'}, base = workFields(repo);
  const legacy = workCommand(['create', 'pin/w-legacy'], base, ctx);
  assert.equal('preset' in legacy, false);
  writeSettings(home);
  const pinned = workCommand(['create', 'pin/w-pinned'], base, ctx);
  assert.equal(pinned.preset, 'B');

  const settings = readSettings(home), pids = {}, floor = fakeFloor(pids);
  const worker = fakeSession(home, pids, 'pw', 'worker', launchFor(settings, 'worker'));
  const viaFallback = fakeSession(home, pids, 'pf', 'worker', launchForFallback(settings, 'worker', 1), {launchSource: 'fallback', fallbackIndex: 1});
  const reviewer = fakeSession(home, pids, 'pr', 'reviewer', launchFor(settings, 'reviewer'));
  const loose = fakeSession(home, pids, 'ps', 'worker', launchFor(settings, 'worker')); // 어느 열린 업무에도 붙지 않은 세션
  fakeSession(home, pids, 'pc', 'conductor', launchFor(settings, 'worker')); // 작업자·검수자가 아닌 세션은 보지 않는다
  const dead = fakeSession(home, {}, 'pd', 'worker', launchFor(settings, 'worker')); // 바닥에 없는 세션은 보지 않는다
  assert.equal(dead.role, 'pd');

  const card = (id, role, step, work) => makeCard(home, repo, id, role, step, work);
  const c1 = card('c1', 'pw', 'implementation', 'pin/w-pinned');
  const cFallback = card('c-fb', 'pf', 'implementation', 'pin/w-pinned');
  const cReview = card('c-rev', 'pr', 'review', 'pin/w-pinned');
  const cLegacy = card('c-legacy', 'pw', 'implementation', 'pin/w-legacy');
  assert.equal(sendCard(home, c1, worker, 'pin/w-pinned').entry.runnerGuard, undefined);

  // 활성 B → C 전환. 결과에 다시 띄울 목록이 실린다(막지 않는다).
  const runnersCtx = {home, by: 'test', record: () => {}, floor};
  const switched = runnersCommand(['preset', 'C'], {revision: '1', reason: '전환'}, runnersCtx);
  assert.equal(switched.activePreset, 'C');
  const preview = switched.relaunchPreview;
  assert.deepEqual(preview.activeChanged, {from: 'B', to: 'C', pinsNewWorks: true});
  // 고정 업무의 B 세션은 그대로 쓰고, 프리셋 없는 옛 업무와 업무 밖 세션은 지금처럼 활성(C) 기준이라 다시 띄워야 한다.
  assert.deepEqual(pairs(preview.relaunch), ['ps@-', 'pw@pin/w-legacy']);
  assert.ok(preview.relaunch.every(item => item.code === 'runner-or-model' && item.preset === 'C'));
  // 대체 후보 모델로 뜬 세션은 "다시 띄울 필요 없음(대체 후보)"로 구분한다.
  assert.deepEqual(preview.fallbackOk.map(item => [item.role, item.work, item.preset, item.fallbackIndex]), [['pf', 'pin/w-pinned', 'B', 1]]);
  assert.equal(preview.ok, 2); // pw@고정 업무, pr@고정 업무
  assert.equal(preview.checked, 5);
  const lines = relaunchLines(preview).join('\n');
  assert.match(lines, /기본 프리셋 B → C: 지금부터 만드는 업무는 C에 고정된다/);
  assert.match(lines, /다시 띄워야 할 작업자·검수자 2개/);
  assert.match(lines, /pw\(worker · codex · gpt-6-sol\) — 업무 pin\/w-legacy · 기준 프리셋 C: 옛 실행기·모델 세션이다/);
  assert.match(lines, /ps\(worker · codex · gpt-6-sol\) — 열린 업무 없음\(업무 밖 카드 기준\)/);
  assert.match(lines, /다시 띄울 필요 없음\(대체 후보\) 1개:\n  pf\(worker · codex · gpt-6-astra\) — 업무 pin\/w-pinned · 기준 프리셋 B 대체 후보 1번/);
  assert.match(lines, /그대로 쓰는 세션·업무 짝 2개/);

  // 미리 보기와 실제 발령이 같은 판정을 낸다.
  assert.equal(sendCard(home, card('c2', 'pw', 'fix', 'pin/w-pinned'), worker, 'pin/w-pinned').entry.runnerGuard, undefined);
  assert.equal(sendCard(home, cReview, reviewer, 'pin/w-pinned').entry.runnerGuard, undefined);
  assert.equal(sendCard(home, cFallback, viaFallback, 'pin/w-pinned').entry.runnerGuard.code, 'fallback');
  assert.throws(() => sendCard(home, cLegacy, worker, 'pin/w-legacy'), staleRunner(/worker 기본값 = agy · gemini-4-neon-high/));
  assert.throws(() => sendCard(home, card('c-loose', 'ps', 'implementation', null), loose, null), staleRunner(/worker 기본값 = agy/));

  // 전환 뒤 새로 만든 업무는 C에 고정되어 B 세션 발령이 거절된다(옛 세션 막기 유지).
  const fresh = workCommand(['create', 'pin/w-fresh'], base, ctx);
  assert.equal(fresh.preset, 'C');
  assert.throws(() => sendCard(home, card('c-fresh', 'pw', 'implementation', 'pin/w-fresh'), worker, 'pin/w-fresh'),
    staleRunner(/프리셋 C worker 기본값 = agy · gemini-4-neon-high/));

  // 발령 검사가 읽지 않는 값만 바꾸면 미리 보기를 붙이지 않는다.
  const favorite = runnersCommand(['favorite'], {set: 'codex:gpt-6-sol:high', revision: String(readSettings(home).revision), reason: '즐겨찾기'}, runnersCtx);
  assert.equal('relaunchPreview' in favorite, false);

  // 대체 후보 목록을 비우면(runners fallback) 대체 후보로 뜬 세션이 다시 띄울 목록으로 옮겨 가고,
  // 내보내 둔 프리셋을 같은 이름으로 다시 가져오면(import --replace) 대체 후보 통과로 돌아온다.
  const exported = path.join(repo, 'preset-b.json');
  fs.writeFileSync(exported, JSON.stringify(exportPreset(home, {name: 'B'})));
  const emptied = runnersCommand(['fallback', 'worker'], {set: '', preset: 'B', revision: String(readSettings(home).revision), reason: '후보 비움'}, runnersCtx);
  assert.ok(pairs(emptied.relaunchPreview.relaunch).includes('pf@pin/w-pinned'));
  assert.deepEqual(emptied.relaunchPreview.fallbackOk, []);
  assert.throws(() => sendCard(home, card('c-fb2', 'pf', 'fix', 'pin/w-pinned'), viaFallback, 'pin/w-pinned'), staleRunner(/프리셋 B worker 기본값/));
  const restored = runnersCommand(['import', exported], {replace: true, revision: String(readSettings(home).revision), reason: '되돌림'}, runnersCtx);
  assert.equal(restored.imported, 'B');
  assert.deepEqual(pairs(restored.relaunchPreview.fallbackOk), ['pf@pin/w-pinned']);
  assert.equal(pairs(restored.relaunchPreview.relaunch).includes('pf@pin/w-pinned'), false);

  // B 안의 작업자 모델을 바꾸면 B 고정 업무의 옛 세션이 거절되고, 바꾸는 명령 결과의 다시 띄울 목록에 나온다.
  const edited = runnersCommand(['set', 'worker'], {runner: 'codex', model: 'gpt-6-astra', effort: 'high', preset: 'B',
    revision: String(readSettings(home).revision), reason: '모델 변경'}, runnersCtx);
  assert.equal('activeChanged' in edited.relaunchPreview, false);
  assert.ok(pairs(edited.relaunchPreview.relaunch).includes('pw@pin/w-pinned'));
  assert.match(edited.relaunchPreview.relaunch.find(item => item.role === 'pw' && item.work === 'pin/w-pinned').action,
    /kadan stop pw 뒤 kadan start pw --profile worker --preset B/);
  assert.match(relaunchLines(edited.relaunchPreview).join('\n'), /--preset 대신 --work pin\/w-pinned도 같다/);
  assert.throws(() => sendCard(home, card('c3', 'pw', 'fix', 'pin/w-pinned'), worker, 'pin/w-pinned'),
    staleRunner(/프리셋 B worker 기본값 = codex · gpt-6-astra · high/));

  // 업무 프리셋을 바꾸면 그 업무에 붙은 세션만 본다.
  const moved = workCommand(['update', 'pin/w-pinned'], {revision: String(new WorkStore(home).get('pin/w-pinned').revision), preset: 'C', note: '프리셋 변경'},
    {...ctx, floor});
  assert.equal(moved.preset, 'C');
  assert.deepEqual(pairs(moved.relaunchPreview.relaunch), ['pf@pin/w-pinned', 'pr@pin/w-pinned', 'pw@pin/w-pinned']);
  // 같은 프리셋으로 다시 적으면(값이 그대로면) 미리 보기를 붙이지 않는다.
  const same = workCommand(['update', 'pin/w-pinned'], {revision: String(moved.revision), preset: 'C', note: '그대로'}, {...ctx, floor});
  assert.equal('relaunchPreview' in same, false);
});

test('비교 모드를 나중에 켜도 이미 고정된 업무는 고정 프리셋 기준이다(업무 지정이 비교 세션보다 먼저)', () => {
  const {home, repo} = makeHome();
  workCommand(['create', 'pin/w-before'], workFields(repo), {home, by: 'boss'});
  setCompare(home, {enabled: true, presets: 'B,C', ...meta(home)});
  const settings = readSettings(home), pids = {};
  const pickedC = fakeSession(home, pids, 'cmp-c', 'worker', launchFor(settings, 'worker', 'C'), {compareMode: true, pickId: 'pick-c'});
  const pickedB = fakeSession(home, pids, 'cmp-b', 'worker', launchFor(settings, 'worker', 'B'), {compareMode: true, pickId: 'pick-b'});
  assert.throws(() => sendCard(home, makeCard(home, repo, 'cmp-1', 'cmp-c', 'implementation', 'pin/w-before'), pickedC, 'pin/w-before'),
    staleRunner(/프리셋 B worker 기본값 = codex · gpt-6-sol/));
  assert.equal(sendCard(home, makeCard(home, repo, 'cmp-2', 'cmp-b', 'implementation', 'pin/w-before'), pickedB, 'pin/w-before').entry.runnerGuard, undefined);
});

test('열린 업무가 쓰는 프리셋은 이름 변경·삭제를 설정 저장 층에서 거절하고, 닫힌 업무만 쓰면 허용한다', () => {
  const {home, repo} = makeHome();
  const ctx = {home, by: '사람'}, base = workFields(repo);
  workCommand(['create', 'pin/w-c'], {...base, preset: 'C'}, ctx);
  workCommand(['create', 'pin/w-b'], base, ctx); // 활성 B에 자동 고정
  const file = path.join(home, SETTINGS_FILE), before = fs.readFileSync(file, 'utf8');
  const blocked = /프리셋 C은\(는\) 열린 업무 1건이 쓰고 있어 이름을 바꾸거나 지울 수 없다 — 쓰는 업무: pin\/w-c — 푸는 법: 업무마다 kadan work update <업무> --revision N --preset <다른 이름>/;

  // 비활성 프리셋 삭제·이름 변경: 저장 함수와 CLI 명령이 같은 거절을 낸다.
  assert.throws(() => removePreset(home, {name: 'C', ...meta(home)}), blocked);
  assert.throws(() => renamePreset(home, {from: 'C', to: 'C2', ...meta(home)}), blocked);
  assert.throws(() => runnersCommand(['preset', 'remove', 'C'], {revision: '1', reason: '삭제'}, {home, by: 'test', record: () => {}}), blocked);
  assert.throws(() => runnersCommand(['preset', 'rename', 'C', 'C2'], {revision: '1', reason: '이름'}, {home, by: 'test', record: () => {}}), blocked);
  // 활성 프리셋 이름 변경도 열린 고정 업무가 있으면 거절한다.
  assert.throws(() => renamePreset(home, {from: 'B', to: 'B2', ...meta(home)}), /프리셋 B은\(는\) 열린 업무 1건이 쓰고 있어.*pin\/w-b/);
  // 보류(hold)도 열린 업무다.
  workCommand(['update', 'pin/w-c'], {revision: '1', status: 'hold', note: '보류'}, ctx);
  assert.throws(() => removePreset(home, {name: 'C', ...meta(home)}), blocked);
  // 거절은 설정 파일과 원장을 바꾸지 않는다.
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(readLedger(home).filter(e => e.kind === 'runner-settings').length, 0);

  // 이름이 그대로 남는 교체(가져오기 --replace)는 삭제·이름 변경이 아니라 막지 않는다.
  const replaced = importPreset(home, {data: exportPreset(home, {name: 'C'}), replace: true, ...meta(home)});
  assert.equal(replaced.imported, 'C');

  // 닫힌 업무(취소·완료)만 쓰는 프리셋은 지울 수 있다.
  workCommand(['cancel', 'pin/w-c'], {revision: '2', result: '취소', note: '취소'}, ctx);
  const removed = removePreset(home, {name: 'C', ...meta(home)});
  assert.equal(Object.hasOwn(removed.presets, 'C'), false);
  workCommand(['complete', 'pin/w-b'], {revision: '1', result: '끝', note: '완료'}, ctx);
  assert.equal(renamePreset(home, {from: 'B', to: 'B2', ...meta(home)}).activePreset, 'B2');
});

test('실물 CLI+격리 tmux: 고정 업무에 start --work·--fallback·--for로 띄운 세션은 고정 프리셋으로 뜨고, --work 없이 띄우면 반대로 거절된다', {skip: !hasTmux}, () => {
  const f = makeHome();
  const r = cliRig('cli', f);
  const start = (role, ...args) => { r.ok('start', role, '--hidden', '--no-prompt', ...args); return startOf(f.home, role); };
  try {
    const created = r.ok('work', 'create', 'pin/w-cli', '--title', '고정 업무', '--goal', '목표', '--scope', '범위',
      '--acceptance', '조건', '--owner', 'boss', '--board', '판', '--repo-path', f.repo);
    assert.equal(JSON.parse(created.stdout).preset, 'B');
    assert.equal(JSON.parse(created.stdout).presetAuto, true);
    assert.match(created.stderr, /기본 프리셋 B을\(를\) 이 업무에 고정했다/);

    // 전환 전부터 떠 있던 세션: 옛 방식(--work 없음)과 --work.
    const old = start('pe-old', '--profile', 'worker');
    const viaWork = start('pe-work', '--profile', 'worker', '--work', 'pin/w-cli');
    assert.equal(viaWork.presetSource, 'work');
    const card = (id, role, step = 'implementation') => makeCard(f.home, f.repo, id, role, step, 'pin/w-cli');
    const cOld = card('e-old', 'pe-old'), cWork = card('e-work', 'pe-work');

    // 기본 프리셋 전환: CLI 결과에 미리 보기가 실리고 사람이 읽는 줄은 stderr로 나온다. 이 업무의 두 세션은 그대로 쓴다.
    const switched = r.ok('runners', 'preset', 'C', '--revision', '1', '--reason', '전환');
    const preview = JSON.parse(switched.stdout).relaunchPreview;
    assert.deepEqual(preview.activeChanged, {from: 'B', to: 'C', pinsNewWorks: true});
    assert.deepEqual(preview.relaunch, []);
    assert.equal(preview.ok, 2);
    assert.match(switched.stderr, /기본 프리셋 B → C/);
    assert.match(switched.stderr, /다시 띄울 작업자·검수자 없음\(살아 있는 세션·업무 짝 2개 확인\)/);
    assert.equal(sendCard(f.home, cOld, old, 'pin/w-cli').entry.runnerGuard, undefined);
    assert.equal(sendCard(f.home, cWork, viaWork, 'pin/w-cli').entry.settingsPreset, 'B');

    // 반대 방향: 전환 뒤 --work 없이 띄운 새 작업자는 새 기본(C)으로 떠서 이 업무 카드가 거절된다.
    const plain = start('pe-plain', '--profile', 'worker');
    assert.equal(plain.model, 'gemini-4-neon-high');
    assert.throws(() => sendCard(f.home, card('e-plain', 'pe-plain'), plain, 'pin/w-cli'),
      staleRunner(/프리셋 B worker 기본값 = codex · gpt-6-sol[\s\S]*--preset B/));
    // --work로 띄우면 고정 프리셋으로 뜨고 발령이 통과한다.
    const fresh = start('pe-fresh', '--profile', 'worker', '--work', 'pin/w-cli');
    assert.deepEqual([fresh.model, fresh.settingsPreset, fresh.presetSource, fresh.presetWorkKey], ['gpt-6-sol', 'B', 'work', 'pin/w-cli']);
    assert.equal(sendCard(f.home, card('e-fresh', 'pe-fresh'), fresh, 'pin/w-cli').entry.runnerGuard, undefined);

    // --work + --fallback: 고정 프리셋의 대체 후보로 뜨고 대체 후보 경고로 통과한다.
    const viaFallback = start('pe-fb', '--profile', 'worker', '--work', 'pin/w-cli', '--fallback', '1', '--reason', '한도');
    assert.deepEqual([viaFallback.model, viaFallback.settingsPreset, viaFallback.presetSource, viaFallback.launchSource],
      ['gpt-6-astra', 'B', 'work', 'fallback']);
    assert.equal(sendCard(f.home, card('e-fb', 'pe-fb'), viaFallback, 'pin/w-cli').entry.runnerGuard.code, 'fallback');

    // 검수자(--for): --work로 띄운 작업자를 가리키면 고정 프리셋을 물려받는다.
    const inherit = start('pe-rev-inherit', '--profile', 'reviewer', '--for', 'pe-work');
    assert.deepEqual([inherit.model, inherit.settingsPreset, inherit.presetSource], ['claude-sonnet-5-5', 'B', 'review-for']);
    assert.equal(sendCard(f.home, card('e-rev1', 'pe-rev-inherit', 'review'), inherit, 'pin/w-cli').entry.runnerGuard, undefined);
    // --for + --work: 옛 방식 작업자(--work 없이 뜸)를 가리켜도 업무의 고정 프리셋 검수자로 뜬다.
    const withWork = start('pe-rev-work', '--profile', 'reviewer', '--for', 'pe-old', '--work', 'pin/w-cli');
    assert.deepEqual([withWork.model, withWork.settingsPreset, withWork.presetSource], ['claude-sonnet-5-5', 'B', 'work']);
    assert.equal(sendCard(f.home, card('e-rev2', 'pe-rev-work', 'review'), withWork, 'pin/w-cli').entry.runnerGuard, undefined);
    // --for만 주고 작업자가 옛 방식이면 새 기본(C)의 검수자로 떠서 이 업무의 검수 카드가 거절된다(반대 방향).
    const bare = start('pe-rev-bare', '--profile', 'reviewer', '--for', 'pe-old');
    assert.equal(bare.model, 'claude-fable-5-2');
    assert.throws(() => sendCard(f.home, card('e-rev3', 'pe-rev-bare', 'review'), bare, 'pin/w-cli'),
      staleRunner(/프리셋 B reviewer 기본값 = claude · claude-sonnet-5-5/));

    // B 안의 작업자 모델을 바꾸는 명령: 결과와 stderr에 다시 띄울 목록이 나온다.
    const edited = r.ok('runners', 'set', 'worker', '--runner', 'codex', '--model', 'gpt-6-astra', '--effort', 'high',
      '--preset', 'B', '--revision', '2', '--reason', '모델 변경');
    const after = JSON.parse(edited.stdout).relaunchPreview;
    for (const role of ['pe-old', 'pe-work', 'pe-fresh', 'pe-plain']) assert.ok(pairs(after.relaunch).includes(`${role}@pin/w-cli`), role);
    assert.equal(pairs(after.relaunch).includes('pe-fb@pin/w-cli'), false); // 새 1순위와 같은 모델
    assert.match(edited.stderr, /다시 띄워야 할 작업자·검수자 \d+개/);
    assert.match(edited.stderr, /pe-old\(worker · codex · gpt-6-sol\) — 업무 pin\/w-cli · 기준 프리셋 B/);

    // 열린 업무가 쓰는 비활성 프리셋(B)은 CLI에서 지우거나 이름을 바꿀 수 없다.
    for (const args of [['remove', 'B'], ['rename', 'B', 'B2']]) {
      const refused = r.run('runners', 'preset', ...args, '--revision', '3', '--reason', '정리');
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /프리셋 B은\(는\) 열린 업무 1건이 쓰고 있어.*pin\/w-cli.*kadan work update/);
    }
    assert.equal(readSettings(f.home).revision, 3);

    // 업무 프리셋을 바꾸면 그 업무에 붙은 세션의 다시 띄울 목록이 나온다.
    const moved = r.ok('work', 'update', 'pin/w-cli', '--revision', String(new WorkStore(f.home).get('pin/w-cli').revision),
      '--preset', 'C', '--note', '프리셋 변경');
    const movedPreview = JSON.parse(moved.stdout).relaunchPreview;
    assert.ok(pairs(movedPreview.relaunch).includes('pe-old@pin/w-cli'));
    assert.equal(pairs(movedPreview.relaunch).includes('pe-plain@pin/w-cli'), false); // C 작업자는 이제 통과
    assert.match(moved.stderr, /다시 띄워야 할 작업자·검수자/);
  } finally { r.cleanup(); }
});

// 대시보드 길: 127.0.0.1 임시 포트의 서버에 폼을 보낸다. 살아 있는 세션은 이 시험 실행의 격리 소켓(KADAN_SOCKET)에 하나 띄운다.
async function withServer(home, run) {
  const server = createWallServer(() => ({center: null, entries: readLedger(home), tree: [], ledgerLines: 0, collectedAt: new Date()}),
    {home, cacheSec: 0});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  try {
    const token = (await (await fetch(base)).text()).match(/name="token" value="([a-f0-9]+)"/)[1];
    await run((route, fields = {}) => fetch(base + route, {
      method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', origin: base},
      body: new URLSearchParams({token, reason: '시험', ...fields}),
    }));
  } finally {
    await new Promise(resolve => server.close(resolve));
    const listeners = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {encoding: 'utf8'});
    assert.equal(listeners.stdout.trim(), '');
    console.log(`검증 서버 종료: PID ${process.pid}, 127.0.0.1:${port}, lsof LISTEN 없음`);
  }
}

const runSocket = process.env.KADAN_SOCKET;
test('대시보드 길: 업무 생성도 고정하고, 프리셋 삭제·이름 변경은 같은 거절을 내며, 설정 저장 응답에 다시 띄울 목록이 실린다',
  {skip: !hasTmux || !runSocket}, async () => {
    const {home, repo} = makeHome();
    const env = {...process.env};
    delete env.TMUX;
    delete env.TMUX_PANE;
    const tmux = (...args) => spawnSync('tmux', ['-L', runSocket, ...args], {env, encoding: 'utf8'});
    const session = `kadan-pin-dash-${process.pid}`, role = session.slice('kadan-'.length);
    assert.equal(tmux('new-session', '-d', '-s', session, 'sleep 120').status, 0);
    try {
      const panePid = tmux('list-sessions', '-F', '#{session_name} #{pane_pid}').stdout.split('\n')
        .map(line => line.split(' ')).find(([name]) => name === session)?.[1];
      assert.match(panePid ?? '', /^\d+$/);
      const launch = launchFor(readSettings(home), 'worker');
      appendLedger({kind: 'start', role, session, floor: 'tmux', panePid, cmd: launch.cmd, model: launch.model,
        roleProfile: 'worker', launchSource: 'settings', settingsPreset: 'B', settingsRevision: 1}, home);
      workCommand(['create', 'pin/w-dash-c'], {...workFields(repo), preset: 'C'}, {home, by: 'boss'});
      await withServer(home, async post => {
        const revision = () => String(readSettings(home).revision);
        // 대시보드에서 만든 업무도 그때의 기본 프리셋에 고정된다(저장소 층이 정한다).
        const made = await post('/works/create', {key: 'pin/w-dash', title: '화면 업무', goal: '목표', scope: '범위', acceptance: '조건',
          owner: 'boss', repoPath: repo, board: '판'});
        assert.equal(made.status, 200, await made.clone().text());
        const stored = new WorkStore(home).get('pin/w-dash');
        assert.deepEqual([stored.preset, stored.presetAuto], ['B', true]);

        // 열린 업무가 쓰는 비활성 프리셋의 삭제·이름 변경: CLI와 같은 문구로 거절(409), 설정은 그대로.
        for (const [route, fields] of [['/runners/preset-remove', {preset: 'C'}], ['/runners/preset-rename', {from: 'C', preset: 'C2'}]]) {
          const refused = await post(route, {...fields, revision: revision()});
          assert.equal(refused.status, 409, route);
          assert.match(await refused.text(), /프리셋 C은\(는\) 열린 업무 1건이 쓰고 있어.*pin\/w-dash-c.*kadan work update/);
        }
        assert.equal(revision(), '1');

        // 프리셋 안 값 변경: 응답 데이터에 CLI와 같은 다시 띄울 목록이 실린다.
        const edited = await post('/runners/set', {role: 'worker', runner: 'codex', model: 'gpt-6-astra', effort: 'high', revision: revision()});
        assert.equal(edited.status, 200, await edited.clone().text());
        const preview = (await edited.json()).result.relaunchPreview;
        assert.deepEqual(preview.relaunch.map(item => [item.role, item.work, item.preset, item.code]), [[role, null, 'B', 'runner-or-model']]);

        // 기본 프리셋 전환: 응답에 전환 표시와 목록이 실린다.
        const switched = await post('/runners/preset', {preset: 'C', revision: revision()});
        assert.equal(switched.status, 200, await switched.clone().text());
        const after = (await switched.json()).result.relaunchPreview;
        assert.deepEqual(after.activeChanged, {from: 'B', to: 'C', pinsNewWorks: true});
        assert.deepEqual(after.relaunch.map(item => item.role), [role]);

        // 발령 검사가 읽지 않는 값(즐겨찾기)은 목록을 붙이지 않는다.
        const favorite = await post('/runners/favorite', {op: 'add', runner: 'codex', model: 'gpt-6-sol', effort: 'high', revision: revision()});
        assert.equal(favorite.status, 200, await favorite.clone().text());
        assert.equal('relaunchPreview' in (await favorite.json()).result, false);
      });
    } finally {
      console.log(`격리 소켓 ${runSocket}의 시험 세션 종료: ${session}`);
      tmux('kill-session', '-t', `=${session}`);
    }
  });
