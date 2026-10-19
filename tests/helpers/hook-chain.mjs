// Stop 훅의 부모 사슬 시험용 실행기 흉내. 실행기(claude·codex)처럼 훅 감싸개를 자식으로 띄우고 훅 출력을 그대로 내보낸다.
// 훅 입력은 환경값 HOOK_INPUT, 훅 감싸개 경로는 HOOK_SCRIPT다. HOOK_NEST=1이면 도구 셸을 거쳐 한 단계 더 깊은 자식 실행기로 다시 부른다.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const nested = process.env.HOOK_NEST === '1';
const run = nested
  ? spawnSync('/bin/sh', ['-c', `HOOK_NEST= "${process.execPath}" "${fileURLToPath(import.meta.url)}"; code=$?; exit $code`], {encoding: 'utf8'})
  : spawnSync('/bin/sh', [process.env.HOOK_SCRIPT], {input: process.env.HOOK_INPUT, encoding: 'utf8'});
process.stdout.write(run.stdout ?? '');
process.exit(run.status ?? 1);
