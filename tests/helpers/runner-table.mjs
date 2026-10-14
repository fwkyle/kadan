// 실행기 명령 표 시험용 값 — 2026-10-14 실측 조사(실행기 명령 표)에서 확인한 틀. 운영 설정이 아니다.
export const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const TABLE = {
  codex: {
    spawn: 'codex -p lite --model {model} -c model_reasoning_effort="{effort}"',
    resume: 'codex -p lite --model {model} -c model_reasoning_effort="{effort}" resume {conversation}',
    fork: 'codex -p lite --model {model} -c model_reasoning_effort="{effort}" fork {conversation}',
    exec: 'codex exec -m {model} -c model_reasoning_effort={effort} -s read-only --skip-git-repo-check',
    version: 'codex --version', update: 'codex update',
    conversation: {kind: 'open-file', pattern: `/sessions/.+/rollout-[0-9T-]+-(${UUID})\\.jsonl$`},
  },
  claude: {
    spawn: 'claude --model {model} --effort {effort} --dangerously-skip-permissions',
    resume: 'claude --model {model} --effort {effort} --dangerously-skip-permissions --resume {conversation}',
    fork: 'claude --model {model} --effort {effort} --dangerously-skip-permissions --resume {conversation} --fork-session',
    exec: 'claude -p --model {model} --tools "" --no-session-persistence --output-format json',
    version: 'claude --version', update: 'claude update',
    conversation: {kind: 'pid-json', path: '~/.claude/sessions/{pid}.json', field: 'sessionId',
      match: {tmux: '{tmux}'}, stored: '~/.claude/projects/*/{conversation}.jsonl'},
  },
  agy: {
    spawn: 'agy --model {model} --dangerously-skip-permissions',
    resume: 'agy --model {model} --dangerously-skip-permissions --conversation {conversation}',
    exec: 'agy --model {model} --print-timeout 90s --output-format json --print {prompt}',
    version: 'agy --version', update: 'agy update',
    conversation: {kind: 'open-file', pattern: `/antigravity-cli/conversations/(${UUID})\\.db$`},
  },
  devin: {
    spawn: 'devin --model {model} --permission-mode dangerous --respect-workspace-trust false',
    resume: 'devin --model {model} --permission-mode dangerous --respect-workspace-trust false --resume {conversation}',
    version: 'devin --version', update: 'devin update',
  },
};
export const settingsWith = (runners = TABLE) => ({version: 1, revision: 1, activePreset: 'B',
  presets: {B: {roles: {}}}, runners: structuredClone(runners)});
