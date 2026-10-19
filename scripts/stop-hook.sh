#!/bin/sh
# Stop 훅 감싸개 — 실행기(claude·codex)가 턴을 마칠 때 부른다. 명령 문자열을 고정하려고 이 파일을 거친다
# (codex는 훅 명령이 바뀌면 신뢰를 다시 묻는다. 2026-10-18 실측: 스크립트 내용만 바뀌면 신뢰는 유지된다).
# 훅 환경의 PATH에는 node가 없을 수 있어 흔한 위치를 찾아본다. 어떤 경우에도 종료 0 — 실행기의 턴을 막지 않는다.
here=$(cd "$(dirname "$0")" && pwd)
node_bin=$(command -v node 2>/dev/null)
if [ -z "$node_bin" ]; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$candidate" ] && node_bin=$candidate
  done
fi
[ -n "$node_bin" ] && "$node_bin" "$here/../src/stop-hook.mjs"
exit 0
