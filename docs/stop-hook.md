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

`src/stop-hook-context.mjs`의 `compactReminder`가 아래를 **모두** 만족할 때만 `{"decision":"block","reason":"…`kadan card show <저장소/실행ID>`…"}`를 출력한다(종료 0). 어느 하나라도 실패·모호하면 출력 없이 통과한다.

1. `KADAN_ROLE`이 있다(개인 실행기는 여기서 끝). 가장 먼저 본다.
2. `stop_hook_active`가 true가 아니다.
3. 이번 응답에 DONE 마커가 없다.
4. `transcript_path`(절대경로) 끝 256KB에서 마지막 압축 경계를 읽었다 — claude `system/compact_boundary`(uuid), codex `compacted`(window_id) — 그리고 30분 안이다(훅을 처음 켠 세션의 옛 압축 제외).
5. 그 경계로 아직 안내한 적이 없다: `$KADAN_HOME/stop-hook/compact-reminders/<역할·세션·경계 지문>.json`.
6. 이 역할의 미완료 실행이 `buildWatchScope` 기준으로 **정확히 하나**다(질문 대기·닫힌 업무·이전 세대는 그 함수가 뺀다). 원장 읽기 대기는 1초(`KADAN_BUSY_TIMEOUT_MS`, 기본 15초)다.
7. 위 파일을 배타적으로(`wx`) 만들었다. 실패·경합이면 보내지 않는다.

원장에는 쓰지 않는다. 한계: "압축 직후 첫 턴"은 경계당 1회 선점과 30분 신선도로 근사한다(경계 뒤 첫 Stop 여부를 직접 세지 않는다). 상위 감독 역할 제외는 하지 않는다(parents 없이 계산). 감시 우편 대비책은 이 변경에 없다. 실제 압축 뒤 모델이 `card show`를 실행하는 종단 시험은 하지 않았다. 시험: `tests/stop-hook-context.test.mjs`.

## 실측 요약과 한계

- codex 인증 관문 [실측]: 격리 `CODEX_HOME`에 `config.toml`만 두고(인증 파일 복사 없음) 최상단 `model_provider = "ocxlocal"` + `[model_providers.ocxlocal]`(`base_url`=ocx 로컬 프록시, `wire_api="responses"`, `requires_openai_auth=false`)로 대화형 TUI가 로그인 화면 없이 떴다. `model_provider`를 `[tui]` 아래에 두면 무시된다.
- 대화형 TUI에서 훅이 돈다 [실측]: claude(`--settings`), codex(`--no-alt-screen`, 신뢰된 전역 Stop 훅). 두 경우 모두 `KADAN_ROLE`이 훅 프로세스에 전달됐다.
- 긴 응답 [실측, claude만]: 1~1600 숫자 + 끝 마커, `last_assistant_message` 6917자가 **잘리지 않고** 끝 마커까지 있었다. codex 긴 응답 잘림은 **미확인**이다.
- 훅은 한도(429)·끊김·승인 대기·입력 큐 배너·정체를 대체하지 못한다. 그것들은 화면 판정 그대로다.
- 턴이 끝났는데 마커가 없으면 훅 증거도 없다. 지금처럼 화면 정체·`완료후보` 경로가 잡는다.
- 마커를 응답 글에 쓰는 약속(작업자 계약)은 그대로다. **마커 뒤에 맺음말을 붙이면 훅 빠른 길이 아니라 화면 판정으로 간다**(마지막 줄이 마커가 아니므로).
- 훅은 현재 실행을 모르므로 기록 단계의 상충 판정은 보수적이다(같은 실행일 수 있으면 상충). 최종 판정은 소비처(`hookTaskMatcher`)가 현재 실행 기준으로 한다.
- 실행기를 바꿔 훅 입력 키(`turn_id`·`prompt_id`)가 달라지면 `harness`가 `unknown`으로 적힐 뿐 판정에는 영향이 없다.
