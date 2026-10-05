#!/usr/bin/env node
// 시니어 실측 시험(2026-10-05 [kyle]): 실제 모델을 한 번 부르므로 비용이 든다. 그래서 npm test에 넣지 않고 손으로 돌리고,
// 강도는 기본 low로 낮춘다. 운영 원장을 건드리지 않도록 임시 KADAN_HOME에서 돈다 — 실행 모델 설정만 복사한다.
// 사용: npm run smoke:senior [-- --effort low --timeout 600]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'src', 'cli.mjs');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const effort = option('effort', 'low'), timeout = option('timeout', '600');
const source = process.env.KADAN_HOME || path.join(os.homedir(), '.kadan');
const settingsFile = path.join(source, 'runner-settings.json');
if (!fs.existsSync(settingsFile)) { console.error(`실행 모델 설정이 없다: ${settingsFile}`); process.exit(2); }

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-senior-smoke-'));
fs.copyFileSync(settingsFile, path.join(home, 'runner-settings.json'));
const card = path.join(home, 'smoke-card.md');
fs.writeFileSync(card, [
  '# 시니어 실측 시험 카드', '', '## Why', '시니어 호출 경로 실측. 실제로 진행하지 않는다.', '',
  '## 작업 결과', '작업자가 `src/senior.mjs`의 기본 상한을 30분에서 10분으로 줄이는 변경을 올렸다. 검수자는 통과, 감독은 보류 의견이다.', '',
].join('\n'));
const env = {...process.env, KADAN_HOME: home, KADAN_WINDOW: 'none'};
delete env.KADAN_ROLE;
const run = argv => spawnSync(process.execPath, [cli, ...argv], {env, encoding: 'utf8'});
const created = run(['card', 'create', 'smoke/senior-probe', '--repo-path', repo, '--source', card, '--title', '시니어 실측 시험']);
if (created.status !== 0) { console.error(created.stderr || created.stdout); process.exit(1); }

console.log(`시니어 실측: 강도 ${effort}, 상한 ${timeout}초, 임시 폴더 ${home}`);
const started = Date.now();
const result = run(['senior', 'smoke/senior-probe', '--question', '이 결과를 받아들일지 결정해야 한다. 상한을 줄이는 변경을 합칠까?', '--effort', effort, '--timeout', timeout]);
const seconds = Math.round((Date.now() - started) / 1000);
const out = result.stdout ?? '';
const sections = ['결론', '근거', '위험', '확인할 것'].filter(name => new RegExp(`(^|\\n)\\s*\\**${name}\\**\\s*:`).test(out));
console.log(out);
if (result.status !== 0) { console.error(result.stderr); console.error(`실패: 종료 코드 ${result.status} (${seconds}초)`); process.exit(1); }
if (sections.length !== 4) { console.error(`실패: 답에 네 칸이 다 있지 않다 — 찾은 칸: ${sections.join(', ') || '없음'} (${seconds}초)`); process.exit(1); }
console.log(`통과: 네 칸 모두 있음, ${seconds}초. 증거는 ${home}/advice/ 아래에 남는다(임시 폴더, 지우지 않는다).`);
