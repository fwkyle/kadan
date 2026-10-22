# 감시기 메모리 — 기준선과 증가 조사 (2026-10-22)

## Why
감시기가 오래 켜져 있으면 맥이 무거워진다고 느껴져 원인을 확인했다. 결론부터: **자바스크립트 힙은 시간이 지나도 늘지 않는다.**
무거움의 정체는 주기마다 원장 전체를 읽는 일의 한 번 비용(기준선)이다.

## 측정 (실측과 추정 구분)
- 실측: 운영 원장에 5분마다 남는 `watch-cycle.timing.memoryMb.heapUsed`를 감시기 21번(최대 114시간)의 수명 동안 회귀했다.
  - 힙 기울기는 -31 ~ +23 MB/h로 부호가 섞여 있고 긴 수명(30~114시간)은 -1.2 ~ +0.5 MB/h다. 한 방향 증가가 없다.
  - 힙은 150~200MB(바닥)와 500~1200MB(주기 중 정점) 사이를 톱니로 오간다.
- 실측: 격리 사본에서 원장 전체를 한 번 읽으면 읽은 뒤 남는 힙은 약 80MB(사건 66,953개)지만 footprint는 314MB까지 오르고 놓은 뒤에도 내려가지 않는다.
  `node --max-old-space-size=256`으로 힙 상한을 낮춰도 footprint는 줄지 않았다(357MB).
- 실측: 같은 원장을 `.all()`로 읽으면 footprint 586MB, `.iterate()`로 읽으면 408MB(약 30% 적음, 읽는 사건 수는 같음).
- 추정(근거 약함): 슈퍼감독이 본 시간당 120~190MB 증가는 두 점 비교다. 힙이 아니라 정점 사용 뒤 macOS가 압축·보관한 쪽(footprint 고수준, RSS 28MB)으로 보인다. 이 부분은 직접 확인하지 못했다.

## 의심 목록 (감시 모듈의 주기 사이 보관 자료)
| 자료구조 | 키 | 상한 | 근거 |
|---|---|---|---|
| NotifyHoldTracker.streaks / heldNow / sentNow / forcedNow | 역할 | 있음(연속 구간이 끝나면 지움, 주기마다 새로 만듦) | `watch-notify-hold.mjs` endCycle |
| SupervisorHealth.states | 세션 | 있음(범위 밖 세션 삭제) | `watch-supervisor-health.mjs` select 첫 줄 |
| runner `workerChecks`·`judgeFailures`·`offlineFailures` | 세션·작업 | 있음(관찰 밖 세션 삭제) | `watch-runner.mjs` 314~325줄 |
| runner `userPosts` | 경보 id | 있음(해소 때 삭제) | `watch-runner.mjs` 801~803줄 |
| runner `pendingCompletions`·`queuedAI`·`pendingNudges`·`pendingAlerts`·`deliveryFailures` | 경보·역할 | 있음(현재 경보에 없으면 삭제) | 같은 파일 |
| runner `restoredChecked` | 한도 경보 id | 없음, 증가량 무시 가능(경보 id 문자열 수십 바이트, 한도 경보 수에 비례) | `watch-runner.mjs` 613~626줄 |
| MailWatch `reserved`·`attempted`·`written`·`heldLogged` | 우편·역할·단계 | 없음, 증가량 무시 가능(우편 수에 비례, 수 KB) | `watch-mail.mjs` 135~143줄 |
| cycleReads 캐시 | 읽기 이름 | 있음(주기 시작·끝에 비움) | `watch-reads.mjs` |
| watch-call-process 자식 출력 | — | 별도 짧은 프로세스(감시기 안에 쌓이지 않음) | `watch-call-process.mjs` |

주기마다 만드는 지역 `Map`·`Set`·배열은 주기가 끝나면 놓인다.

## 결론
- 증가(누수): 힙에서 확인되지 않았다. 고칠 보존·축출 결함이 없어 코드는 바꾸지 않았다. 회귀 방지 시험만 추가했다(`tests/watch-memory.test.mjs`, 주기 횟수 기준).
- 기준선: 주기마다 원장 전체를 읽고 파싱하는 한 번의 비용이다. 순수 낭비(읽는 범위는 그대로)는 감시 모듈 밖 `src/storage.mjs`의 `readStream`에 있다(원문 문자열 배열 `.all()` + 파싱 객체 동시 보유).
  이를 `.iterate()`로 바꾸면 정점이 약 30% 준다. 또한 원장 전체 대신 최근 구간·증분 읽기는 읽는 범위가 바뀌므로 kyle 결정이다.
