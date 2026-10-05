import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 메뉴를 바꾸고 화면 지도를 안 고치면 지도가 다시 낡는다(2026-10-05 [kyle]). 칸 이름은 대조하지 않는다.
const read=(p)=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('대시보드 메뉴의 주소와 이름이 모두 화면 지도에 있다', () => {
  const block=read('gui/src/App.tsx').match(/const links = \[([\s\S]*?)\n\];/);
  assert.ok(block,'App.tsx의 links 목록을 찾지 못함');
  const links=[...block[1].matchAll(/\["([^"]+)",\s*"([^"]+)"\]/g)].map(([,hash,label])=>({hash,label}));
  assert.ok(links.length>=6,'메뉴 항목이 너무 적게 읽힘');
  const map=read('docs/dashboard-status-guide.md').split(/^## 화면 지도$/m)[1]?.split(/^## /m)[0];
  assert.ok(map,'dashboard-status-guide.md의 화면 지도 절이 없음');
  const missing=links.filter(({hash,label})=>!new RegExp('#'+hash+'(?![\\w-])').test(map)||!map.includes(label));
  assert.deepEqual(missing,[],'화면 지도(docs/dashboard-status-guide.md)에 메뉴 주소·이름을 추가하세요');
});
