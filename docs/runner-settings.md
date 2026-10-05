# 실행 모델 설정

## Why

역할별 실행기·모델·강도를 한 곳에서 정하면, 사람이 발령하든 AI 감독이 발령하든 같은 값으로 뜬다. 기본값을 AI가 기억해 `--cmd`를 손으로 조립하던 방식을 대신한다.

- 1단계(2026-09-23 [kyle] 승인): 설정 파일, `kadan start --profile` 자동 채움, 다른 명령의 이유 기록, 같은 계열 거부, 원장 기록.
- 2단계(2026-09-23): 대시보드 '실행 모델' 화면에서 역할 값과 활성 프리셋을 바꾼다. 아래 [대시보드 화면](#대시보드-화면)을 본다.
- 3단계(2026-09-23): 역할별 폴백 순서를 명령·대시보드에서 편집하고, `kadan start ... --fallback N --reason`으로 N번째 폴백을 골라 띄운다. 아래 [폴백 순서](#폴백-순서)를 본다.
- 즐겨찾기(2026-09-27 [kyle]): 자주 고르는 실행기·모델·강도 조합을 저장해 두고, 대시보드에서 한 번 눌러 세 칸을 채운다. 아래 [즐겨찾기](#즐겨찾기)를 본다.
- 감시 AI(2026-10-03 [kyle]): 감시 AI의 모델·강도·폴백 순서를 같은 화면에서 정하고, 1순위가 응답하지 못하면 감시기가 폴백으로 자동으로 내려간다. 아래 [감시 AI](#감시-ai)를 본다.

## 파일

`$KADAN_HOME/runner-settings.json`이 기계가 읽는 유일한 기준이다. 사람용 설명·결정 근거는 `agent-runners.json`에 둔다.

| 필드 | 뜻 |
| --- | --- |
| `revision` | 저장할 때마다 1씩 오른다. 읽은 revision과 다르면 저장을 거부한다 |
| `activePreset`, `presets.<이름>.roles` | 역할(`worker`·`reviewer`·`conductor`·`super`·`watch`)별 `{runner, model, effort}`. `watch`는 감시 AI다 |
| `presets.<이름>.fallback.<역할>` | 1순위가 막혔을 때 내려갈 순서 목록 `[{runner, model, effort}]`. 1번부터 센다 |
| `runners.<실행기>.spawn` | 실행 명령 틀. `{model}`·`{effort}`를 채운다 |
| `runners.codex.catalog` | `codex-models-cache`면 `~/.codex/models_cache.json`의 모델과 `supported_reasoning_levels`만 고를 수 있다 |
| `runners.<그 밖>.models` | 목록 파일이 없는 실행기는 실측한 `{model, efforts}`만 적는다 |
| `families` | 모델 이름 앞머리로 계열을 읽는 규칙 |
| `blocked` | 정책으로 막은 모델과 적용 역할 |
| `favorites` | 화면에서 한 번에 고르는 조합 목록 `[{runner, model, effort}]`. 발령은 읽지 않는다 |

## 명령

```sh
kadan runners init --reason <이유>          # agent-runners.json의 실행기 틀만 옮겨 처음 만든다
kadan runners set worker --runner codex --model xai/grok-4.7-build-fast --effort xhigh --revision N --reason <이유>
kadan runners show                          # 역할별 값과 채워질 실행 명령
kadan runners runner claude --spawn '<명령 틀>' --revision N --reason <이유>      # 실행기 명령 틀(래퍼 포함)
kadan runners model claude claude-opus-5-5 --efforts low,medium,high,xhigh,max --revision N --reason <이유>  # 목록 파일이 없는 실행기의 실측 모델
kadan runners block gpt-6-astra --roles reviewer --revision N --reason <이유>      # 정책 차단(역할 생략 시 모든 역할)
kadan runners preset A --revision N --reason <이유>          # 활성 프리셋 전환(있는 프리셋만)
kadan runners fallback worker --set 'devin:swe-2-max,codex:zai/glm-5.3:high' --revision N --reason <이유>  # 폴백 순서 전체(빈 글이면 비움)
kadan runners favorite --set 'claude:claude-opus-5-5:high,codex:kimi/k3[1m]:max' --revision N --reason <이유>  # 즐겨찾기 전체(빈 글이면 비움)
kadan start <역할> --profile worker          # --cmd 없이: 설정의 명령으로 띄운다
kadan start <역할> --profile worker --cmd '<명령>' --reason <이유>   # 설정과 다른 명령
kadan start <역할> --profile worker --fallback 2 --reason <이유>   # 2번 폴백으로 띄운다
```

- 역할은 실행기·모델·추론 강도 세 값으로 정한다. 실행기가 명령 틀을 정하고, 모델·강도가 틀을 채운다.
- `set`은 목록에 없는 모델, 지원하지 않는 강도, 정책으로 막은 모델, 작업자와 같은 계열의 검수자를 거부한다. 모르는 계열끼리는 막지 않는다.
- 모든 변경은 원장에 `runner-settings` 사건으로 남는다(`by`·`t`·`revision`·`before`·`after`·`reason`).
- `start`의 start 기록에는 `launchSource`(`settings`/`override`/`fallback`), `settingsRevision`을 남긴다. `override`면 `overrideReason`과 그때의 설정 명령(`settingsCmd`)도 남긴다. `fallback`이면 `fallbackIndex`·`fallbackReason`·`settingsPreset`과 1순위 명령(`settingsCmd`, 있으면)을 남긴다.
- 설정 파일이 없으면 `start`는 예전처럼 `--cmd`가 필요하다. 인계 후임 생성은 선임 명령을 이유("인계: 선임 실행 명령 유지")와 함께 그대로 쓴다.
- `work auto-configure`는 작업자·검수자 세션을 실제로 띄운 모델의 계열이 같으면 거부한다.
- 설정을 바꿔도 떠 있는 세션은 그대로다. 다음 발령부터 적용된다. 발령에는 자동 라우팅·자동 폴백을 만들지 않는다(감시 AI만 예외, 아래 [감시 AI](#감시-ai)). 다만 떠 있는 옛 세션에 카드를 보내는 것은 아래 [옛 세션 발령 막기](#옛-세션-발령-막기)가 막는다.

## 옛 세션 발령 막기

작업자·검수자 기본값이 바뀐 뒤에도 옛 실행기·모델로 떠 있던 세션에 새 카드가 가는 일이 반복됐다(2026-09-23 grok→opus, 09-29 opus→sonnet). 기억에 기댄 규칙은 놓치므로 카드를 보내는 순간 세션과 지금 기본값을 대조한다(2026-09-29 [kyle] 승인).

- **적용 범위**: 카드 발령만이다 — `kadan send --task`, `--execution`으로 발령 카드가 추론되는 경우, `work` 자동 발령. 모두 `guardedSend`의 `taskId` 경로 한 곳을 지난다. **`--raw` 발령도 같다** — `--raw`는 받는 쪽에 붙이는 역할 지침만 빼고 이 검사는 그대로 거친다. 일반 우편·질문·답장·감시 알림·인계·`kadan up` 첫 지문은 대상이 아니다. `card update --status assigned`, `kadan plan`, 대시보드는 세션에 아무것도 보내지 않으므로 이 경계와 무관하다.
- **받는 역할이 작업자(`worker`)·검수자(`reviewer`) 프로필일 때만** 본다. 프로필은 세션 시작 기록의 `roleProfile` → 발령 쪽 프로필 인자(자동 발령) → 역할 지침 설정(`role-instructions.json`)·업무 owner·카드 단계(`implementation`·`fix`·`research`는 작업자, `review`는 검수자) 추론 순서로 정한다. 감독·슈퍼감독·비서 등은 대상이 아니다.
  - 시작 기록에 프로필이 없는 옛 세션도 그 뒤 근거(역할 지침 설정·업무 owner·카드 단계)로 알아본다. **`--raw`여도 같은 규칙으로 추론한다** — 프로필이 빈 옛 시작 기록이라는 이유만으로 `--raw` 발령이 검사에서 빠지지 않는다(2026-09-29 검수에서 발견·수정).
  - 프로필을 끝내 알 수 없으면(위 근거가 모두 없음) 일반 발령이든 `--raw`든 대조하지 않는다. 카드 발령의 실행 카드는 배정 때 단계가 필수라 실제로는 드물다.
- **세션 값**은 "마지막 `stop` 이후, 지금 pane PID와 같은 start 기록 중 실행 명령(`cmd`)이 있는 것"에서 읽는다(`inspectCardSendIdentity`가 고른 기록). 이미 살아 있는 세션에 `kadan start`를 다시 부르면 같은 PID에 `cmd`·`harness`·`model`·`launchSource`가 빈 새 start 기록이 붙으므로 "가장 최근 start"는 기준으로 쓰지 않는다.
- **기본값**은 발령 순간 `runner-settings.json`을 새로 읽고 그 프로필의 실행 명령으로 만든다.

| 상황 | 결과 |
| --- | --- |
| 세션 프로필(worker/reviewer)과 발령 카드 단계가 요구하는 프로필이 다르다(예: 검수 카드를 `--profile worker` 세션에) | **거절**(`profile-phase-mismatch`, `KADAN_STALE_RUNNER`). 조치: `kadan stop` 뒤 카드 단계 프로필로 새로 띄우기. 예외 이유로만 통과. 카드 단계가 하나로 정해지지 않으면(엇갈림·모름) 또는 설정 파일이 없으면 이 줄은 건너뛴다(2026-10-02 [kyle] — 10/1 검수 카드 18건이 작업자와 같은 모델 세션에 간 사고) |
| 실행기 또는 모델이 기본값과 다르지만 지금 설정의 그 프로필 폴백 목록 중 하나와 같다 | 통과 + 경고 한 줄(폴백 번호), send 기록에 `runnerGuard: {result: "warn", code: "fallback", fallbackIndex, settingsRevision}` (2026-10-02 [kyle]) |
| 실행기 또는 모델이 다르다 | **거절**(종료 코드 ≠ 0, 전달·send 기록 없음, `KADAN_STALE_RUNNER`). 안내 3줄: 지금 기본값 / 세션 값 / 조치 |
| 실행기·모델은 같고 강도·실행 인자만 다르다 | 통과 + 경고 한 줄(stderr), send 기록에 `runnerGuard: {result: "warn", code: "effort-or-args", settingsRevision}` |
| `--allow-old-runner "<이유>"` | 거절을 예외 통과. stderr에 경고, send 기록에 `runnerGuard: {result: "allowed", code, reason, settingsRevision}`. **이유가 비었거나 값이 없으면 예외가 아니라서 항상 거절**한다 — 세션이 기본값과 같아도, `--raw`여도, 받는 역할이 무엇이든 같다(`KADAN_STALE_RUNNER`, 안내 2줄). 이유가 있는데 옛 세션이 아니면 옵션은 무시된다 |
| 설정 파일이 없다 · 그 역할 값이 없다 | 대조하지 않음 |
| 기본값 명령에서 실행기·모델을 못 읽는다 | 통과 + 경고(`expected-unreadable`) |
| 설정 파일이 깨졌다 | 거절(`settings-unreadable`). 예외 이유로만 통과 |
| 시작 기록이 없다·명령이 없다·모델을 모른다 | **기존 AI 신원 경계(`KADAN_AI_IDENTITY_UNVERIFIED`)가 먼저 거절한다.** 새 경계가 기존 경계를 약하게 만들지 않는다(2026-09-29 감독 결정). 이 검사 자체는 그 자리에서 경고만 한다(`session-unknown`, 대조할 세션 값이 없음) — 실제로는 위 신원 경계에 막혀 여기까지 오지 않는다 |

- 옛 세션을 새로 띄워 보내려면 `kadan stop <역할>` 뒤 `kadan start <역할> --profile worker|reviewer`. 살아 있는 세션에 `start`만 다시 부르면 재사용일 뿐이라 옛 명령이 그대로다.
- 강도는 start 기록에 따로 없고 명령 안에 있다. 실행기별 어댑터를 만들지 않으려고 "기본값 명령과 세션 명령의 문자열이 다른가"로만 본다. 그래서 강도 말고 다른 실행 인자·경로 접두·`kadan-<실행기>` 래퍼가 달라도 같은 경고가 나온다(막지는 않는다).
- 모델 이름은 문자열로 비교한다. 별명(`--model opus`)으로 띄운 세션은 설정의 `claude-opus-5-5`와 다르게 보여 거절된다 — 의도한 세션이면 예외 이유로 보낸다.
- `--fallback N`·`--cmd … --reason`으로 띄운 세션도 지금 기본값과 다르면 같은 규칙으로 거절된다.
- `work` 자동 발령에는 예외 옵션이 없다. 거절되면 그 자동 실행이 멈추고 이유가 남는다.

## 대시보드 화면

대시보드 위 메뉴의 **실행 모델**(`#runner-settings`)에서 명령어 없이 바꾼다.

- 활성 프리셋의 역할 5개(작업자·검수자·일반감독·슈퍼감독·감시 AI)마다 실행기 → 모델 → 추론 강도를 고른다. 감시 AI 줄은 실행기로 codex만 보여 준다. 선택지는 `set`과 같은 목록(codex는 모델 목록 파일, 그 밖은 실측 목록)에서만 온다. 실행기를 바꾸면 그 실행기의 모델만, 모델을 바꾸면 그 모델이 지원하는 강도만 남는다. 강도를 받지 않는 실행기는 "해당 없음"이다.
- 정책으로 막은 모델은 목록에 "차단: 이유"로 보이지만 그 역할에서는 고를 수 없다.
- 각 행 아래에 지금 설정으로 채워질 실행 명령을 보여 준다.
- 프리셋이 둘 이상이면 활성 프리셋을 바꿀 수 있다. 전환도 `runner-settings` 사건(`action: preset`, `before`·`after`는 프리셋 이름)으로 남는다.
- 저장에는 이유가 필요하다. 폼은 화면을 읽은 `revision`을 함께 보내고, 그사이 설정이 바뀌었으면 "설정이 바뀌었다(현재 revision N) — 다시 읽고 저장"으로 거부한다.
- 저장하면 "다음 발령부터 적용, 떠 있는 세션은 그대로"를 보여 준다. 쓰기는 `by: 사람`으로 원장에 남는다.
- 화면 아래에 최근 `runner-settings` 사건 10건(시각·누가·무엇을·전 → 후·이유)을 보여 준다.
- 설정 파일이 없으면 `kadan runners init`을 먼저 하라는 안내만 보이고 폼은 없다.

쓰기 경로는 다른 대시보드 폼과 같다(로컬 주소, 같은 출처, 폼 입력, 화면을 읽을 때 받은 로컬 토큰).

| 주소 | 입력 | 하는 일 |
| --- | --- | --- |
| `POST /runners/set` | `token`·`revision`·`role`·`runner`·`model`·`effort`·`reason` | 활성 프리셋의 역할 값을 `set`과 같은 검사로 바꾼다 |
| `POST /runners/preset` | `token`·`revision`·`preset`·`reason` | 활성 프리셋을 바꾼다 |

토큰이 없거나 틀리면 403, 틀린 revision·빈 이유·목록 밖 실행기/모델/강도·차단 모델·작업자와 같은 계열의 검수자·없는 프리셋은 409로 거부하고 설정을 바꾸지 않는다. 화면의 선택지 좁히기는 편의일 뿐이고, 판정은 서버가 한다.

## 폴백 순서

1순위 모델이 막혔을 때 내려갈 순서를 역할별로 정해 둔다. **내려가는 조건: 원인이 확인된 막힘(쿼터·429·로그인 실패·모델 이름 오류)만. 원인을 모르면 멈추고 보고.** 막힘을 감지해 스스로 내려가는 기능은 없다. 사람이나 감독이 번호를 골라 발령한다.

- 목록은 `presets.<활성 프리셋>.fallback.<역할>`에 순서대로 둔다. 저장은 다른 설정과 같은 공통 경로(revision 대조·이유 필수·원장 `runner-settings` 사건, `action: fallback`, `before`·`after`는 목록 전체)다.
- 항목마다 1순위와 같은 검사를 한다: 목록 안의 실행기·모델, 모델이 지원하는 강도(강도를 받지 않는 실행기는 강도 없음), 그 역할에 대한 정책 차단. 같은 항목을 두 번 넣거나 바뀐 것이 없는 저장은 거부한다.
- 계열 규칙: 검수자 폴백 항목이 작업자 1순위와 같은 계열이거나, 작업자 폴백 항목이 검수자 1순위와 같은 계열이면 거부한다. 모르는 계열은 막지 않는다. 1순위를 바꿀 때도 같은 확인을 하므로 기존 폴백과 부딪히는 1순위 변경은 저장되지 않는다.
- `kadan runners show`는 활성 프리셋의 폴백 목록과 번호별로 채워질 실행 명령(`fallback.<역할>[].cmd`)을 보여 준다.

### 폴백으로 띄우기

```sh
kadan start <역할> --profile worker --fallback 2 --reason "1순위 429 확인"
```

- 번호는 1부터다. 번호가 없거나 목록 밖이면, 이유가 없으면, `--cmd`와 함께 주면, `--profile`이 설정 대상 역할이 아니면 띄우지 않는다.
- 이미 떠 있는 세션에는 쓰지 않는다(새로 띄울 때만).
- start 기록: `launchSource: "fallback"`, `fallbackIndex`, `fallbackReason`, `settingsRevision`, `settingsPreset`, `settingsCmd`(1순위 명령).

### 대시보드에서 편집

'실행 모델' 화면 아래 **역할별 폴백 순서**에서 역할마다 목록을 본다. 목록 위에 내려가는 조건을 표시하고, 항목마다 채워질 실행 명령을 보여 준다.

- 추가: 2단계와 같은 실행기 → 모델 → 강도 선택 칸(차단 모델은 고를 수 없음)에서 골라 **폴백 추가**.
- 순서 바꾸기·삭제: 항목의 **위로**·**아래로**·**삭제**.
- 버튼 한 번이 저장 한 번이다. 매번 이유가 필요하고 원장 사건이 하나씩 남는다.
- 쓰기 주소는 `POST /runners/fallback`(`token`·`revision`·`role`·`reason`·`op`=`add`|`remove:N`|`up:N`|`down:N`, 추가면 `runner`·`model`·`effort`). 서버가 저장 직전 목록에 조작을 적용한 뒤 위 검사를 모두 거친다. 토큰·출처가 틀리면 403, 틀린 revision·빈 이유·목록 밖 값·강도·차단·계열 충돌·없는 번호는 409.

## 감시 AI

감시 AI(작업 감시AI·감독 관찰AI)는 사람이 띄우는 세션이 아니라 감시기(`kadan watch`)가 `scripts/watch-judge.sh`로 부르는 일회성 호출이다. 번호를 골라 줄 사람이 없으므로, 감시 AI의 폴백은 감시기가 스스로 내려간다(2026-10-03 [kyle] 결정 — 9/20 이후 실패가 모두 공급자 접속 장애·연결 끊김이었다).

- 설정: 활성 프리셋의 `roles.watch`가 1순위, `fallback.watch`가 폴백 순서다. 명령은 `kadan runners set watch …`·`kadan runners fallback watch --set …`, 대시보드는 '실행 모델'의 **감시 AI** 줄이다. 프리셋을 바꾸면 감시 AI 값도 그 프리셋 것으로 바뀐다.
- 실행기는 `codex`만 받는다. `watch-judge.sh`가 `codex exec`로 부르기 때문이다. 다른 실행기용 비대화 명령(어댑터)은 만들지 않는다. 작업자↔검수자 계열 규칙은 감시 AI에 적용하지 않는다. 정책 차단(`block --roles watch`)은 적용한다.
- 호출 순서: 감시기는 AI를 부를 때마다 설정 파일을 새로 읽어 `[1순위, 폴백…]`을 만들고, 1순위부터 `KADAN_JUDGE_MODEL`·`KADAN_JUDGE_EFFORT`를 채워 부른다. 1순위 포함 **최대 3개**까지만 시도한다.
- **내려가는 조건: 그 모델이 응답하지 못한 경우만** — 호출 결과가 시간 초과(`timeout`) 또는 호출 실패(`call-failed`, 종료 코드 ≠ 0). 보고 누락·불완전(`report-missing`·`report-incomplete`)은 모델이 돌았는데 지시를 어긴 것이라 내려가지 않는다. 감시 종료·대상 제외로 취소되면(`cancelled`) 멈춘다. 오류 문구를 해석하지 않는다.
- 시도마다 새 호출 기록(`watch-ai-request`)과 증거 폴더를 만든다. 앞 시도의 만료·종료 기록이 뒤 시도의 보고를 막지 않게 하기 위해서다. 시도마다 5분 상한이므로 최악이면 감시AI 한 자리를 15분 잡는다. 그동안 감시sh 순회는 계속한다.
- 호출 종료 기록(`watch-ai-call`)에 `judgeSource`(`settings`/`profile`), `fallbackIndex`(0이 1순위), `settingsRevision`·`settingsPreset`, 두 번째 시도부터 `previousRequestId`·`previousReason`을 남긴다. 실제 모델은 기존처럼 `model`(스크립트가 쓴 `model.txt`)이다.
- 설정 파일이 없거나 `watch` 값이 없으면 예전과 같다: 감시 프로필의 `KADAN_JUDGE_MODEL`로 한 번만 부르고 강도는 max다. 설정 파일이 깨졌으면 프로필 값으로 부르고 `settingsError`를 남긴다.
- 설정을 바꾸면 감시기를 다시 띄우지 않아도 다음 감시 호출부터 적용된다.

## 자문위원

자문위원(advisor)도 세션이 아니라 일회성 호출이다. 감독이 `kadan advise <카드키> --question …`으로 부르면 `scripts/advise.sh`가 `codex exec`로 한 번 돌린다(2026-10-05 [kyle] 승인). 슈퍼감독은 값싼 모델로 두고, 판단이 무거운 카드만 여기로 보낸다. 자세한 규칙은 [자문위원](advisor.md).

- 설정: 활성 프리셋의 `roles.advisor`. 명령은 `kadan runners set advisor --runner codex --model … [--effort …]`, 대시보드는 '실행 모델'의 **자문위원** 줄이다. 값이 없으면 `kadan advise`가 거절한다(기본 모델 없음).
- 실행기는 `codex`만 받는다. 작업자↔검수자 계열 규칙은 적용하지 않고, 정책 차단(`block --roles advisor`)은 적용한다.
- **폴백이 없다.** `runners fallback advisor`는 거절한다. 감독이 명령으로 부르고 실패(시간 초과·호출 실패·빈 답)를 그 자리에서 보므로, 감시 AI처럼 자동으로 내려갈 이유가 없다.
- 상한은 호출마다 기본 10분(`--timeout <초>`, 최대 3600). 고급·느린 모델이 저장소를 직접 읽는 호출이라 감시 AI(5분)보다 길다.

## 즐겨찾기

자주 고르는 실행기·모델·강도 조합을 목록으로 둔다. 역할·프리셋과 무관한 한 목록(`favorites`)이고, 발령은 이 목록을 읽지 않는다. 화면에서 세 칸을 매번 고르는 수고만 줄인다.

- 대시보드 '실행 모델'의 역할 바꾸기 칸(기본 실행 모델·대체 후보) 위에 즐겨찾기 버튼이 뜬다. 누르면 실행기·모델·강도를 채우고, 이유 칸이 비어 있으면 `즐겨찾기: <조합>`을 채운다. 저장은 여전히 **실행 모델 저장**(또는 **대체 후보 추가**)을 눌러야 되고, 그때 그 역할 기준 검사(차단·계열 등)를 모두 거친다.
- 추가: 기본 실행 모델 칸에서 조합을 고르고 **이 조합 즐겨찾기**. 삭제: **즐겨찾기 관리**의 **삭제**. 버튼 한 번이 저장 한 번이며, 이유는 화면이 `즐겨찾기 추가`·`즐겨찾기 삭제`로 채워 보낸다.
- 저장 검사: 목록 안의 실행기·모델, 모델이 지원하는 강도, 중복·변화 없음. 역할이 없으므로 정책 차단은 보지 않는다. 막힌 모델의 즐겨찾기 버튼은 그 역할 칸에서 눌리지 않는다.
- 다른 설정과 같은 공통 경로(revision 대조·이유 필수·원장 `runner-settings` 사건, `action: favorite`, `before`·`after`는 목록 전체)다. revision이 오르므로, 다른 역할 칸을 작성하던 중이면 "설정이 변경됐습니다" 안내가 뜬다. 즐겨찾기를 추가한 그 칸은 새 revision으로 이어서 저장할 수 있다. 다른 칸은 화면을 새로 읽어야 저장된다.
- 쓰기 주소는 `POST /runners/favorite`(`token`·`revision`·`reason`·`op`=`add`|`remove:N`, 추가면 `runner`·`model`·`effort`). 토큰·출처가 틀리면 403, 틀린 revision·빈 이유·목록 밖 값·강도·중복·없는 번호는 409.
- 예전 HTML 벽 화면(`runner-settings-wall`)에는 버튼이 없고, 최근 변경 표에 `즐겨찾기` 사건만 보인다.
