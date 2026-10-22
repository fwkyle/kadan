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

## 2라운드: `readStream` 한 줄씩 해석 (2026-10-22)
- 바꾼 곳: `src/storage.mjs` `readStream`의 SQLite 경로만. `.all()`로 원문 문자열 배열을 만든 뒤 `map(JSON.parse)`하던 것을 `.iterate()`로 한 줄씩 해석한다.
  읽는 사건·순서·`slim`·`기록 없음` 오류·JSONL 경로는 그대로다.
- 실측(격리 사본, 한 주기에 해당하는 `readLedger` 1번): footprint 367MB → 286MB(-22%), heapUsed 215 → 147MB. 1라운드의 단순 비교(586 → 408MB)와 같은 방향이다.
- 같은 모양의 `.all()`: `listStreams`(`src/storage.mjs`, `heads` 표 이름만 읽음, 작음). 이번에는 바꾸지 않았다.

## 최근 구간 읽기 설계 쟁점 (사실만, 결론 없음)
감시기는 주기마다 `readLedger()` 전체(약 6.7만 개)를 받아 판정 함수들에 그대로 넘긴다(`src/commands/watch.mjs`의 `cycleReads`). 아래는 각 판정이 원장을 **어디까지 거슬러 보는지**다.

| 판정 | 필요한 가장 오래된 시점 | 근거 |
|---|---|---|
| 미완료 발령(send~done) | 그 발령의 send. 카드가 assigned로 남아 있는 동안은 며칠이어도 필요 | `watch-scope.mjs:11~17` `pending` 맵을 전체 사건에서 만듦 |
| 역할 세대(이름 재사용) | 그 역할의 첫 start부터(경계 목록 전체) | `owner-generation.mjs:6`, `mail-generation.mjs` `createMailGenerations`; `watch-scope.mjs:19·46·86`, `watch-supervisor.mjs:166` |
| 현재 세대의 발령 목록·확정 결과·인계 | 현재 세대 start 이후. 세대가 오래 이어지면 그만큼 거슬러 감 | `watch-roles.mjs:63~110` 전체 순회로 `dispatches` 구성 |
| 마지막 start(프로필·PID) | 세션별 마지막 start 한 건 | `watch-roles.mjs:26~38` `latestStarts`, `watch-mail.mjs:123` |
| 미확인 우편·재알림 상태 | 우편 send부터(읽음 안 한 동안), 재알림 기록 전체 | `watch-mail.mjs:69~125` `eligibleLetters`, `reminderHistory`(`:46`) |
| 우편 세대 | 받는 이름의 start 경계 | `mail-generation.mjs`(우편함 조회 `mailboxLetters`) |
| 경보 복원(재시작 직후) | 경보 id별 마지막 기록. 해소 안 된 것이 있으면 그 경보가 처음 울린 시점 | `watch-alert-body.mjs:192` `seedAlertState` |
| 시작보고누락 중복 거르기 | `start-report:` 경보의 마지막 기록 | `watch-start-report.mjs:7` |
| 한도 경보 복원·429 재개 | 그 경보 뒤 `ocx-refresh`, 같은 키 `rate-limit-retry` 이력 | `watch-runner.mjs:613~626`, `watch-rate-limit.mjs:36·44·46` |
| 큐 재개 | 같은 키 `queue-resume` 이력 | `watch-queue-resume.mjs:43·65` |
| 감독 정기 확인 | 같은 감독의 마지막 `watch-ai-request` | `watch-supervisor-health.mjs:65` |
| 감시기 상태 표시 | `watch-cycle` 기록, 기본 24시간 창 | `watch-cycle.mjs:54~57` |
| 놀고 있음 계획·끝난 실행 | 카드 센터가 쓰는 발령·done·stop(카드 상태와 함께) | `watch-supervisor.mjs:42` `endedExecutionKeys`, `:231~242` |

- 구간 밖으로 밀리면 틀어지는 것(코드로 본 사실): 며칠 지난 발령은 send가 구간 밖이면 `pending`에 없어 미완료로 보이지 않고, `isPreviousOwner`는 세대 경계(start 목록)가 잘리면 판정이 달라질 수 있고(추정, 시험으로 확인하지 않음), 오래 안 읽은 우편은 `send`가 밖이면 재알림 대상에서 빠진다.
- 가능한 방향(장단점만):
  - 시간 구간 + 열린 일 고정 목록: 구현이 단순하지만, 목록에 넣을 열린 일의 정의(발령·우편·결정·세대 경계)를 판정마다 맞춰야 한다.
  - 증분 읽기 + 상태 스냅샷: 읽는 양이 가장 적지만 스냅샷과 원장이 어긋났을 때 복구 규칙이 새로 필요하다.
  - `heads`(stream별 마지막 사건) 활용: 마지막 값만 필요한 판정(마지막 start 등)에는 맞지만 이력 판정에는 못 쓴다.
- 운영 원장(11:16 `.backup` 사본, 기준 시각 2026-10-22 11:20 KST)에서 가장 오래 열린 일: 미완료 발령 117건(send 뒤 done 없음) 중 가장 오래된 것은 52.1일(`c21/card-21-demo`, 시험용 이름으로 보임. 이 목록은 카드 assigned 여부를 거르지 않은 원장 기준이다), 열린 업무 11건 중 가장 오래된 것은 3.6일, 열린 결정은 0건(마지막 revision 기준), 읽음 기록 없는 답 기대 우편은 0건(208건 중). 우편의 가장 오래된 답 기대 우편은 2026-09-17(35일 전, 모두 읽음 처리됨).
