import test from 'node:test';
import assert from 'node:assert/strict';
import {applyTheme,darkColor} from '../src/theme.mjs';
import {renderCenterWall} from '../src/center-wall.mjs';

test('09-24 다크 모드: 선언 안의 색만 변수로 바꾸고 선택자·white-space는 건드리지 않는다', () => {
  const html = applyTheme('<html><head><style>#abc-panel{color:#202724;background:white}.x #fed,.y{border:1px solid #dce2de}@media (max-width:800px){.a{background:#fff0d0}}@keyframes k{to{color:#21684e}}.w{white-space:nowrap}</style></head><body><i style="width:5%;background:#158064"></i></body></html>');
  assert.match(html, /#abc-panel\{color:var\(--kc-202724\);background:var\(--kc-ffffff\)\}/);
  assert.match(html, /\.x #fed,\.y\{border:1px solid var\(--kc-dce2de\)\}/);
  assert.match(html, /@media \(max-width:800px\)\{\.a\{background:var\(--kc-fff0d0\)\}\}/);
  assert.match(html, /@keyframes k\{to\{color:var\(--kc-21684e\)\}\}/);
  assert.match(html, /\.w\{white-space:nowrap\}/);
  assert.match(html, /style="width:5%;background:var\(--kc-158064\)"/);
  // 밝은 값은 원래 색 그대로, 어두운 값은 시스템 설정과 직접 선택 두 경로.
  assert.match(html, /:root\{color-scheme:light;[^}]*--kc-202724:#202724/);
  assert.match(html, /@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme="light"\]\)\{color-scheme:dark;[^}]*--kc-202724:#[0-9a-f]{6}/);
  assert.match(html, /:root\[data-theme="dark"\]\{color-scheme:dark;/);
  // 기억한 테마는 스타일보다 먼저 붙인다(밝은 화면 번쩍임 방지).
  assert.ok(html.indexOf("localStorage.getItem('kadan-theme')") < html.indexOf('<style>'));
});

test('09-24 어두운 색 계산: 배경은 어둡게, 글자는 밝게, 색상 유지, 반투명한 어두운 그림자는 그대로', () => {
  const lum = hex => { const n = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255); return (Math.max(...n) + Math.min(...n)) / 2; };
  assert.ok(lum(darkColor('#ffffff')) < 0.15);
  assert.ok(lum(darkColor('#202724')) > 0.75);
  const green = darkColor('#21684e');
  assert.ok(lum(green) > 0.6 && parseInt(green.slice(3, 5), 16) > parseInt(green.slice(1, 3), 16));
  assert.equal(darkColor('#20272415'), '#20272415');
  assert.equal(darkColor('#fff').length, 7);
});

test('09-24 대시보드 전체: 스타일 선언에 색이 직접 남지 않고 테마 단추가 운영 메뉴 앞에 있다', () => {
  const html = renderCenterWall({center:null, entries:[], ledgerLines:0});
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].slice(1).map(m => m[1]).join('');
  assert.deepEqual(styles.match(/:[^;{}]*#[0-9a-fA-F]{3,8}\b/g) || [], []);
  assert.match(html, /<button type="button" class="dw-theme" data-theme-toggle aria-label="화면 테마 바꾸기">테마: 자동<\/button><details class="dw-more">/);
  assert.match(html, /localStorage\.setItem\('kadan-theme',next\)/);
});
