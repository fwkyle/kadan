import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {blockModel, initSettings, readSettings, setActivePreset, setFallback, setRole, setRunnerModel} from '../src/runner-settings.mjs';
import {renderRunnerSettings} from '../src/runner-settings-wall.mjs';
import {renderCenterWall} from '../src/center-wall.mjs';
import {createWallServer} from '../src/wall.mjs';
import {readLedger} from '../src/ledger.mjs';

const codexModels = [
  {slug:'xai/grok-4.7-build-fast', supported_reasoning_levels:['low','medium','high','xhigh'].map(effort=>({effort}))},
  {slug:'gpt-6-sol', supported_reasoning_levels:['low','medium','high'].map(effort=>({effort}))},
  {slug:'gpt-6-astra', supported_reasoning_levels:['low','medium'].map(effort=>({effort}))},
  {slug:'xai/grok-5-review', supported_reasoning_levels:['medium'].map(effort=>({effort}))},
];
// 서버 쓰기 경로는 실제 ~/.codex 목록 대신 이 파일을 읽는다. node --test는 파일마다 따로 돌아 다른 시험에 새지 않는다.
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-rs-wall-cache-'));
process.env.KADAN_CODEX_MODELS_CACHE = path.join(cacheDir, 'models_cache.json');
fs.writeFileSync(process.env.KADAN_CODEX_MODELS_CACHE, JSON.stringify({models:codexModels}));

function fixture({init = true} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-rs-wall-'));
  fs.writeFileSync(path.join(home, 'agent-runners.json'), JSON.stringify({runners:[
    {id:'codex', spawn:'codex -p lite --model {model} -c model_reasoning_effort="{effort}"'},
    {id:'devin', spawn:'devin --model {model} --permission-mode dangerous'},
  ]}));
  const record = entry => {};
  if (init) {
    initSettings(home, {by:'kyle', reason:'시작', record});
    const meta = r => ({revision:r, by:'kyle', reason:'준비', record});
    setRole(home, {role:'worker', runner:'codex', model:'xai/grok-4.7-build-fast', effort:'xhigh', ...meta(1)});
    setRole(home, {role:'reviewer', runner:'codex', model:'gpt-6-sol', effort:'medium', ...meta(2)});
    blockModel(home, {model:'gpt-6-astra', roles:'reviewer', ...meta(3)});
    setRunnerModel(home, {runner:'devin', model:'swe-2-max', efforts:'', ...meta(4)});
    // 두 번째 프리셋 A를 만든다(활성은 B 유지).
    setRole(home, {role:'worker', runner:'devin', model:'swe-2-max', preset:'A', ...meta(5)});
  }
  return {home};
}

test('설정 파일이 없으면 init 안내만 보이고 폼은 없다', () => {
  const f = fixture({init:false});
  const html = renderRunnerSettings({home:f.home, token:'t'});
  assert.match(html, /kadan runners init/);
  assert.ok(!html.includes('<form'));
  assert.match(renderRunnerSettings({home:null}), /모름: 설정 위치 모름/);
});

test('역할 4행에 선택지·차단 이유·채워질 명령·최근 변경을 보여 준다', () => {
  const f = fixture();
  const entries = [
    {kind:'runner-settings', action:'set', by:'사람', t:'2026-09-23T06:00:00Z', preset:'B', role:'worker', before:{runner:'codex', model:'gpt-6-sol', effort:'low'}, after:{runner:'codex', model:'xai/grok-4.7-build-fast', effort:'xhigh'}, reason:'빠른 작업자 <b>'},
    {kind:'runner-settings', action:'preset', by:'사람', before:'A', after:'B', reason:'복귀'},
    {kind:'start', role:'x'},
  ];
  const html = renderRunnerSettings({home:f.home, token:'tok', entries});
  for (const label of ['작업자', '검수자', '일반감독', '슈퍼감독']) assert.ok(html.includes(`<h3>${label} `), label);
  assert.equal(html.match(/action="\/runners\/set"/g).length, 4);
  // 검수자 행에서만 astra가 이유와 함께 고를 수 없게 보인다.
  const reviewer = html.slice(html.indexOf('data-role="reviewer"'), html.indexOf('data-role="conductor"'));
  assert.match(reviewer, /<option value="gpt-6-astra" disabled>gpt-6-astra — 차단: 준비<\/option>/);
  const worker = html.slice(html.indexOf('data-role="worker"'), html.indexOf('data-role="reviewer"'));
  assert.match(worker, /<option value="gpt-6-astra">gpt-6-astra<\/option>/);
  // 고른 모델이 지원하는 강도만 나온다.
  assert.match(reviewer, /<option value="medium" selected>medium<\/option>/);
  assert.ok(!reviewer.includes('value="xhigh"'));
  assert.match(worker, /codex -p lite --model xai\/grok-4.7-build-fast -c model_reasoning_effort=&quot;xhigh&quot;/);
  assert.match(html, /비어 있음 — 발령 때 --cmd 필요/);
  assert.match(html, /name="revision" value="6"/);
  assert.match(html, /action="\/runners\/preset"/);
  assert.match(html, /최근 변경 2건/);
  assert.match(html, /codex \/ gpt-6-sol \/ low → codex \/ xai\/grok-4.7-build-fast \/ xhigh/);
  assert.match(html, /프리셋 전환<\/td><td>A → B/);
  assert.match(html, /빠른 작업자 &lt;b&gt;/);
  assert.ok(!html.includes('<b>'));
  // 화면 스크립트는 문법이 맞고, 끼워 넣은 선택지 자료는 JSON으로 읽힌다.
  const client = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(client));
  const data = JSON.parse(html.match(/<script type="application\/json" id="rs-data">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(data.runners.codex.models.find(m => m.model === 'gpt-6-sol').efforts, ['low', 'medium', 'high']);
  assert.equal(data.runners.devin.needsEffort, false);
});

test('모델 목록을 못 읽어도 화면은 뜨고 그 실행기만 모름으로 보인다', () => {
  const f = fixture();
  const html = renderRunnerSettings({home:f.home, token:'t', readCodexModels:() => { throw new Error('목록 없음'); }});
  assert.match(html, /모델 목록을 읽을 수 없음: 목록 없음/);
  assert.equal(html.match(/action="\/runners\/set"/g).length, 4);
});

test('대시보드 GNB에 실행 모델 항목이 있고 화면이 붙는다', () => {
  const f = fixture();
  const html = renderCenterWall({center:null, home:f.home, entries:[], ledgerLines:0}, {token:'abc'});
  assert.match(html, /<a href="#runner-settings" data-route="runner-settings">실행 모델<\/a>/);
  assert.match(html, /id="runner-settings" data-view="runner-settings"/);
  assert.match(html, /'runner-settings':'실행 모델'/);
});

test('프리셋 전환은 있는 다른 프리셋만, 이유와 revision을 받아 기록한다', () => {
  const f = fixture();
  const records = [];
  const meta = r => ({revision:r, by:'사람', reason:'전환', record:e => records.push(e)});
  assert.throws(() => setActivePreset(f.home, {preset:'Z', ...meta(6)}), /없는 프리셋/);
  assert.throws(() => setActivePreset(f.home, {preset:'B', ...meta(6)}), /이미 활성/);
  assert.throws(() => setActivePreset(f.home, {preset:'A', ...meta(5)}), /다시 읽고/);
  assert.throws(() => setActivePreset(f.home, {preset:'A', ...meta(6), reason:' '}), /이유/);
  assert.equal(setActivePreset(f.home, {preset:'A', ...meta(6)}).activePreset, 'A');
  assert.deepEqual(records.map(({action, before, after, by}) => ({action, before, after, by})), [{action:'preset', before:'B', after:'A', by:'사람'}]);
});

test('서버 쓰기 경로는 사람 명의로 저장하고, 토큰·revision·이유·목록 밖·차단·같은 계열을 거부한다', async () => {
  const f = fixture();
  const server = createWallServer(() => ({center:null, entries:readLedger(f.home), tree:[], ledgerLines:0, collectedAt:new Date()}), {home:f.home, cacheSec:0});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(base)).text();
    const token = html.match(/name="token" value="([a-f0-9]+)"/)[1];
    const post = (where, fields) => fetch(base + where, {method:'POST', redirect:'manual',
      headers:{'content-type':'application/x-www-form-urlencoded', origin:base}, body:new URLSearchParams({token, revision:'6', reason:'시험', ...fields})});
    const set = fields => post('/runners/set', {role:'worker', runner:'codex', model:'xai/grok-4.7-build-fast', effort:'high', ...fields});
    const refused = async (response, status, pattern) => { assert.equal(response.status, status); assert.match(await response.text(), pattern); };

    await refused(await set({token:''}), 403, /새로 읽은 뒤/);
    await refused(await set({revision:'5'}), 409, /현재 revision 6.*다시 읽고 저장/);
    await refused(await set({reason:'  '}), 409, /이유/);
    await refused(await set({model:'gpt-9-nowhere'}), 409, /고를 수 없는 모델/);
    await refused(await set({effort:'max'}), 409, /지원하지 않는 강도/);
    await refused(await set({runner:'nobody'}), 409, /등록되지 않은 실행기/);
    await refused(await set({role:'secretary'}), 409, /역할은/);
    await refused(await set({role:'reviewer', model:'gpt-6-astra', effort:'low'}), 409, /정책으로 막은 모델/);
    await refused(await set({role:'reviewer', model:'xai/grok-5-review', effort:'medium'}), 409, /같은 계열\(grok\)/);
    await refused(await post('/runners/preset', {preset:'Z'}), 409, /없는 프리셋/);
    assert.equal(readSettings(f.home).revision, 6);

    const saved = await set({});
    assert.equal(saved.status, 303);
    assert.equal(saved.headers.get('location'), '/?runnersSaved=7#runner-settings');
    // 강도를 받지 않는 실행기는 빈 강도를 없음으로 받는다.
    const devin = await post('/runners/set', {revision:'7', role:'conductor', runner:'devin', model:'swe-2-max', effort:''});
    assert.equal(devin.status, 303);
    const switched = await post('/runners/preset', {revision:'8', preset:'A'});
    assert.equal(switched.headers.get('location'), '/?runnersSaved=9#runner-settings');

    const settings = readSettings(f.home);
    assert.equal(settings.activePreset, 'A');
    assert.deepEqual(settings.presets.B.roles.worker, {runner:'codex', model:'xai/grok-4.7-build-fast', effort:'high'});
    assert.deepEqual(settings.presets.B.roles.conductor, {runner:'devin', model:'swe-2-max'});
    const events = readLedger(f.home).filter(e => e.kind === 'runner-settings');
    assert.deepEqual(events.map(e => [e.action, e.by, e.revision]), [['set', '사람', 7], ['set', '사람', 8], ['preset', '사람', 9]]);
    assert.deepEqual(events[0].before, {runner:'codex', model:'xai/grok-4.7-build-fast', effort:'xhigh'});

    const after = await (await fetch(base + '/?runnersSaved=9')).text();
    assert.match(after, /저장했습니다\(revision 9\)\. 다음 발령부터 적용, 떠 있는 세션은 그대로/);
    assert.match(after, /최근 변경 3건/);
    // 지난 revision의 저장 알림은 다시 보이지 않는다.
    assert.ok(!(await (await fetch(base + '/?runnersSaved=7')).text()).includes('저장했습니다(revision'));
  } finally { await new Promise(r => server.close(r)); }
});

test('화면 스크립트는 실행기를 바꾸면 모델을, 모델을 바꾸면 강도를 좁히고 차단 모델은 막는다', () => {
  const f = fixture();
  const html = renderRunnerSettings({home:f.home, token:'t'});
  const client = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const json = html.match(/<script type="application\/json" id="rs-data">([\s\S]*?)<\/script>/)[1];
  // 이 시험에 필요한 만큼만 흉내 낸 select·form.
  const select = value => ({value, disabled:false, options:[], handlers:{},
    replaceChildren(){ this.options = []; }, append(o){ this.options.push(o); if (o.selected) this.value = o.value; },
    addEventListener(type, fn){ this.handlers[type] = fn; }});
  const form = {dataset:{role:'reviewer'}, runner:select('codex'), model:select('gpt-6-sol'), effort:select('medium')};
  const document = {getElementById:() => ({textContent:json}), querySelectorAll:() => [form], createElement:() => ({})};
  new Function('document', client)(document);
  form.model.value = 'gpt-6-astra'; form.model.handlers.change();
  assert.deepEqual(form.effort.options.map(o => o.value), ['low', 'medium']);
  assert.equal(form.effort.value, 'medium');
  form.runner.value = 'devin'; form.runner.handlers.change();
  assert.deepEqual(form.model.options.filter(o => !o.disabled).map(o => o.value), ['swe-2-max']);
  assert.equal(form.effort.disabled, true);
  form.runner.value = 'codex'; form.runner.handlers.change();
  const astra = form.model.options.find(o => o.value === 'gpt-6-astra');
  assert.equal(astra.disabled, true);
  assert.match(astra.textContent, /차단: 준비/);
});

test('폴백 순서 화면: 내려가는 조건, 역할 4개 편집 폼, 번호별 명령과 순서 버튼을 보여 준다', () => {
  const f = fixture();
  setFallback(f.home, {role:'worker', items:[{runner:'devin', model:'swe-2-max'}, {runner:'codex', model:'xai/grok-5-review', effort:'medium'}], revision:6, by:'kyle', reason:'준비', record:() => {}});
  const entries = [{kind:'runner-settings', action:'fallback', by:'사람', preset:'B', role:'worker', before:[], after:[{runner:'devin', model:'swe-2-max'}], reason:'쿼터 대비'}];
  const html = renderRunnerSettings({home:f.home, token:'tok', entries});
  assert.match(html, /내려가는 조건: 원인이 확인된 막힘\(쿼터·429·로그인 실패·모델 이름 오류\)만\. 원인을 모르면 멈추고 보고/);
  assert.equal(html.match(/action="\/runners\/fallback"/g).length, 4);
  const worker = html.slice(html.indexOf('<h4>작업자 폴백'), html.indexOf('<h4>검수자 폴백'));
  assert.match(worker, /1번 devin \/ swe-2-max<\/span> <code>devin --model swe-2-max --permission-mode dangerous<\/code>/);
  assert.match(worker, /<button name="op" value="up:1" disabled>위로<\/button>/);
  assert.match(worker, /<button name="op" value="down:2" disabled>아래로<\/button>/);
  assert.match(worker, /<button name="op" value="remove:2">삭제<\/button>/);
  assert.match(worker, /--fallback N --reason/);
  const reviewer = html.slice(html.indexOf('<h4>검수자 폴백'), html.indexOf('<h4>일반감독 폴백'));
  assert.match(reviewer, /폴백 없음/);
  assert.match(reviewer, /<option value="gpt-6-astra" disabled>gpt-6-astra — 차단: 준비<\/option>/);
  assert.match(html, /폴백 순서 · B 작업자<\/td><td>없음 → 1\. devin \/ swe-2-max/);
});

test('폴백 쓰기 경로: 추가·순서·삭제는 사람 명의로 저장하고 출처·토큰·revision·이유·목록 밖·차단·계열·없는 번호를 거부한다', async () => {
  const f = fixture();
  const server = createWallServer(() => ({center:null, entries:readLedger(f.home), tree:[], ledgerLines:0, collectedAt:new Date()}), {home:f.home, cacheSec:0});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = (await (await fetch(base)).text()).match(/name="token" value="([a-f0-9]+)"/)[1];
    let revision = 6;
    const post = (fields, {origin = base, where = '/runners/fallback'} = {}) => fetch(base + where, {method:'POST', redirect:'manual',
      headers:{'content-type':'application/x-www-form-urlencoded', origin}, body:new URLSearchParams({token, revision:String(revision), reason:'시험', role:'worker', ...fields})});
    const refused = async (response, status, pattern) => { assert.equal(response.status, status); assert.match(await response.text(), pattern); };
    const saved = async response => { assert.equal(response.status, 303); revision++; assert.equal(response.headers.get('location'), `/?runnersSaved=${revision}#runner-settings`); };
    const add = (model, effort, extra = {}) => post({op:'add', runner:effort ? 'codex' : 'devin', model, ...(effort ? {effort} : {}), ...extra});

    await refused(await add('swe-2-max', null, {token:''}), 403, /새로 읽은 뒤/);
    await refused(await post({op:'add', runner:'devin', model:'swe-2-max'}, {origin:'http://evil.example'}), 403, /다른 사이트/);
    await refused(await add('swe-2-max', null, {revision:'5'}), 409, /현재 revision 6.*다시 읽고 저장/);
    await refused(await add('swe-2-max', null, {reason:''}), 409, /이유/);
    await refused(await post({op:'add', runner:'codex'}), 409, /추가할 모델을 고르세요/);
    await refused(await add('gpt-9-nowhere', 'low'), 409, /폴백 1번: codex에서 고를 수 없는 모델/);
    await refused(await add('gpt-6-sol', 'xhigh'), 409, /지원하지 않는 강도/);
    await refused(await add('gpt-6-sol', 'low'), 409, /작업자 폴백 1번\(gpt-6-sol\)이 검수자 1순위와 같은 계열\(gpt\)/);
    await refused(await add('gpt-6-astra', 'low', {role:'reviewer'}), 409, /정책으로 막은 모델/);
    await refused(await add('xai/grok-5-review', 'medium', {role:'reviewer'}), 409, /검수자 폴백 1번.*작업자 1순위와 같은 계열\(grok\)/);
    await refused(await post({op:'remove:1'}), 409, /없는 폴백 번호: 1 — 가능: 없음/);
    assert.equal(readSettings(f.home).revision, 6);

    await saved(await add('swe-2-max', null));
    await saved(await add('xai/grok-5-review', 'medium'));
    await refused(await post({op:'down:2'}), 409, /2번은 더 아래로 옮길 수 없다/);
    await refused(await post({op:'remove:3'}), 409, /없는 폴백 번호: 3 — 가능: 1\.\.2/);
    await saved(await post({op:'up:2'}));
    assert.deepEqual(readSettings(f.home).presets.B.fallback.worker.map(x => x.model), ['xai/grok-5-review', 'swe-2-max']);
    await saved(await post({op:'remove:1'}));
    assert.deepEqual(readSettings(f.home).presets.B.fallback.worker, [{runner:'devin', model:'swe-2-max'}]);
    // 1순위를 기존 폴백과 같은 계열로 바꾸는 저장도 거부한다.
    await refused(await post({role:'reviewer', runner:'devin', model:'swe-2-max'}, {where:'/runners/set'}), 409, /작업자 폴백 1번\(swe-2-max\)이 검수자 1순위와 같은 계열\(devin-swe\)/);

    const events = readLedger(f.home).filter(e => e.kind === 'runner-settings' && e.action === 'fallback');
    assert.deepEqual(events.map(e => [e.by, e.revision, e.after.length]), [['사람', 7, 1], ['사람', 8, 2], ['사람', 9, 2], ['사람', 10, 1]]);
    const html = await (await fetch(base + '/?runnersSaved=10')).text();
    assert.match(html, /저장했습니다\(revision 10\)\. 다음 발령부터 적용, 떠 있는 세션은 그대로/);
    assert.match(html, /1번 devin \/ swe-2-max/);
  } finally { await new Promise(r => server.close(r)); }
});
