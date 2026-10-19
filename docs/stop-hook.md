# Stop 훅으로 완료(DONE) 판정 빠른 길

## Why

카단은 AI 창 화면 글자를 읽어 `KADAN:DONE <실행ID> <ok|failed>` 줄을 찾는다. 실행기가 업데이트될 때마다 화면 모양이 바뀌어 이 판정이 깨졌다(#57 `• ` 머리표, #180 codex 0.163 바닥글). claude·codex는 턴이 끝날 때 **Stop 훅**으로 마지막 응답 글 전체(`last_assistant_message`)를 알려 준다. 그 글에서 같은 규칙(`findDoneMarkers`)으로 마커를 읽으면 화면 모양과 상관없이 완료를 안다.

훅은 **빠른 길**일 뿐이다. 훅 증거가 없으면 지금의 화면 판정이 그대로 판정한다. 화면 판정 코드는 지우지 않았다.

표기: **[실측]** 격리 환경에서 직접 확인(2026-10-18, claude 2.1.302 / codex-cli 0.163.0). **[추정]** 확인하지 못함.

## 동작

1. 실행기가 턴을 마치면 훅 감싸개 `scripts/stop-hook.sh` → `src/stop-hook.mjs`가 stdin JSON을 받는다.
2. `KADAN_ROLE`이 없거나 `hook_event_name`이 `Stop`이 아니면 즉시 끝낸다(kyle 개인 claude·codex는 영향 없음). 항상 종료 0이며 턴을 막지 않는다.
3. **훅이 인정하는 응답 모양** — 아래를 모두 만족할 때만 `$KADAN_HOME/stop-hook-spool.jsonl`에 한 줄 `{at, role, harness, sessionId, taskId, result}`를 덧붙인다. **애매하면 기록하지 않고 화면 판정으로 넘어간다**(Markdown을 정확히 해석하지 않는다. 훅은 빠른 길일 뿐이고 화면 판정이 언제나 대체 경로다).
   - 마지막 비어 있지 않은 줄이 마커이고 **앞 공백이 없다**(뒤 공백·CR은 허용). 들여쓴 마커는 목록·인용·코드 안일 수 있어 훅으로 쓰지 않는다.
   - 응답 글에 코드 울타리(` ``` `·`~~~`)가 **하나라도 있으면** 쓰지 않는다 — 코드 블록이 들어간 응답은 화면 판정이다. 울타리를 해석하지 않으므로 인라인·짝 맞춤 예외도 없다(단일 백틱 `` `x` ``는 울타리가 아니다).
   - 같은 응답에 **같은 실행일 수 있는**(ID 끝 조각이 같고 저장소 접두가 한쪽에 없거나 같은 — `current`와 `fixture/current`는 같을 수 있고 `a/x`와 `b/x`는 섞지 않는다) 다른 결과 마커가 있으면 줄에 `conflict: true`를 붙이고, 소비처는 가장 최근 줄이 conflict일 때 훅으로 판정하지 않는다.
   - 쉽게 말해 **작업자가 맨 끝 줄에 들여쓰기 없이 마커만 쓰면 빠른 길**이고, 나머지(마커 뒤 맺음말, 목록 안 마커, 코드 블록이 들어간 응답 등)는 화면 판정이다. **응답 본문은 저장하지 않는다.** 원장에는 쓰지 않는다.
4. 소비처가 spool을 먼저 본다. 증거는 **같은 역할 · 같은 카드 · 그 카드의 마지막 발령(`send`) 뒤 시각**이어야 한다. 카드 조건 함수는 필수다(없으면 증거를 쓰지 않는다). watch·`done --from-screen`·`wait`가 같은 규칙(짧은 id·정식 주소를 같은 카드로)을 쓰고, 마지막 증거 하나만 본다. 없으면 화면 판정으로 넘어간다.
   - **화면 경로는 바꾸지 않았다(한계):** 같은 입력(코드 블록 인용 + 아직 작업 중, failed·ok 두 줄)을 화면 판정은 마지막 마커로 완료(ok)로 읽는다. 훅이 판정하지 않는 응답은 화면 경로가 지금 동작 그대로 읽는다.

| 소비처 | 훅 증거를 보는 자리 | 판정 경로 기록 |
|---|---|---|
| 감시 (`완료후보`) | `src/watch-roles.mjs` `collectRoles` | 관찰값 `doneSource` = `hook`·`screen` |
| `kadan wait` | `src/cli-wait-done.mjs` `runWaitLoop` | 원장 `done`의 `via` |
| `kadan done --from-screen` | `screenDoneResult`·`waitScreenDone` | 원장 `done`의 `via` |
| `kadan send`/`dispatch`(`cli-guarded-send.mjs`) | 바꾸지 않음. 발령 `send` 줄의 시각 `t`가 훅 증거의 기준선이 되고, 화면 기준선(`baselineMarkers`)은 그대로다 | — |

`KADAN_HOME`은 역할 프로세스에 tmux `-e KADAN_HOME=…`으로 넘어간다(현재 셸에 `KADAN_HOME`이 있을 때만). 없으면 훅과 감시기가 같은 기본 홈(`~/.kadan`)을 쓴다.

## 설치 (머지 뒤 슈퍼감독이 kyle과 함께. 이 PR은 설치하지 않는다)

### claude — 카단만 쓰는 설정 파일 하나

claude 2.1.302에는 설정 경로를 주는 환경 변수가 없다. `CLAUDE_CODE_MANAGED_SETTINGS_PATH`·`CLAUDE_CODE_REMOTE_SETTINGS_PATH`는 대화형에서 훅이 돌지 않았다 [실측]. 그래서 시작 명령에 `--settings <파일>`을 끼운다. `--setting-sources local`은 붙이지 않으므로 kyle 전역 설정은 그대로 읽힌다.

1. **main 체크아웃에서** 실행한다(설정 파일에 이 체크아웃의 `scripts/stop-hook.sh` 절대 경로가 들어간다):
   ```
   node <main 체크아웃>/src/cli.mjs stop-hook claude-settings
   ```
2. 만들어지는 곳: `$KADAN_HOME/stop-hook/claude-settings.json` (기본 `~/.kadan/stop-hook/claude-settings.json`). 사용자 전역 `~/.claude/settings*.json`은 고치지 않는다.
3. 훅 명령과 `--settings` 값은 같은 셸 인용 함수(`shellQuote`)로 만든다: 작은따옴표가 없으면 `'…'`, 있으면 `"…"`, 둘 다 안전하게 못 쓰면(`$`·백틱·`\`·`"`와 `'` 동시) 설정 파일 생성이 거절되고, 이미 만든 뒤 경로가 바뀌어 붙일 수 없으면 `kadan start`가 `경고: Stop 훅을 붙이지 못했다(…)`를 낸다(조용히 빠지지 않는다).
4. 이 파일이 있을 때만, 새로 띄우는 claude 역할 명령의 실행 파일 바로 뒤에 `--settings '<파일>'`이 붙는다(`kadan start --cmd`, 실행 모델 설정 기본 명령, `kadan restart`). **이미 떠 있는 역할은 다음 start·restart부터** 적용된다. 사람이 이미 `--settings`를 준 명령에는 붙이지 않는다.
5. 확인: `node <main 체크아웃>/src/cli.mjs stop-hook status`. 역할의 실제 실행 인자는 `ps`에서 `--settings`로 보인다.
6. 되돌리기: 설정 파일을 `.trash/`로 옮긴다. 이후 새로 띄우는 역할부터 붙지 않는다(이미 떠 있는 역할은 훅이 계속 돌지만 spool만 늘 뿐 해롭지 않다).

신원·재시작 비교(`withoutInlineScreen`)는 카단이 붙인 `--settings <우리 파일>`을 걷어내고 비교한다. 모델 다름은 거절, 강도 다름은 경고 그대로다(시험: `tests/stop-hook.test.mjs`, `tests/dispatch-runner-guard.test.mjs`).

### codex — 전역 hooks.json 한 항목 + kyle이 한 번 신뢰

카단 코드는 codex 명령에 훅 플래그를 붙이지 않는다(`--dangerously-bypass-hook-trust`·`-c` 주입 없음).

1. `~/.codex/hooks.json`의 `hooks.Stop` 배열 **맨 끝에 새 그룹으로** 아래 조각을 더한다(기존 memory-core 그룹은 그대로 둔다):
   ```json
   {
     "hooks": [
       {
         "type": "command",
         "command": "/bin/sh '<main 체크아웃>/scripts/stop-hook.sh'",
         "timeout": 10
       }
     ]
   }
   ```
   `<main 체크아웃>`은 절대 경로다. 명령 문자열은 한 글자도 바꾸지 않는다(아래 신뢰 조건). 정확한 문자열은 `kadan stop-hook status`의 `codex에 넣을 명령:` 줄에 나온다.
2. 신뢰 항목의 이름은 **그룹 번호와 훅 번호 둘**이다: `<hooks.json 절대경로>:stop:<그룹>:<훅>`. 위처럼 배열 끝에 새 그룹으로 붙이면, 기존 그룹이 하나일 때 `…/hooks.json:stop:1:0`이다(`stop:0:1`이 아니다). 앞 순서를 바꾸면 번호가 바뀐다. 카단 감시기는 hooks.json을 읽어 번호를 스스로 찾는다.
3. 다음에 codex를 열면(카단 역할이어도, kyle 개인 창이어도) 시작 때 이 화면이 뜬다 [실측]:
   ```
   Hooks need review
   1 hook is new or changed.
   Hooks can run outside the sandbox after you trust them.
   › 1. Review hooks
     2. Trust all and continue
     3. Continue without trusting (hooks won't run)
   ```
   - `1. Review hooks` → 이벤트 표(`Stop  1 installed / 0 active / 1 review`) → `Enter` → 훅 상세(Event `Stop`, Source `User config - …/hooks.json`, Command, Mode `Sync`, Timeout `10s`, Trust `New hook - review required`).
   - 상세 화면에서 **`t`** 를 누르면 `Trust  Trusted`가 되고 `config.toml`에 `[hooks.state."…/hooks.json:stop:1:0"]`과 `trusted_hash = "sha256:…"`이 기록된다.
   - 한 번 신뢰하면 다음 시작부터 묻지 않는다. `2. Trust all and continue`는 **그 순간 검토 대기 중인 모든 훅**을 신뢰하므로 다른 새 훅이 섞여 있으면 쓰지 않는다.
4. 확인: `node <main 체크아웃>/src/cli.mjs stop-hook status`에서 `codex 훅 … trusted`.
5. 되돌리기: `hooks.json`에서 그 그룹을 지운다(`config.toml`의 `[hooks.state."…:stop:1:0"]` 항목은 남아도 쓰이지 않는다. 지우려면 kyle이 직접).

### 신뢰가 풀리는 조건 [실측]

| 바꾼 것 | 결과 |
|---|---|
| 스크립트 **파일 내용**(`stop-hook.sh`·`stop-hook.mjs` 수정) | 신뢰 유지. 재시작 때 검토 화면이 안 뜨고 `trusted_hash`도 그대로, 훅이 계속 돈다. 레포를 고쳐도 신뢰가 풀리지 않는다 |
| hooks.json의 **명령 문자열**(공백 한 칸 포함) | 다음 시작에 `Hooks need review`가 다시 뜬다. **그 시점 `config.toml`은 한 글자도 안 바뀌어 있다**(옛 `trusted_hash`가 그대로 남음) |

그래서 감시기는 '우리 순번의 항목이 있는가'까지만 읽을 수 있고 해시가 현재 명령과 맞는지는 알 수 없다. 해시를 계산하거나 비교하는 코드는 일부러 만들지 않았다. 명령 문자열이 바뀐 뒤 신뢰가 풀린 것은 **codex 화면의 검토 요청**으로만 드러난다. 그동안 훅은 돌지 않고 spool에 증거가 안 쌓이므로 화면 판정이 판정한다.

### 감시기 알림

claude 설정 파일이 있는 기계(= 이 빠른 길을 켠 기계)에서만, codex 훅이 `trusted`가 아니면 감시기가 사용자(`@user`)에게 `훅신뢰` 경보를 낸다(상태가 같으면 한 번). 상태: `no-hooks-file`·`unreadable`·`not-installed`·`other-path`(다른 체크아웃 경로의 훅만 있음)·`untrusted`·`unknown`(config.toml 표기를 해석할 수 없거나 명령을 안전하게 인용할 수 없음 — 미신뢰로 단정하지 않고 문구를 구분한다). `[hooks.state]` 헤더는 큰따옴표·작은따옴표 키, 점 주변 공백, 줄 끝 주석을 같은 키로 읽는다. 읽기만 하며 `trusted_hash`를 쓰거나 설정 내용을 기록하지 않는다.

## 압축 뒤 현재 카드 재안내 (2026-10-19)

Why: 대화가 압축되면 현재 실행 주소가 대체 대화에서 빠져 작업자가 규칙 수락 답변만 하고 멈춘 사고(retire_ooo, exec-2ef4e2fc 실측). 새 훅 등록 없이 기존 Stop 훅이 압축 직후 첫 응답에서 주소를 한 번 알린다.

`src/stop-hook-context.mjs`의 `compactReminder`가 아래 순서로 판단한다. 재안내(`{"decision":"block","reason":"…`kadan card show <저장소/실행ID>`…"}`, 종료 0)는 **모두** 통과할 때만 나가고, 어느 하나라도 실패·모호하면 출력 없이 통과한다(fail-open).

1. `KADAN_ROLE`이 없으면 아무것도 읽거나 쓰지 않고 끝난다(개인 실행기). `stop_hook_active`가 true이면 끝난다. 이 둘에서는 기회를 소모하지 않는다.
2. `transcript_path`(절대경로) 끝 256KB에서 마지막 압축 경계를 읽는다 — claude `system/compact_boundary`(uuid), codex `compacted`(window_id). 없거나 모호하면 끝.
3. **새 경계를 처음 본 Stop에서 결과와 무관하게 기회를 소모한다**: `$KADAN_HOME/stop-hook/compact-reminders/<역할·세션·경계 지문>.json`을 배타적(`wx`)으로 만든다. 이미 있거나 만들 수 없으면 끝. 그래서 압축 한 번에 기회는 한 번이다(마커·답 대기·대상 없음이어도 같다).
4. 이번 응답에 DONE 마커가 있으면 끝. 경계가 30분보다 오래됐으면 끝(훅을 처음 켠 세션의 옛 압축).
5. 이 역할의 미완료 실행을 `buildWatchScope`로 구한다(닫힌 업무·이전 세대·`waiting` 활동 제외)에 더해 열린 질문(`hasOpenQuestion`)이 붙은 실행을 뺀다. 실행이 여럿이면 하나의 안내에 모두 적는다. 없으면 끝.
   - **사용자 결정 답 대기 제외**: 감시기와 같은 `DecisionStore`의 열린(`open`) 결정이 이 역할의 실행 카드 또는 그 실행이 속한 업무에 연결돼 있으면 통과한다(실행이 여럿이면 하나만 걸려도 통째로 통과). 결정 저장소를 못 읽어도 통과한다.
6. **담당 세션 확인**: 안내할 실행이 있을 때 `ps`를 한 번 불러 훅 프로세스의 부모 사슬을 원장 `start`의 pane PID(`panePid`, 바닥이 tmux일 때만)와 비교한다. 작업자가 띄운 시험용 claude·codex는 `KADAN_ROLE`을 물려받기 때문에 이름만으로는 담당 세션과 가를 수 없다.
   - 훅 사슬은 `node 훅 → sh 감싸개 → 실행기 → pane`이다. 감싸개 셸(`sh`·`bash`·`zsh`·`dash`·`env`)을 건너뛴 첫 조상이 실행기다. claude는 실행기가 곧 pane(`실행기 PID == panePid`), codex는 실행기(vendor 바이너리)의 부모가 pane이고 pane 명령이 `node`(npm 실행 파일)다.
   - 자식 CLI는 도구 셸이 끼어 부모가 pane이 아니거나, 도구 셸이 exec로 바로 띄운 claude처럼 pane이 `node` 실행 파일이 아닌 경우라서 걸러진다.
   - 확인 못 하면 통과한다: `ps` 실패·시간 초과, 사슬 8단 초과, pane PID 기록 없음, 바닥이 herdr 등.
7. 원장 조회는 자식 프로세스(`stop-hook-context.mjs lookup <역할>`)에서 **3초** 제한(`LOOKUP_MS`), 잠금 대기는 0.8초(`KADAN_BUSY_TIMEOUT_MS`, 기본 15초)다. 동기 SQLite 호출은 중간에 끊을 수 없어 프로세스째 죽인다. 시간 초과·오류·이상한 출력은 빈 결과로 본다. 자식은 `{keys, panePid}`를 돌려준다. `ps` 조회 상한은 1초다. 시험만 환경값 `KADAN_HOOK_TIMEOUT_MS`로 두 상한을 키운다(높은 부하에서 실제 훅 프로세스 시험이 흔들리지 않게).

마지막 압축 기록은 확실할 때만 쓴다. 꼬리 읽기 범위의 **첫 줄**(잘린 줄)은 건너뛰지만, 읽을 수 없는 **다른 줄**이 경계 낱말(`compacted`·`compact_boundary`)을 담았거나 줄바꿈 없이 끝난 마지막 줄이면 마지막 경계를 확정할 수 없다고 보고 앞 경계로 대신하지 않고 통과한다. 경계 낱말이 없는 손상 줄은 건너뛴다.

원장에는 쓰지 않는다. 안내 문구에 완성된 DONE 마커는 넣지 않는다. 시간 상한 근거(2026-10-19, 운영 원장 5.6만 줄·부하 약 20, 읽기 전용): 자식 조회 전체 1.9~2.9초(원장 읽기 0.45~0.98초가 대부분, 카드 요약 0.15초). 카드가 제안한 1초로는 거의 항상 포기해 기능이 사실상 꺼지므로 3초로 두었다. 한계: 상위 감독 역할 제외는 하지 않는다(parents 없이 계산). 감시 우편 대비책은 이 변경에 없다. 남은 한계(고치지 않음): 경계 신선도 기준이 30분이라 압축 뒤 첫 장시간 작업이 30분을 넘으면 놓친다, 꼬리 256KB 밖으로 밀린 경계는 못 본다, `compact-reminders/` once 파일은 경계마다 78바이트씩 늘고 정리 코드가 없다(생성 때 7일 넘은 파일을 지우는 정도가 필요하면 별도 변경으로). 실제 압축 뒤 모델이 `card show`를 실행하는 격리 종단 시험은 이 문서 작성 시점에 하지 않았다. 시험: `tests/stop-hook-context.test.mjs`.

## 실측 요약과 한계

- codex 인증 관문 [실측]: 격리 `CODEX_HOME`에 `config.toml`만 두고(인증 파일 복사 없음) 최상단 `model_provider = "ocxlocal"` + `[model_providers.ocxlocal]`(`base_url`=ocx 로컬 프록시, `wire_api="responses"`, `requires_openai_auth=false`)로 대화형 TUI가 로그인 화면 없이 떴다. `model_provider`를 `[tui]` 아래에 두면 무시된다.
- 대화형 TUI에서 훅이 돈다 [실측]: claude(`--settings`), codex(`--no-alt-screen`, 신뢰된 전역 Stop 훅). 두 경우 모두 `KADAN_ROLE`이 훅 프로세스에 전달됐다.
- 긴 응답 [실측, claude만]: 1~1600 숫자 + 끝 마커, `last_assistant_message` 6917자가 **잘리지 않고** 끝 마커까지 있었다. codex 긴 응답 잘림은 **미확인**이다.
- 훅은 한도(429)·끊김·승인 대기·입력 큐 배너·정체를 대체하지 못한다. 그것들은 화면 판정 그대로다.
- 턴이 끝났는데 마커가 없으면 훅 증거도 없다. 지금처럼 화면 정체·`완료후보` 경로가 잡는다.
- 마커를 응답 글에 쓰는 약속(작업자 계약)은 그대로다. **마커 뒤에 맺음말을 붙이면 훅 빠른 길이 아니라 화면 판정으로 간다**(마지막 줄이 마커가 아니므로).
- 훅은 현재 실행을 모르므로 기록 단계의 상충 판정은 보수적이다(같은 실행일 수 있으면 상충). 최종 판정은 소비처(`hookTaskMatcher`)가 현재 실행 기준으로 한다.
- 실행기를 바꿔 훅 입력 키(`turn_id`·`prompt_id`)가 달라지면 `harness`가 `unknown`으로 적힐 뿐 판정에는 영향이 없다.
