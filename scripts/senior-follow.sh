#!/bin/bash
# Why: kyle이 시니어가 무엇을 읽고 어떻게 고민하는지 로티 탭에서 따라 보게 한다(2026-10-16 [kyle]).
# 읽기 전용이다: 입력을 받지 않고 호출 폴더의 diagnostic.log를 따라 보여 줄 뿐이다.
# 끝나는 때: exit-code.txt가 생기거나, 부모(kadan senior) 프로세스가 사라질 때. TERM으로 죽은 kadan senior는
# exit-code.txt를 남기지 않으므로 부모 확인이 없으면 탭이 영원히 남는다.
set -u
advice_dir=${1:?사용: senior-follow.sh <호출 폴더> <부모 PID>}
parent_pid=${2:?사용: senior-follow.sh <호출 폴더> <부모 PID>}
[[ "$parent_pid" =~ ^[0-9]+$ ]] || { echo "부모 PID 형식 오류: $parent_pid" >&2; exit 2; }
[[ -d "$advice_dir" ]] || { echo "호출 폴더가 없다: $advice_dir" >&2; exit 2; }
interval=${KADAN_SENIOR_FOLLOW_INTERVAL:-0.5}
log="$advice_dir/diagnostic.log"
echo "시니어 진행 따라 보기 (읽기 전용): $log"
tail -n +1 -F "$log" 2>/dev/null &
tail_pid=$!
trap 'kill "$tail_pid" 2>/dev/null || true' EXIT
trap 'exit 143' TERM INT HUP
reason=""
while :; do
  if [[ -f "$advice_dir/exit-code.txt" ]]; then reason="done"; break; fi
  if ! kill -0 "$parent_pid" 2>/dev/null; then reason="parent-gone"; break; fi
  sleep "$interval"
done
# 마지막 출력이 화면에 닿을 시간을 잠깐 준 뒤 tail을 끈다.
sleep "$interval"
kill "$tail_pid" 2>/dev/null || true
wait "$tail_pid" 2>/dev/null || true
echo
if [[ "$reason" == "done" ]]; then
  echo "시니어 호출 끝: 종료 코드 $(tr -d '[:space:]' <"$advice_dir/exit-code.txt"), 답변: $advice_dir/result.txt"
else
  echo "시니어 호출이 끝나기 전에 kadan senior가 사라졌다(신호 등). 진단: $log"
fi
