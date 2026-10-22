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
| `runners.<실행기>.resume`·`fork`·`exec`·`version`·`update`·`listModels`·`conversation` | 선택 칸. [실행기 명령 표](#실행기-명령-표) |
| `runners.codex.catalog` | `codex-models-cache`면 `~/.codex/models_cache.json`의 모델과 `supported_reasoning_levels`만 고를 수 있다 |
| `runners.<그 밖>.models` | 목록 파일이 없는 실행기는 실측한 `{model, efforts}`만 적는다 |
| `families` | 모델 이름 앞머리로 계열을 읽는 규칙 |
| `blocked` | 정책으로 막은 모델과 적용 역할 |
| `favorites` | 화면에서 한 번에 고르는 조합 목록 `[{runner, model, effort}]`. 발령은 읽지 않는다 |

## 명령

```sh
kadan runners init --reason <이유>          # PATH에서 설치가 감지된 실행기의 틀을 옮겨 처음 만들고 기본 프리셋을 채운다([기본 프리셋](#기본-프리셋))
kadan runners set worker --runner codex --model <모델> --effort <강도> --revision N --reason <이유>
kadan runners show                          # 역할별 값과 채워질 실행 명령
kadan runners runner claude --spawn '<명령 틀>' --revision N --reason <이유>      # 실행기 명령 틀(래퍼 포함)
kadan runners model claude <모델> --efforts <강도,…> --revision N --reason <이유>  # 목록 파일이 없는 실행기의 실측 모델
kadan runners model claude <모델> --remove --revision N --reason <이유>  # 등록 모델 빼기(역할 값·대체 후보·즐겨찾기가 쓰는 모델은 거절하고 쓰는 곳을 모두 적는다. codex는 목록 파일이라 거절)
kadan runners block <모델> --roles reviewer --revision N --reason <이유>      # 정책 차단(역할 생략 시 모든 역할)
kadan runners preset A --revision N --reason <이유>          # 활성 프리셋 전환(있는 프리셋만)
kadan runners preset add fast [--from A] --revision N --reason <이유>   # 프리셋 만들기: 원본(기본은 활성 프리셋)의 roles·fallback 복사
kadan runners preset rename fast quick --revision N --reason <이유>      # 이름 바꾸기(활성이면 활성 이름도 따라간다)
kadan runners preset remove quick --revision N --reason <이유>           # 지우기(활성 프리셋은 거절)
kadan runners fallback worker --set '<실행기>:<모델>[:<강도>],…' --revision N --reason <이유>  # 폴백 순서 전체(빈 글이면 비움)
kadan runners favorite --set '<실행기>:<모델>[:<강도>],…' --revision N --reason <이유>  # 즐겨찾기 전체(빈 글이면 비움)
kadan start <역할> --profile worker          # --cmd 없이: 설정의 명령으로 띄운다
kadan start <역할> --profile worker --cmd '<명령>' --reason <이유>   # 설정과 다른 명령
kadan start <역할> --profile worker --fallback 2 --reason <이유>   # 2번 폴백으로 띄운다
```

- 역할은 실행기·모델·추론 강도 세 값으로 정한다. 실행기가 명령 틀을 정하고, 모델·강도가 틀을 채운다.
- `set`은 목록에 없는 모델, 지원하지 않는 강도, 정책으로 막은 모델, 작업자와 같은 계열의 검수자를 거부한다. 모르는 계열끼리는 막지 않는다.
- 모든 변경은 원장에 `runner-settings` 사건으로 남는다(`by`·`t`·`revision`·`before`·`after`·`reason`).
- CLI와 대시보드의 동시 저장은 같은 파일 잠금 안에서 revision을 확인한다. 먼저 저장한 변경을
  덮어쓰지 않으며, 충돌한 쪽은 최신 설정을 다시 읽고 저장해야 한다. 잠금은 최대 5초 기다리고
  풀리지 않으면 실패한다. 원인을 모르는 잠금을 자동으로 지우지 않는다.
- `start`의 start 기록에는 `launchSource`(`settings`/`override`/`fallback`), `settingsRevision`을 남긴다. `override`면 `overrideReason`과 그때의 설정 명령(`settingsCmd`)도 남긴다. `fallback`이면 `fallbackIndex`·`fallbackReason`·`settingsPreset`과 1순위 명령(`settingsCmd`, 있으면)을 남긴다.
- 설정 파일이 없으면 `start`는 예전처럼 `--cmd`가 필요하다. 인계 후임 생성은 선임 명령을 이유("인계: 선임 실행 명령 유지")와 함께 그대로 쓴다.
- `work auto-configure`는 작업자·검수자 세션을 실제로 띄운 모델의 계열이 같으면 거부한다.
- 설정을 바꿔도 떠 있는 세션은 그대로다. 다음 발령부터 적용된다. 발령에는 자동 라우팅·자동 폴백을 만들지 않는다(감시 AI만 예외, 아래 [감시 AI](#감시-ai)). 다만 떠 있는 옛 세션에 카드를 보내는 것은 아래 [옛 세션 발령 막기](#옛-세션-발령-막기)가 막는다.

## 기본 프리셋

처음 `kadan runners init`을 할 때만 만든다. 설정 파일이 이미 있으면 거절하므로 운영 중인 설정에는 아무것도 소급하지 않는다.

- **감지**: `kadan init`과 같은 `detectRunners`(PATH에서 `which codex`·`which claude`)다. 감지된 실행기만 등록한다. `agent-runners.json`에 적힌 그 밖의 실행기는 감지 대상이 아니라 적힌 대로 등록한다. 하나도 감지되지 않으면 파일을 만들지 않고 거절한다(설치 뒤 다시 init).
- **codex**: `~/.codex/models_cache.json`(또는 `KADAN_CODEX_MODELS_CACHE`)의 숨김(`visibility: hide`)이 아닌 첫 모델과 그 모델의 기본 강도로 작업자·일반감독·슈퍼감독을 채운다. 모델 이름은 코드에 없다. 목록이 아직 없으면(codex를 한 번도 안 돌린 기계) 등록만 하고 역할은 비우고 안내를 낸다.
- **claude**: 모델 목록 파일이 없고 코드에 이름을 두지 않으므로 역할을 비우고 안내한다. `kadan runners model claude <모델> --efforts …`로 모델을 등록한 뒤 `kadan runners set …`로 채운다. 그러니 바로 쓸 수 있는 것은 codex가 깔린 기계뿐이다.
- **검수자**: 작업자와 다른 계열이어야 하므로 늘 비운다. 절반만 채운 프리셋은 저장 때 계열 검사가 받아 준다.
- 감시 AI·시니어·설명 AI는 자동 호출·비용이 생기는 칸이라 채우지 않는다. 비어 있어도 조용히 깨지지 않는다(시험: `tests/runner-presets.test.mjs`).
  - 감시 AI: 순서가 없으면 감시 프로필의 `KADAN_JUDGE_MODEL`로 한 번 부른다(호출 기록 `judgeSource: profile`).
  - 시니어: `kadan senior`는 외부 호출·증거 폴더를 만들기 전에 `시니어 모델 설정 없음 — kadan runners set senior …` 오류로 끝난다.
  - 설명 AI: 꺼진다(대기열도 비운다). 아무것도 부르지 않는다.

## 프리셋 관리

프리셋에는 역할 값(`roles`)·폴백(`fallback`)·설명(`label`)만 담긴다. 실행기 표(`runners`)·계열 규칙(`families`)·정책 차단(`blocked`)·즐겨찾기(`favorites`)는 모든 프리셋이 함께 쓴다.

- `preset add <이름> [--from <원본>]`: 원본(기본은 활성 프리셋)을 복사한다. 활성 프리셋은 바뀌지 않는다.
- `preset rename <옛> <새>`, `preset remove <이름>`. 활성 프리셋은 지울 수 없다.
- 이름은 영문·숫자·`.`·`/`·`-`·`[`·`]`만 쓰고(`NAME_PATTERN`), 이미 있는 이름과 `add`·`rename`·`remove`는 쓸 수 없다. 전부 `--revision`·`--reason`을 받고 원장에 `preset-add`·`preset-rename`·`preset-remove`로 남는다.
- `set`·`fallback`의 `--preset <없던 이름>`은 아직 프리셋을 새로 만든다(시험이 기대는 동작이라 유지). 만들 때는 `preset add`를 쓴다.

## 옛 세션 발령 막기

작업자·검수자 기본값이 바뀐 뒤에도 옛 실행기·모델로 떠 있던 세션에 새 카드가 가는 일이 반복됐다(2026-09-23 grok→opus, 09-29 opus→sonnet). 기억에 기댄 규칙은 놓치므로 카드를 보내는 순간 세션과 지금 기본값을 대조한다(2026-09-29 [kyle] 승인).

- **적용 범위**: 카드 발령만이다 — `kadan send --task`, `--execution`으로 발령 카드가 추론되는 경우, `work` 자동 발령. 모두 `guardedSend`의 `taskId` 경로 한 곳을 지난다. **`--raw` 발령도 같다** — `--raw`는 받는 쪽에 붙이는 역할 지침만 빼고 이 검사는 그대로 거친다. 일반 우편·질문·답장·감시 알림·인계·`kadan start` 첫 안내(`kadan up`의 비서 첫 안내 포함)는 대상이 아니다. `card update --status assigned`, `kadan plan`, 대시보드는 세션에 아무것도 보내지 않으므로 이 경계와 무관하다.
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

## 스크롤백(인라인) 화면 고정

Why: codex 0.157부터 대화형 화면이 풀스크린(alternate screen)이 기본이다. 풀스크린이면 죽은 창의 마지막 줄 보존(`captureTail`)·`pipe-pane` 출력 기록(DONE 마커를 여기서 찾는다)·tmux 위로 스크롤이 약해진다. 기본값이 언제 바뀔지 모르므로 사용자 설정에 기대지 않고 카단이 만드는 명령에 붙여 고정한다(2026-10-18 [kyle] 결정).

- **codex**: 대화형 명령 끝에 `--no-alt-screen`을 붙인다(`src/inline-screen.mjs` `withInlineScreen`). 토큰 단위로 보고 이미 있으면 중복하지 않는다. `codex exec`·`review` 같은 비대화형 하위 명령, `--` 뒤, 셸 연산이 든 명령에는 붙이지 않는다. 운영 `runner-settings.json`의 틀은 고치지 않는다.
  - 붙는 곳: `fill()`(`launchFor`·`launchForFallback`, 대시보드 '실행 모델' 표시), `kadan start --cmd`(adopt·handover 포함, 비교 전에 맞춘다), `kadan restart`의 resume 재조립, 비서 복원(`secretary-resume`). 감시·시니어의 `codex exec`와 설명 AI의 `exec` 틀(`explainCommand`)에는 붙이지 않는다.
  - 옛 세션(플래그 없이 뜬 명령)과 기본값은 플래그만 달라도 같은 명령으로 본다(`dispatch-runner-guard`).
  - **위험**: 이 플래그를 모르는 옛 codex는 시작이 실패할 수 있다. 실행 중 버전 검사는 하지 않는다(단순하게). 설치된 0.163.0은 `codex`·`codex resume`·`codex fork` 도움말에 이 플래그가 있고 `codex exec`에는 없다(그래서 exec에는 붙이지 않는다). 명령에 `--`가 있으면 그 바로 앞에 넣는다(`--` 뒤는 프롬프트라서).
- **claude**: claude-code 2.1.302는 명령 옵션이 없고 환경 변수 `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`(참이면 끔)·`CLAUDE_CODE_NO_FLICKER=0`, 설정 `tui: "default"`로 끈다(설치 묶음에서 확인). 명령 문자열을 바꾸면 신원 대조·재시작 해석이 흔들려, 창을 만들 때 tmux 환경(`new-session -e`)으로만 넣는다. 사용자 전역 설정 파일은 고치지 않는다. 실제 claude 화면으로는 확인하지 못했다.
- **지키는 장치**: `kadan start`가 창을 띄운 뒤 최대 2초(`KADAN_ALT_CHECK_MS`, 0이면 건너뜀)까지 tmux `#{alternate_on}`을 읽어 `start` 원장 줄에 `alternateOn`(0/1)을 적는다. 1이면 시작 출력에 경고 한 줄을 낸다. `restart`·비서 복원이 만드는 `start` 줄에는 아직 적지 않는다.

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

- **실행기 모델·명령 표**(같은 화면 아래, 실행기마다 펼침): codex는 "codex 목록 파일을 따른다"만 보인다. 그 밖의 실행기는 등록 모델 목록(삭제 버튼 — 쓰는 곳이 있으면 서버가 거절 메시지로 쓰는 곳을 적는다), 모델 등록(이름·강도 쉼표), `listModels` 칸이 있으면 **목록 불러오기**(아직 등록 안 된 모델을 골라 등록), 명령 표 편집(spawn·resume·fork·exec·execField·version·update·listModels·conversation JSON)이 있다. 표 저장은 바뀐 칸만 보내고 빈 칸은 그 칸을 지우며, 저장 검사는 CLI `runner --table`과 같은 `setRunner`가 한다. 새 실행기 추가도 같은 폼(spawn에 `{model}` 필수)이다. 실행기 삭제는 화면·CLI 모두 없다.

쓰기 경로는 다른 대시보드 폼과 같다(로컬 주소, 같은 출처, 폼 입력, 화면을 읽을 때 받은 로컬 토큰).

| 주소 | 입력 | 하는 일 |
| --- | --- | --- |
| `POST /runners/set` | `token`·`revision`·`role`·`runner`·`model`·`effort`·`reason` | 활성 프리셋의 역할 값을 `set`과 같은 검사로 바꾼다 |
| `POST /runners/preset` | `token`·`revision`·`preset`·`reason` | 활성 프리셋을 바꾼다 |
| `POST /runners/model-add` | `token`·`revision`·`runner`·`model`·`efforts`·`reason` | `runners model`과 같은 `setRunnerModel` |
| `POST /runners/model-remove` | `token`·`revision`·`runner`·`model`·`reason` | `runners model --remove`와 같은 `removeRunnerModel`(원장 `action: model-remove`) |
| `POST /runners/runner` | `token`·`revision`·`runner`·`spawn`(선택)·`table`(JSON)·`reason` | `runners runner --table`과 같은 `setRunner`. 지금 값과 같은 칸은 버리고 바뀐 칸만 저장 |
| `POST /runners/models-list` | `token`·`runner` | `listModels` 명령을 한 번 돌려 `{models:[{model,name,registered}]}`를 돌려준다. revision·이유 없음, 아무것도 쓰지 않는다. 동시에 하나만 돈다 |

토큰이 없거나 틀리면 403, 틀린 revision·빈 이유·목록 밖 실행기/모델/강도·차단 모델·작업자와 같은 계열의 검수자·없는 프리셋은 409로 거부하고 설정을 바꾸지 않는다. 화면의 선택지 좁히기는 편의일 뿐이고, 판정은 서버가 한다.

## 폴백 순서

1순위 모델이 막혔을 때 내려갈 순서를 역할별로 정해 둔다. **내려가는 조건: 원인이 확인된 막힘(쿼터·429·로그인 실패·모델 이름 오류)만. 원인을 모르면 멈추고 보고.** 막힘을 감지해 스스로 내려가는 기능은 없다. 사람이나 감독이 번호를 골라 발령한다. 내리기 전에 감시기가 한도 경보에 붙인 ocx 새로고침 결과를 먼저 본다(`docs/rate-limit-retry.md`). 새로 받은 사용량이 낮으면 가짜 한도일 수 있어 대체 대신 그 창을 esc 뒤 재개한다.

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
- **내려가는 조건: 그 모델이 응답하지 못한 경우만** — 호출 결과가 시간 초과(`timeout`) 또는 호출 실패(`call-failed`, 종료 코드 ≠ 0). 보고 누락·불완전(`report-missing`·`report-incomplete`)은 모델이 돌았는데 지시를 어긴 것이라 내려가지 않는다. 감시 종료·대상 제외로 취소되면(`cancelled`) 멈춘다. 오류 문구는 아래 인터넷 없음 한 가지만 본다.
- **인터넷 없음·잠자기는 내려가지 않는다**(2026-10-07 [kyle]). 모든 모델이 같은 연결로 나가므로 다음 모델도 똑같이 실패한다.
  - 인터넷 없음(`network`): `watch-judge.sh`가 실패한 호출의 진단 기록에서 공급자 주소를 못 찾은 문구(`getaddrinfo ENOTFOUND` 등)를 보면 표시한다.
  - 잠자기(`slept`): 시간 초과는 깨어 있던 시간으로 잰다. 맥북을 덮어 호출이 30초 넘게 멈췄다 깨면 이미 끊긴 호출로 보고 끝낸다.
  - 둘 다 사용자 알림 없이 다음 정기 점검에 다시 부른다. 인터넷 없음이 깨어 있는 동안 같은 대상에서 3번 이어지면 그때 알린다(감시 순회 사이가 크게 벌어지면 잠든 것으로 보고 횟수를 버린다).
- 시도마다 새 호출 기록(`watch-ai-request`)과 증거 폴더를 만든다. 앞 시도의 만료·종료 기록이 뒤 시도의 보고를 막지 않게 하기 위해서다. 시도마다 5분 상한이므로 최악이면 감시AI 한 자리를 15분 잡는다. 그동안 감시sh 순회는 계속한다.
- 호출 종료 기록(`watch-ai-call`)에 `judgeSource`(`settings`/`profile`), `fallbackIndex`(0이 1순위), `settingsRevision`·`settingsPreset`, 두 번째 시도부터 `previousRequestId`·`previousReason`을 남긴다. 실제 모델은 기존처럼 `model`(스크립트가 쓴 `model.txt`)이다.
- 설정 파일이 없거나 `watch` 값이 없으면 예전과 같다: 감시 프로필의 `KADAN_JUDGE_MODEL`로 한 번만 부르고 강도는 max다. 설정 파일이 깨졌으면 프로필 값으로 부르고 `settingsError`를 남긴다.
- 설정을 바꾸면 감시기를 다시 띄우지 않아도 다음 감시 호출부터 적용된다.

## 시니어

시니어(senior)도 세션이 아니라 일회성 호출이다. 감독이 `kadan senior <카드키> --question …`으로 부르면 codex는 `scripts/senior.sh`가 `codex exec`로, 허용 목록의 agy는 실행기 표 `exec` 틀로 한 번 돌린다(2026-10-05 [kyle] 승인, agy는 아래 [시니어](#시니어) 설정 참고). 슈퍼감독은 값싼 모델로 두고, 작업 결과에 결정할 부분이 있을 때만 여기로 묻는다. 자세한 규칙은 [시니어](senior.md).

- 설정: 활성 프리셋의 `roles.senior`는 **최대 2명 목록**(`{runner, model, effort}`)이다(2026-10-22 [kyle] 승인). 옛 단일 객체는 1명 목록으로 읽고 다음 저장 때 목록으로 남는다. 명령은 `kadan runners set senior --set "실행기:모델[:강도],…" --revision N --reason …`(최대 2명, 각 항목은 한 명 등록과 같은 검사, 같은 실행기+모델 중복·3명 이상 거절)이고, 한 명이면 기존 `--runner codex --model … [--effort …]`가 된다(목록이 그 한 명으로 바뀐다). 대시보드는 '실행 모델'의 **시니어** 줄(등록 목록)과 '시니어 바꾸기'(추가·삭제·위로·아래로)다. 값이 없으면 `kadan senior`가 거절한다(기본 모델 없음). 감독이 `kadan senior`를 부르면 **등록된 전원에게 동시에** 묻는다.
- 실행기는 안전 허용 목록(`SENIOR_SAFE_RUNNERS`, 지금 `codex`·`agy`)에 든 것만 받는다. agy는 실행기 표 `exec` 틀 + 도구 없는 에이전트로 부르며, 카드 저장소(git·안전한 경로)는 코드가 실행 직전에 덧붙이는 `--add-dir`로 읽기 전용으로 읽는다([시니어](senior.md), [agy 묶기](#agy-도구-없는-에이전트-묶기)). 저장(`runners set senior`)과 호출(`kadan senior --runner`)이 같은 검사로 거절한다. 작업자↔검수자 계열 규칙은 적용하지 않고, 정책 차단(`block --roles senior`)은 호출 때 골라 부른 모델에도 적용한다.
- **호출 때 고르기**: `kadan senior … [--runner <실행기> --model <모델>]`은 **등록된 시니어 중 한 명만** 고른다. 등록 밖의 모델은 거절하고 등록 목록을 보인다. 설정은 그대로다([시니어](senior.md)). 카드 글은 외부로 보내기 전에 `scrubForAI`로 웹훅 주소·토큰 모양을 가린다.
- **폴백이 없다.** `runners fallback senior`는 거절한다. 두 시니어는 폴백이 아니라 동등하고, 감독이 명령으로 부르고 한도·실패(시간 초과·호출 실패·빈 답)를 칸마다 그 자리에서 보므로 자동으로 내려갈 이유가 없다. 재시도도 없다.
- 상한은 호출마다 기본 30분(`--timeout <초>`, 최대 3600). 고급·느린 모델이 저장소를 직접 읽고 시험까지 돌려 볼 수 있는 호출이라 감시 AI(5분)보다 훨씬 길다. 횟수 제한은 없다 — 필요할 때만 부른다.

## 설명 AI

설명 AI(`explain`)는 대시보드 카드의 요약 칸(`card brief`)을 싼 AI가 채우게 하는 역할이다(2026-10-15 [kyle]). 세션이 아니라 감시기(`kadan watch`)가 사건이 난 카드에만 한 번씩 부르는 일회성 호출이다. **감시 AI가 아니다**: 판정·보고·알림을 하지 않고 요약 줄만 쓰며, 감시 AI와 자리·모델·기록을 나누지 않는다.

- 설정: 활성 프리셋의 `roles.explain`이 1순위, `fallback.explain`이 대체 후보다. 1순위 포함 **최대 2개**(대체 후보는 1개)다. 명령은 `kadan runners set explain …`·`kadan runners fallback explain --set …`, 대시보드는 '실행 모델'의 **설명 AI** 줄이다.
- 실행기는 codex로 묶지 않는다. **실행기 표에 `exec` 틀이 있는 실행기만** 고를 수 있다(없으면 저장 거절). 강도는 그 `exec` 틀에 `{effort}`가 있을 때만 받는다. 작업자↔검수자 계열 규칙은 적용하지 않고 정책 차단(`block --roles explain`)은 적용한다. 감시 AI의 codex 고정은 그대로다. 시니어는 안전 허용 목록(`codex`·`agy`)에 든 실행기만 받는다.
- 코드에는 실행기 이름이 없다. `runners.<실행기>.exec` 틀을 채워 빈 작업 폴더(`<KADAN_HOME>/explain-ai-work`)에서 실행하고, `execField`가 가리키는 필드(없으면 표준 출력 전체)를 답으로 읽는다. **카드 글은 명령 문자열에 글자로 끼워 넣지 않는다**(2026-10-15 검수 F1): `{prompt}` 자리는 셸 변수 참조 `"$KADAN_EXPLAIN_PROMPT"`로 채우고 글은 그 프로세스의 환경변수로만 넘긴다. 셸은 변수 값을 다시 해석하지 않으므로 명령 치환·백틱·따옴표·줄바꿈이 든 카드 글도 원문 그대로 전달된다(따옴표 처리로 막는 방식은 틀 작성자가 `"{prompt}"`로 쓰면 깨진다). `{prompt}`가 없는 틀은 표준 입력으로 보낸다. 명령줄(`ps`)에는 글이 나오지 않는다. 자리 채우기는 한 번에 처리해 `$&` 같은 글자나 값 안의 `{cwd}`가 바뀌지 않는다.
- 표준 출력·표준 오류는 합쳐 1MiB까지만 받는다. 넘으면 그 프로세스 묶음을 끝내고 사유(`output-limit`)만 기록하며 줄을 쓰지 않고 대체 후보로 내려가지 않는다(설명 AI 경로만, 감시 AI는 그대로).
- **agy는 도구 없는 에이전트로 묶어야 부른다**: 틀에 `--agent kadan-noexec`가 없으면 호출하지 않고 대체 후보로 넘어가며(`template-error`), 작업 폴더에 에이전트 파일을 둘 수 없을 때도 같다([agy 묶기](#agy-도구-없는-에이전트-묶기)).
- **칸이 비었거나 1순위 실행기에 `exec` 틀이 없으면 아무것도 하지 않는다**(실패 닫힘). 운영 설정의 표가 비어 있으면 머지해도 운영 동작은 그대로다.
- 부르는 사건(카드 하나당 사건마다 한 번, 같은 입력이면 부르지 않는다): 발령(원장 `send`로 시작한 실행) · 완료(원장 `done`으로 끝난 실행) · 결과 등록(`card report`) · 막힘(표시 상태가 일시정지·실패·세션 확인 필요로 들어감, 발령됨은 10분 넘게 확인 안 된 것만) · 결정(요청 생성·답·취소). 화면 갱신·대시보드 조회는 AI를 부르지 않는다.
- **켜는 시점 이후 사건만** 본다. 칸을 처음 채운 뒤 감시기가 첫 주기에 `explain-state` 기록(`enabled`)을 남기고, 그 시각 이후에 일어난 사건만 대상이다. 옛 카드를 한꺼번에 부르지 않는다. 칸을 비우면 `disabled`가 남고 **대기열도 비운다**. 다시 채우면 그 시각부터 새로 세고, 대기열에서 꺼낼 때도 지금 켜진 시점과 사건 시각을 다시 대조한다.
- 입력 지문(`inputHash`): 프롬프트에 실제로 넣은 입력(제목·본문·표시 상태·최근 진행 보고·최근 결정·질문·답 메모·결과 판정과 지문·결정 문구, 비밀은 가린 뒤)의 지문이다. 설명 AI가 쓴 줄(`by`=`설명AI`)에 같이 남고, **신선도는 이 지문만으로 판단한다**(`sourceHash`로 대신 허용하지 않음): 지문이 지금 입력과 같으면 신선하고, 원장 완료·결정만 바뀌어 revision이 같아도 입력이 바뀌면 새 설명 전까지 요약·다음 일·막힌 이유를 숨긴다. 그래서 메모·담당 갱신으로 revision만 올라도 요약이 사라지지 않는다. 손으로 쓴 `card brief` 줄은 지금 규칙 그대로(revision·본문이 같을 때만 신선)다.
- 같은 입력 지문은 **시도 한 차례**(1순위 → 대체)만 한다. 시도 기록은 덧붙이기 전용 `explain-ai.jsonl`(`<KADAN_HOME>` 아래 스트림)의 `explain-call` 줄이고, 입력이 바뀔 때만 다시 시도한다. 프롬프트·출력 본문은 기록하지 않는다(시도마다 실행기·모델·결과·출력 바이트만).
- 내려가는 조건은 시간 초과·호출 실패만이다. 응답이 JSON이 아니거나 칸 규칙(stage 목록·1000자·필수 칸)을 어기면 줄을 쓰지 않고 사유(`not-json`·`field-rule:…`)만 남기고 대체 후보로 내려가지 않는다. `BriefStore.write`가 revision 불일치로 거절하면 오류가 아니라 생략이다. 카드를 다시 읽어 입력 지문이 그대로면 받은 답을 AI를 다시 부르지 않고 새 revision으로 쓰고, 달라졌으면 그 답을 버린다(`stale`). 어느 쪽이든 AI를 부른 입력은 "시도했다"로 남아 같은 입력으로 다시 부르지 않고(재시작 뒤에도), 새 입력은 다음 사건 때 처리한다. 호출 중인 카드·입력은 다음 주기에 다시 예약하지 않고, 호출 직전에도 시도 기록을 확인한다.
- 대기열: 감시 순회 안에서 사건 카드를 대기열에 넣기까지만 하고, AI 호출은 뒤에서 따로 돈다. **동시 1개·시도당 75초 상한·한 주기에 대기열로 넣는 카드 3장 이하**이며 감시 AI의 자리(동시 1개·5분)와 나누지 않는다. 느린 호출이 60초 순회를 늦추지 않는다.
- 카드 글은 구글·Anthropic 같은 외부 서비스로 나간다. 프롬프트에 들어가는 모든 글(제목·본문·담당·작성자·메모·결정 문구)과 완성된 프롬프트 전체에서 웹훅 주소(기존 `scrubSecrets`)와 토큰 모양(디코 봇·깃허브·`sk-`·Bearer)을 가린다. 결과 파일 발췌는 읽은 파일의 sha256이 등록값과 같을 때만 붙이고, 다르면 발췌를 빼고 그 사유를 입력에 적는다. `explain-ai` 비밀 파일은 agy·claude에 필요 없어 이번에 쓰지 않는다.
- 줄의 쓴 사람은 `설명AI`(`src/actors.mjs`)다. 사용자 행위자가 아니라 알림이 뜨거나 사람 판단처럼 보이지 않는다.
- 설정을 바꾸면 감시기를 다시 띄우지 않아도 다음 감시 주기부터 적용된다.

## 즐겨찾기

자주 고르는 실행기·모델·강도 조합을 목록으로 둔다. 역할·프리셋과 무관한 한 목록(`favorites`)이고, 발령은 이 목록을 읽지 않는다. 화면에서 세 칸을 매번 고르는 수고만 줄인다.

- 대시보드 '실행 모델'의 역할 바꾸기 칸(기본 실행 모델·대체 후보) 위에 즐겨찾기 버튼이 뜬다. 누르면 실행기·모델·강도를 채우고, 이유 칸이 비어 있으면 `즐겨찾기: <조합>`을 채운다. 저장은 여전히 **실행 모델 저장**(또는 **대체 후보 추가**)을 눌러야 되고, 그때 그 역할 기준 검사(차단·계열 등)를 모두 거친다.
- 추가: 기본 실행 모델 칸에서 조합을 고르고 **이 조합 즐겨찾기**. 삭제: **즐겨찾기 관리**의 **삭제**. 버튼 한 번이 저장 한 번이며, 이유는 화면이 `즐겨찾기 추가`·`즐겨찾기 삭제`로 채워 보낸다.
- 저장 검사: 목록 안의 실행기·모델, 모델이 지원하는 강도, 중복·변화 없음. 역할이 없으므로 정책 차단은 보지 않는다. 막힌 모델의 즐겨찾기 버튼은 그 역할 칸에서 눌리지 않는다.
- 다른 설정과 같은 공통 경로(revision 대조·이유 필수·원장 `runner-settings` 사건, `action: favorite`, `before`·`after`는 목록 전체)다. revision이 오르므로, 다른 역할 칸을 작성하던 중이면 "설정이 변경됐습니다" 안내가 뜬다. 즐겨찾기를 추가한 그 칸은 새 revision으로 이어서 저장할 수 있다. 다른 칸은 화면을 새로 읽어야 저장된다.
- 쓰기 주소는 `POST /runners/favorite`(`token`·`revision`·`reason`·`op`=`add`|`remove:N`, 추가면 `runner`·`model`·`effort`). 토큰·출처가 틀리면 403, 틀린 revision·빈 이유·목록 밖 값·강도·중복·없는 번호는 409.
- 예전 HTML 벽 화면(`runner-settings-wall`)에는 버튼이 없고, 최근 변경 표에 `즐겨찾기` 사건만 보인다.

## 실행기 명령 표

실행기마다 다른 "같은 대화 다시 열기·갈라 열기·한 번 호출·버전·업데이트·대화 ID 찾기" 지식을 코드에 흩어 두지 않고 `runners.<실행기>`에 **데이터**로 둔다(2026-10-14 [kyle]). 모두 선택이고, 빈 칸이면 그 기능은 "이 실행기는 … 미지원"으로 거절한다. 칸이 없는 옛 설정 파일은 그대로 읽힌다.

| 칸 | 뜻 |
| --- | --- |
| `resume` | `spawn` 틀 **뒤에** 대화 인자를 붙인 모양(`… --resume {conversation}`). 자리: `{model}`·`{effort}`·`{conversation}` |
| `fork` | 같은 모양으로 대화를 갈라 여는 틀(있으면 restart가 갈라 연 명령을 resume으로 바꾼다) |
| `exec` | 화면 없이 한 번 호출하는 틀(`{prompt}`가 있으면 인자, 없으면 표준 입력. `{prompt}`는 앞뒤가 공백인 독립 낱말이어야 하고 따옴표·글자에 붙이면 저장 단계에서 거절). **설명 AI가 이 틀로 부른다**([설명 AI](#설명-ai)). 시니어는 codex는 `senior.sh`, 허용 목록의 agy는 이 틀로 부른다. 감시 AI는 그대로 codex만 쓴다. `EXEC_BINDINGS`에 든 실행기(agy)는 틀에 `--agent kadan-noexec`가 있어야 한다 |
| `execField` | `exec`의 표준 출력이 JSON일 때 답이 든 필드 이름(`response`·`result`, 점으로 안쪽 필드). 비우면 표준 출력 전체가 답이다. 실행기마다 다른 출력 모양을 코드가 알지 않도록 표에 둔다 |
| `version`·`update` | 버전 확인·업데이트 명령 문자열. 카단은 실행하지 않는다 |
| `listModels` | 실행기가 자기 모델 목록을 내는 명령 틀(자리 `{…}` 없음, 예: agy는 `agy models`). 줄마다 **첫 낱말**을 모델 id로 읽고 이름 규칙(영문·숫자·`./-[]`)에 안 맞는 줄·중복은 버린다. 대시보드의 **목록 불러오기** 버튼을 누를 때만 한 번 실행한다(POST·토큰, 20초·256KiB 상한, 넘으면 프로세스 묶음 종료). 결과는 저장하지 않고 설정·원장에도 쓰지 않는다 |
| `conversation` | 지금 떠 있는 pane의 대화 ID를 찾는 법. 아래 두 종류 |

`conversation` 두 종류(코드의 일반 함수 둘):

- `{"kind":"open-file","pattern":"<정규식, 캡처 그룹 1개>"}` — pane 프로세스 트리가 열어 둔 파일 이름에서 ID를 뽑는다(`lsof`). 서로 다른 ID가 0개·2개 이상이면 거절.
- `{"kind":"pid-json","path":"~/…/{pid}.json","field":"sessionId","match":{"tmux":"{tmux}"}}` — 프로세스 트리의 PID별 JSON 파일에서 필드를 읽는다. `match`는 파일의 값이 이 역할의 tmux 자리(`세션:@창.%자리`)와 같은지 대조한다(다른 세션의 대화를 집지 않게). 파일이 0개·여러 개거나 값이 없으면 거절.
- 공통 선택 칸 `evidence`(open-file): 저장 여부와 무관하게 대화 ID를 드러내는 다른 파일(lock 등)의 정규식 목록(캡처 그룹 1개). 본체 사슬에서 서로 다른 ID가 둘 이상 보이면 restart가 거절한다. codex는 `thread-writer-locks/<ID>.lock`.
- 공통 선택 칸 `stored`: 다시 열 대화의 저장 파일(`~/…/*/{conversation}.jsonl`, 한 칸에 `*` 허용). 없으면 "아직 저장되지 않음"으로 거절 — restart가 끄기 전에 막는다.

### 2026-10-14 실측 기준 값(확인일·버전은 조사 결과 참고)

| 실행기 | resume | 대화 ID 출처 | 비고 |
| --- | --- | --- | --- |
| codex 0.155 | `… resume {conversation}` | 열린 `sessions/…/rollout-…-<ID>.jsonl` | **lock 파일(`thread-writer-locks`)은 ID를 고르는 데는 쓰지 않고 `evidence`로 다른 ID 흔적을 잡는 데만 쓴다.** 첫 입력 전에는 lock만 열려 있고 그 ID로 resume이 되는지 미실측이라, rollout이 열려야(=저장돼야) 찾아 restart가 첫 입력 전 세션을 끄지 않는다 |
| claude 2.1.299 | `… --resume {conversation}` | `~/.claude/sessions/<PID>.json`의 `sessionId` + `tmux` 일치 + `~/.claude/projects/*/<ID>.jsonl` 저장 확인 | 문서에 없는 내부 파일이라 버전이 바뀌면 모양이 달라질 수 있다. `/clear` 뒤에는 ID가 바뀌며 이 파일이 현재 값이다. 첫 입력 전에는 기록이 없어 거절 |
| agy 1.3.5 | `… --conversation {conversation}` | 열린 `antigravity-cli/conversations/<ID>.db` | 모델 이름에 강도가 들어 있어(`gemini-3.8-flash-low`) `{effort}`·`--effort`는 틀에 넣지 않았다(옵션은 존재하므로 필요하면 틀 한 줄로 추가). 이어 열 때 직전 프로세스의 presence 잠금이 남으면 "Conversation already open" 경고가 뜰 수 있으나 대화는 복원됐다 |
| omo 5.1.32 | `… --session {conversation}` (실측: 같은 대화 복원) | **칸 비움** | ID가 `~/.omo/agent/sessions/<폴더>/session-holders/<ID>/<PID>.json`의 **폴더 이름**이라 두 찾기 방식에 맞지 않는다. 대화 jsonl은 열려 있지 않다. 필요하면 세 번째 방식을 따로 결정 |
| devin 3000.11.3 | `… --resume {conversation}` | **칸 비움** | 첫 입력 전 resume 가능 여부를 실측하지 못해 비웠다. fork·exec JSON도 비움. `swe-2-max` 등 모델 목록은 건드리지 않았다 |

### 설명 AI용 `exec` 틀 (2026-10-15 실측 기준 값)

운영 설정에는 아직 넣지 않았다(채우기는 kyle이 정한다). 격리 홈에서 지어낸 카드 글로 실제로 돌아간 틀이다.

| 실행기 | `exec` | `execField` | 비고 |
| --- | --- | --- | --- |
| agy 1.3.5 | `agy --agent kadan-noexec --model {model} --print-timeout 90s --output-format json --print {prompt}` | `response` | **`--agent kadan-noexec`가 없는 틀은 카단이 거절한다**([agy 묶기](#agy-도구-없는-에이전트-묶기)). `--print`가 프롬프트를 인자로 요구한다(표준 입력만 주면 `--model`을 프롬프트로 읽고 거절 — 모델 호출 전에 끝). 모델 `gemini-3.8-flash-low`. `{prompt}`는 `"$KADAN_EXPLAIN_PROMPT"`로 채워져 명령줄에는 글이 안 보인다 |
| claude 2.1.300 | `claude -p --model {model} --tools "" --no-session-persistence --disable-slash-commands --strict-mcp-config --setting-sources "" --system-prompt "You are a concise assistant." --output-format json` | `result` | 표준 입력으로 프롬프트. 모델 `claude-haiku-5-5`. **`--bare` 금지**(구독 로그인을 건너뛰어 실패) |

표 칸은 `kadan runners runner <실행기> --table '<JSON>' --revision N --reason 이유`로 채우고(값이 null이면 비움), `agent-runners.json`의 실행기 항목에 같은 키를 두면 `runners init`이 함께 옮긴다.

### agy 도구 없는 에이전트 묶기

Why: kyle의 agy 사용자 설정 `permissions.allow`(cp|mkdir|ln|git add|git commit) 때문에, 헤드리스 agy에서도 카드 글 속 지시가 명령을 실행할 수 있다(exec-edf8a701, exec-22cb8058). 호출하는 폴더에 `tools: view_file`만 가진 에이전트를 두고 `--agent`로 부르면 명령 도구 자체가 없다(격리 실측 exec-af71d91d: 명령 0건, JSON 정상. exec-0e6d6310: 작업 폴더 밖 읽기는 도구 수준에서 거부, 표본 1건).

- **에이전트 이름 하나**: `kadan-noexec`. 정의는 코드 상수(`src/exec-agent.mjs`의 `NOEXEC_AGENT_MD`: `tools: [view_file]`, `commandExecutionPolicy: off`, `mainAgent: true`, `subagent: false`).
- **파일 관리**: agy를 부르기 직전, 그 호출의 cwd에 `.agents/agents/kadan-noexec/agent.md`를 정해진 내용으로 둔다(없으면 만들고, 다르면 고쳐 쓰고, 쓴 뒤 다시 읽어 확인). 기존 파일에는 쓰지 않는다(3라운드 N2): 같은 폴더에 새 임시 파일(`O_CREAT|O_EXCL|O_NOFOLLOW`)을 만들어 쓰고 fsync한 뒤 `rename`으로 바꾸고, `lstat`으로 일반 파일·링크 수 1을 확인한다(내용이 같아도 링크 수가 2 이상이면 새 파일로 바꿔 하드링크된 밖 파일이 덮이지 않는다). 부모 폴더를 같은 사용자가 경합으로 바꿔치기하는 경우는 막지 않는다(같은 사용자·0700 폴더 전제). 링크를 따라가지 않는다(2026-10-21 검수 F1): 폴더 3단계는 링크 아닌 진짜 디렉터리여야 하고(없으면 한 단계씩 0700으로 만든다), 파일은 링크 아닌 일반 파일이어야 하며(내용이 같아도 링크면 거절), 읽기·쓰기는 `O_NOFOLLOW`로 하고, 마지막에 실제 경로가 cwd 안인지 확인한다. cwd는 설명 AI는 `<KADAN_HOME>/explain-ai-work`, 시니어는 호출 폴더다. **쓰기·확인에 실패하면 agy를 부르지 않는다**(설명 AI는 그 시도를 `template-error`로 기록하고 대체 후보로 넘어간다, 시니어는 자문 실패).
- **틀 검사(데이터 표현)**: 코드 상수 표 `EXEC_BINDINGS`(프로그램 → `{program, agent, timeoutFlag, readDirFlag, flags}`)에 든 실행기는 `exec` 틀이 **셸이 공백 분리와 똑같이 읽는 단순 명령**일 때만 부른다(2026-10-21 검수 F2~F5). 검사를 셸만큼 똑똑하게 만들지 않고 받는 모양을 좁혔다. 규칙(하나라도 어기면 거절): 글자는 영문·숫자와 `_ @ % + = : , . / { } - 공백`만(`# ; & | $ \` ( ) < > ' "`·역슬래시·줄바꿈·글롭은 해석하지 않고 거절), 첫 낱말은 프로그램(이름의 대소문자·경로는 무관), 나머지는 `flags`에 든 옵션 + 값 1개 쌍만(agy는 `--agent kadan-noexec`(정확히 1번)·`--model`·`--print-timeout <숫자>s`·`--output-format json`·`--print {prompt}`). `--add-dir`·`--agent=…`·`--`·중복 옵션·그 밖의 낱말은 거절한다(`readDirFlag`는 `flags`에 없어 저장 검사에서는 거절된다. 시니어 코드가 실행 직전에 `--add-dir <정규화한 절대경로>`를 덧붙이면, 그 실제 틀의 검사에서만 코드가 넘긴 그 값 하나를 받는다. 설명 AI는 덧붙이지 않는다. 읽기 폴더 값은 절대경로·허용 글자만, 공백·메타문자·`{}`·`..`가 있으면 붙이지 않는다). 검사는 채우기 전 틀({model}·{prompt} 그대로)과 시간 치환을 거친 실제 틀 둘 다에 한다. 묶기 대상 판별은 **등록 키(소문자) 또는 틀 첫 낱말의 basename(소문자)**이 표에 있는지만 본다(`AGY`로 등록해도 같다). 다른 낱말은 보지 않으므로 `claude --model agy …`는 claude로 통과한다(2026-10-21 3라운드 N3). 저장(`runners runner …`, 화면 표 편집)도 **이번에 쓰는 그 실행기 행만** 같은 문법으로 거절한다(다른 행의 옛 틀 때문에 저장이 막히지 않는다). 호출 직전 검사가 최종 관문이다. **위협 모델과 범위 밖**: 막을 대상은 신뢰하지 않는 카드 글 속 지시가 agy의 허용 명령을 실행하는 것 하나이고, `--agent kadan-noexec`가 이를 막는다(실측). 실행 틀을 고치는 사람은 kyle·감독뿐인 신뢰 대상이라 틀 검사는 오설정 방지 수준이다. 신뢰된 작성자가 `{model}`·글롭·스크립트·`sh -c`·`env`로 일부러 숨긴 틀(다른 이름의 스크립트나 심볼릭 링크 뒤의 agy 포함)은 방어 목표가 아니다. 실행기 설정을 쓰는 것은 이미 감독 권한·revision·이유가 필요하고, 이 방어는 설정을 쥔 사람이 아니라 잘못된 설정을 막는다. 코드는 실행기 이름으로 갈라지지 않고 표를 읽는다(`CLAUDE.md`의 다중 provider 어댑터 금지). 이 표를 **운영 실행기 표의 칸으로 두지 않은 이유**: 운영 표에 칸이 없으면 '묶기 불필요'로 읽혀 검사가 열린다(fail open). 코드 상수는 운영 설정이 옛 틀이어도 닫힌다. 표에 없는 실행기(claude 등)는 검사하지 않는다.
- **머지~반영 사이 동작(중요)**: 이 변경을 머지해도 **운영 실행기 표는 그대로**다(옛 agy 틀, `--agent` 없음). 그동안 운영 설명 AI의 agy는 틀 검사에 걸려 호출되지 않고 **대체 후보(claude)로 간다.** 시니어에 agy를 고르면 호출 전에 거절된다. kyle 승인 뒤 아래 명령으로 운영 틀을 바꾸면 agy가 다시 쓰인다.
  ```
  kadan runners runner agy --table '{"exec":"agy --agent kadan-noexec --model {model} --print-timeout 90s --output-format json --print {prompt}"}' --revision N --reason "agy 도구 없는 에이전트 묶기"
  ```
- **재확인 스크립트** `scripts/check-agy-noexec.mjs`: agy 버전을 올린 뒤 사람이 돌린다(`node scripts/check-agy-noexec.mjs [--model gemini-3.8-flash-low]`). 격리 임시 폴더에서 agy를 3번 부른다(명령 실행 시도 / 폴더 밖 가짜 표식 읽기 / 지시 주입 모양). cp·ln·mkdir·git commit 0건, 가짜 표식 미노출, 요약 요청의 JSON 정상을 화면에 낸다(명령 도구가 없는 에이전트는 첫 두 호출에 JSON이 아니라 '못 한다'는 글로 답할 수 있어 JSON 판정은 요약 요청에만 쓴다)(종료 코드 0=통과, 1=실패, 2=시험 못 함). 원장에는 쓰지 않고 CI에도 넣지 않는다(인증 필요). 진짜 비밀 경로는 쓰지 않는다.

### 어댑터 금지와의 경계

`CLAUDE.md`의 "다중 provider 어댑터 금지"는 실행기별 코드 분기와 능력 심사 계층을 막는 규칙이다. 이 표는 `spawn`과 같은 수준의 **명령 문자열 데이터**이고, 코드(`src/runner-table.mjs`·`src/restart.mjs`)에는 실행기 이름으로 갈라지는 분기가 없다(시험이 코드 검색으로 확인). 코드가 아는 것은 틀 채우기와 대화 ID 찾기 일반 함수 둘뿐이고, 실행기 출력 해석은 표에 넣지 않는다. 새 실행기는 JSON 항목 추가로 끝난다. 남는 위험: `pid-json`은 지금 claude 하나만 쓴다 — 경로·필드·일치 조건이 데이터라 다른 실행기가 같은 모양이면 재사용된다. 예외로 `src/conversation-ref.mjs`(`conversationOf`)는 **이미 원장에 쌓인 옛 start를 다시 해석**하므로(append-only) 설정이 아니라 코드에 실행기별 옵션 읽기를 두며(claude·codex·agy·devin), 새 실행기를 표에만 넣으면 그 실행기의 resume start는 "새 대화"로 읽힌다.
