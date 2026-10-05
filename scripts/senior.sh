#!/bin/bash
# Why: 시니어는 작업 결과에 결정할 부분이 있을 때 감독이 고급 모델에게 의견을 한 번 묻는 일회성 호출이다(2026-10-05 [kyle] 승인).
# 카드의 저장소 폴더에서 읽기 전용으로 돌려 저장소 문맥(AGENTS.md·파일·이력)을 스스로 읽는다 — 슈퍼감독이
# 저장소 문맥을 들고 있을 필요가 없게. stdout은 답변 본문이고, 판정·결정에 쓰지 않는다.
set -euo pipefail
umask 077
advice_dir=${KADAN_SENIOR_DIR:?kadan senior가 만든 호출 폴더가 필요합니다}
advice_repo=${KADAN_SENIOR_REPO:?카드의 저장소 경로(KADAN_SENIOR_REPO)가 필요합니다}
advice_model=${KADAN_SENIOR_MODEL:?시니어 모델을 KADAN_SENIOR_MODEL로 지정해야 합니다 (기본값 없음)}
advice_effort=${KADAN_SENIOR_EFFORT:-max}
[[ "$advice_effort" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "KADAN_SENIOR_EFFORT 형식 오류: $advice_effort" >&2; exit 2; }
# Codex 0.154+는 심볼릭 링크가 낀 루트를 거부한다(watch-judge.sh와 같은 이유). 실제 경로로 풀어서 넘긴다.
advice_dir=$(cd "$advice_dir" && pwd -P)
advice_repo=$(cd "$advice_repo" && pwd -P)
printf 'KADAN_SENIOR_LOG_DIR=%s\nKADAN_SENIOR_MODEL=%s\nKADAN_SENIOR_EFFORT=%s\nKADAN_SENIOR_REPO=%s\n' "$advice_dir" "$advice_model" "$advice_effort" "$advice_repo" >&2
cat >"$advice_dir/input.txt"
printf '%s\n' "$advice_model" >"$advice_dir/model.txt"
advice_status=0
# 저장소는 읽기만 한다. 감시 AI와 달리 project_doc_max_bytes를 0으로 두지 않아 저장소의 에이전트 안내를 읽는다.
# AGENTS.md가 없고 CLAUDE.md만 있는 저장소도 안내를 읽게 대체 이름을 명시한다. 사용자 codex 설정에 기대지 않는다
# (2026-10-05 실측: 이 설정으로 AGENTS.md 없는 시험 저장소의 CLAUDE.md 내용을 답했다).
codex -a never exec --model "$advice_model" -c "model_reasoning_effort=\"$advice_effort\"" -c 'project_doc_fallback_filenames=["CLAUDE.md",".agents.md"]' -C "$advice_repo" --sandbox read-only --skip-git-repo-check -o "$advice_dir/result.txt" <"$advice_dir/input.txt" >"$advice_dir/diagnostic.log" 2>&1 &
advice_pid=$!
trap 'kill -TERM "$advice_pid" 2>/dev/null || true; exit 143' TERM INT
wait "$advice_pid" || advice_status=$?
printf '%s\n' "$advice_status" >"$advice_dir/exit-code.txt"
if [[ -f "$advice_dir/result.txt" ]]; then cat "$advice_dir/result.txt"; fi
# 입력·답변·진단은 증거로 보존한다. 자동 삭제하지 않는다.
exit "$advice_status"
