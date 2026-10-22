import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// docs/ai-install.md는 AI가 그대로 따르는 설치 절차다. README가 주소를 잃거나 문서의 명령 이름이 코드와 어긋나면
// 설치가 조용히 깨진다. 명령 이름의 존재만 대조하고 문장은 대조하지 않는다.
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const doc = read('docs/ai-install.md');
const cli = read('src/cli.mjs');

test('README가 AI용 설치 안내 주소(보기·raw)를 갖는다', () => {
  const readme = read('README.md');
  assert.ok(readme.includes('https://github.com/fwkyle/kadan/blob/main/docs/ai-install.md'), 'README에 보기 주소 없음');
  assert.ok(readme.includes('https://raw.githubusercontent.com/fwkyle/kadan/main/docs/ai-install.md'), 'README에 raw 주소 없음');
  assert.ok(read('docs/README.md').includes('(ai-install.md)'), '문서 지도에 ai-install.md 없음');
});

test('ai-install.md의 kadan 명령이 모두 COMMANDS에 있다', () => {
  const commands = new Set([...cli.slice(cli.indexOf('const COMMANDS')).matchAll(/^\s{2}['"]?([\w-]+)['"]?\s*:/gm)].map(m => m[1]));
  assert.ok(commands.has('doctor') && commands.has('adopt'), 'COMMANDS 읽기 실패');
  const used = new Set([...doc.matchAll(/`?kadan ([a-z][\w-]*)/g)].map(m => m[1]));
  for (const name of ['init', 'runners', 'up', 'doctor', 'adopt', 'attach', 'stop']) assert.ok(used.has(name), `문서에 kadan ${name} 없음`);
  const missing = [...used].filter(name => !commands.has(name));
  assert.deepEqual(missing, [], 'COMMANDS에 없는 명령이 문서에 있음');
});

test('ai-install.md가 빌드 단계와 금지 목록을 빠뜨리지 않는다', () => {
  for (const text of ['npm --prefix gui ci', 'npm run build:gui', '## 0. 하지 않는 것', 'kadan autostart install', '비밀값', '## 4. 확인', '## 5.'])
    assert.ok(doc.includes(text), `ai-install.md에 "${text}" 없음`);
});
