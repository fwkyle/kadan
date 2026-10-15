// 실행기가 알려 주는 모델 목록 불러오기. 실행기 표(runners.<실행기>.listModels)의 명령을 그대로 한 번 돌리고,
// 출력은 parseModelList로만 읽는다. 실행기 이름 분기는 없다. 설정·원장에는 아무것도 쓰지 않고 결과도 저장하지 않는다.
import os from 'node:os';
import {readSettings, runnerChoices} from './runner-settings.mjs';
import {parseModelList, runnerTemplate} from './runner-table.mjs';
import {runJudgeProcess} from './watch-ai-process.mjs';

export const MODEL_LIST_TIMEOUT_MS = 20_000;
export const MODEL_LIST_MAX_BYTES = 256 * 1024;

export async function listRunnerModels(home, runner, {spawn = runJudgeProcess, timeoutMs = MODEL_LIST_TIMEOUT_MS, maxBytes = MODEL_LIST_MAX_BYTES, env = process.env} = {}) {
  const settings = readSettings(home);
  if (!settings) throw new Error('실행 모델 설정이 없다 — kadan runners init 먼저');
  const spec = settings.runners[runner];
  if (!spec) throw new Error(`등록되지 않은 실행기: ${runner}`);
  if (spec.catalog) throw new Error(`${runner}은 모델 목록 파일을 쓴다 — 불러오지 않는다`);
  const command = runnerTemplate(settings, runner, 'listModels');
  const res = await spawn(command, {input: '', timeout: timeoutMs, cwd: os.tmpdir(), reportComplete: () => false, maxBytes, env});
  const stderr = String(res.stderr ?? '');
  if (res.error?.code === 'ETIMEDOUT' || stderr.includes('KADAN_JUDGE_TIMEOUT=1')) throw new Error(`${timeoutMs / 1000}초 안에 목록이 오지 않아 끝냈다`);
  if (stderr.includes('KADAN_JUDGE_OUTPUT_LIMIT=1')) throw new Error(`출력이 ${maxBytes / 1024}KiB를 넘어 끝냈다`);
  if (stderr.includes('KADAN_JUDGE_SLEPT=1')) throw new Error('컴퓨터가 잠든 사이 끊겨 끝냈다 — 다시 불러오라');
  if (res.error || res.status !== 0) throw new Error(`목록 명령이 실패했다(종료 ${res.status ?? res.signal ?? '?'})${stderr.trim() ? `: ${stderr.trim().split('\n').pop().slice(0, 200)}` : ''}`);
  const registered = new Set(runnerChoices(settings, runner).keys());
  const models = parseModelList(res.stdout).map(m => ({...m, registered: registered.has(m.model)}));
  if (!models.length) throw new Error('목록 명령이 모델 이름을 하나도 내지 않았다');
  return {runner, models};
}
