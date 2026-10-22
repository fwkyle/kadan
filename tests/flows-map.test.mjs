import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {ROLE_PROFILES} from '../src/role-instructions.mjs';

// 흐름 지도(docs/flows.md)는 사람·AI가 처음 읽는 한 장이다. 감시 경보나 소통 명령이 새로 생기고 지도가 그대로면
// 다시 흩어진 문서를 이어 붙여 읽게 된다(2026-10-05 [kyle]). 표의 문장은 대조하지 않고 이름의 누락만 잡는다.
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const flows = read('docs/flows.md');
const section = title => flows.split(new RegExp(`^## ${title}`, 'm'))[1]?.split(/^## /m)[0] ?? '';

test('감시 코드가 만드는 경보 종류가 모두 흐름 지도의 경보 표에 있다', () => {
  const kinds = new Set();
  for (const file of fs.readdirSync(new URL('../src/', import.meta.url)).filter(f => /^watch.*\.mjs$/.test(f)))
    for (const [, kind] of read('src/' + file).matchAll(/kind\s*:\s*['"]([^'"]*[가-힣][^'"]*)['"]/g)) kinds.add(kind);
  assert.ok(kinds.size >= 10, `경보 종류가 너무 적게 읽힘: ${[...kinds]}`);
  const table = section('4\\. 감시가 잡는 것');
  assert.ok(table, '흐름 지도의 감시 절이 없음');
  const missing = [...kinds].filter(kind => !table.includes('`' + kind + '`'));
  assert.deepEqual(missing, [], '흐름 지도 4절(docs/flows.md)에 경보 종류를 추가하세요');
});

test('디코 포럼 글 행이 받는이별 경로(레포 슈퍼 / 슈퍼 없으면 비서)를 담는다', () => {
  const row = section('3\\. 어떻게 주고받나').split('\n').find(l => l.startsWith('| 사용자 질문(디스코드'));
  assert.ok(row, '3절에 디코 사용자 질문 행이 없음');
  for (const text of ['가장 가까운 슈퍼감독', '슈퍼 없는 레포', '받는이', '--thread <id>'])
    assert.ok(row.includes(text), `디코 질문 행에 "${text}" 없음`);
  assert.ok(!row.includes('→ 비서 |'), '모든 글이 비서로 간다는 옛 표현이 남음');
});

test('역할 프로필과 핵심 소통 명령이 흐름 지도에 있다', () => {
  for (const profile of ROLE_PROFILES) assert.ok(section('1\\. 누가').includes(`--profile ${profile}`), `1절에 --profile ${profile} 없음`);
  const talk = section('3\\. 어떻게 주고받나');
  for (const command of ['kadan send', '--task', '--expect-reply', '--reply-final', 'kadan work execute', 'kadan card progress',
    'kadan done', 'kadan inbox ack', 'kadan decision request', 'kadan night on', 'kadan senior', 'kadan handover', 'kadan discord watch'])
    assert.ok(talk.includes(command), `3절에 ${command} 없음`);
});

test('설명 AI 경로가 흐름 지도에 있고 감시 AI와 다르다고 밝힌다', () => {
  const talk = section('3\\. 어떻게 주고받나');
  assert.ok(talk.includes('| 설명 AI |'), '3절 표에 설명 AI 행 없음');
  assert.ok(talk.includes('감시 AI가 아니다'), '3절에 설명 AI는 감시 AI가 아니라는 문장 없음');
  assert.match(read('docs/watch-overview.md'), /설명 AI는 감시 AI가 아니다/);
  assert.match(read('docs/runner-settings.md'), /## 설명 AI/);
});

test('기억 유지 재시작 줄에 화면 진입점(다시 띄우기 버튼)이 있다', () => {
  const talk = section('3\\. 어떻게 주고받나');
  const row = talk.split(String.fromCharCode(10)).find(line => line.includes('기억 유지 재시작'));
  assert.ok(row, '3절에 기억 유지 재시작 행 없음');
  assert.ok(row.includes('다시 띄우기'), '기억 유지 재시작 행에 화면 진입점(다시 띄우기 버튼)을 적으세요');
  assert.match(read('docs/dashboard-status-guide.md').split(/^## 화면 지도$/m)[1] ?? '', /다시 띄우기/);
});

test('흐름 지도가 문서 입구와 감독 지침에서 이어진다', () => {
  assert.match(read('README.md'), /\(docs\/flows\.md\)/);
  assert.match(read('docs/README.md'), /\(flows\.md\)/);
  assert.match(read('src/role-instructions.mjs'), /docs\/flows\.md/);
});

test('놀고 있음의 차례 칸 값(사용자 대기·글 값 안내)이 흐름 지도와 감시 문서에 있다', () => {
  const row = section('4\\. 감시가 잡는 것').split('\n').find(l => l.includes('감독 멈춤'));
  assert.ok(row?.includes('차례 칸'), '4절 감독 멈춤 행에 차례 칸 사용자 값 구절 없음');
  const overview = read('docs/watch-overview.md');
  for (const text of ['사용자 대기(차례 칸)', 'userTurnWaits', '--turn-owner @user', '--status hold'])
    assert.ok(overview.includes(text), `watch-overview.md에 ${text} 없음`);
  assert.ok(read('docs/hierarchy.md').includes('`@user`(current)'), 'hierarchy.md에 차례 칸 안내 없음');
});
