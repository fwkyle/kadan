#!/bin/bash
# Why: 감시AI가 watch-report로 직접 기록·보고한다. stdout은 판정에 쓰지 않는다.
set -euo pipefail
umask 077
judge_dir=${KADAN_JUDGE_DIR:?감시sh가 만든 호출 폴더가 필요합니다}
judge_home=${KADAN_HOME:-${KADAN_LITE_HOME:?카단 데이터 폴더(KADAN_HOME)가 필요합니다}}
judge_model=${KADAN_JUDGE_MODEL:?감시AI 모델을 KADAN_JUDGE_MODEL로 지정해야 합니다 (기본값 없음)}
# 강도는 실행 모델 설정의 감시 AI 값이 채운다. 프로필만 쓰는 예전 방식은 max 그대로다.
judge_effort=${KADAN_JUDGE_EFFORT:-max}
[[ "$judge_effort" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "KADAN_JUDGE_EFFORT 형식 오류: $judge_effort" >&2; exit 2; }
# Codex 0.154+는 심볼릭 링크가 낀 쓰기 루트를 거부한다(~/.kadan -> ~/.kadan-lite 링크 때문에 2026-09-12 21:56부터
# 감독 관찰AI 호출 5회 전부 실패). 실제 경로로 풀어서 넘긴다. 폴더가 없으면 아래 :? 검사와 같이 멈춘다.
judge_dir=$(cd "$judge_dir" && pwd -P)
judge_home=$(cd "$judge_home" && pwd -P)
printf 'KADAN_JUDGE_LOG_DIR=%s\nKADAN_JUDGE_MODEL=%s\nKADAN_JUDGE_EFFORT=%s\n' "$judge_dir" "$judge_model" "$judge_effort" >&2
cat >"$judge_dir/input.txt"
printf '%s\n' "$judge_model" >"$judge_dir/model.txt"
judge_status=0
# 보고 명령의 원장 쓰기·로컬 tmux 통신을 허용한다. 제품 작업 폴더는 쓰기 범위에 넣지 않는다.
codex -a never exec --model "$judge_model" -c "model_reasoning_effort=\"$judge_effort\"" -c project_doc_max_bytes=0 -c sandbox_workspace_write.network_access=true -C "$judge_dir" --sandbox workspace-write --add-dir "$judge_home" --skip-git-repo-check -o "$judge_dir/result.txt" <"$judge_dir/input.txt" >"$judge_dir/diagnostic.log" 2>&1 &
judge_pid=$!
trap 'kill -TERM "$judge_pid" 2>/dev/null || true; exit 143' TERM INT
wait "$judge_pid" || judge_status=$?
printf '%s\n' "$judge_status" >"$judge_dir/exit-code.txt"
# 인터넷이 없어 공급자 주소를 못 찾은 실패는 따로 표시한다(2026-10-07: 맥북 잠자기 중 잠깐 깨어 부른 호출). 감시기는 알림 없이
# 다음 정기 점검에 다시 부른다. 아래 문구가 분명할 때만 표시하고, 그 밖의 실패는 호출 실패 그대로 둔다.
if [[ "$judge_status" != 0 ]] && grep -qE 'getaddrinfo (ENOTFOUND|EAI_AGAIN)|Provider unreachable|ENETUNREACH|ENETDOWN|EHOSTUNREACH' "$judge_dir/diagnostic.log"; then
  echo 'KADAN_JUDGE_NETWORK=1' >&2
fi
if [[ -f "$judge_dir/result.txt" ]]; then cat "$judge_dir/result.txt"; fi
# 결과와 진단은 임시 증거로 보존한다. 자동 삭제하지 않는다.
exit "$judge_status"
