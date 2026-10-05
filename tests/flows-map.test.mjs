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

test('역할 프로필과 핵심 소통 명령이 흐름 지도에 있다', () => {
  for (const profile of ROLE_PROFILES) assert.ok(section('1\\. 누가').includes(`--profile ${profile}`), `1절에 --profile ${profile} 없음`);
  const talk = section('3\\. 어떻게 주고받나');
  for (const command of ['kadan send', '--task', '--expect-reply', '--reply-final', 'kadan work execute', 'kadan card progress',
    'kadan done', 'kadan inbox ack', 'kadan decision request', 'kadan senior', 'kadan handover'])
    assert.ok(talk.includes(command), `3절에 ${command} 없음`);
});

test('흐름 지도가 문서 입구와 감독 지침에서 이어진다', () => {
  assert.match(read('README.md'), /\(docs\/flows\.md\)/);
  assert.match(read('docs/README.md'), /\(flows\.md\)/);
  assert.match(read('src/role-instructions.mjs'), /docs\/flows\.md/);
});
