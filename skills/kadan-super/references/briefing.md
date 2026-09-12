# 시작 브리핑 루프

## Why

정상 판을 다시 해석하느라 토큰을 쓰지 않고, 감시 공백·죽음·자원 압박처럼 전체
운영에 영향을 주는 사실부터 같은 순서로 확인한다.

## 순서

| 순서 | 명령 | 이상으로 보는 것 |
|---|---|---|
| watch 생존 | `pgrep -x kadan-watch` | PID 0개 또는 2개 이상 |
| 전체 계층 | `kadan tree` | 죽음, PID 변경, 완료 없는 오래된 카드 |
| 역할 생존 | `kadan status` | 세션 소실, `PID변경`, 예상 밖 역할 |
| 자원 | `memory_pressure -Q` | watch가 보고한 warning·critical과 원문 불일치 |
| 자원 | `sysctl vm.swapusage` | watch가 보고한 스왑 연속 증가 |
| 자원 | `sysctl -n vm.loadavg`와 `sysctl -n hw.ncpu` | 5분 평균이 CPU 수보다 큼 |
| 미해결 이상 | `kadan read <수신자> --lines 30` | 알림은 있으나 조치·회복 증거 없음 |
| 이력 | `kadan log` | 완료 통지와 현재 실행·결과·완료 기록의 불일치 |

## 실행

1. `pgrep -x kadan-watch`가 비면 `references/watch-ops.md`의 현재 승인 명령으로
   별도 터미널에서 재가동한다. 재가동 뒤 원인을 본다.
2. `kadan tree`, `kadan status`로 판·역할·카드와 PID를 대조한다.
3. 자원 원문은 메모리 → 스왑 → CPU 순서로 읽는다.
4. 미해결 이상·결과 불일치가 있을 때만 watch 출력의 `→ <수신자>`와 필요한 화면·결과를 대조한다.
   정상 전달을 확인하려고 `read`를 덧붙이지 않는다. [전달 후 확인 범위](../../kadan-conductor/references/dispatch-wait.md#전달-후-확인의-범위)를 따른다.
5. 사용자의 최신 목표·우선순위·금지선과 현재 사실이 충돌하는지 확인한다.
6. 정상이면 침묵한다. 결정·반복 실패·치명 오류·전체 완료만 보고한다.

판 상태를 스피너·제목으로 추정하지 않는다. 화면과 원장·PID의 실제 값만 근거로 쓴다.
