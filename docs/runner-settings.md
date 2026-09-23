# 실행 모델 설정

## Why

역할별 실행기·모델·강도를 한 곳에서 정하면, 사람이 발령하든 AI 감독이 발령하든 같은 값으로 뜬다. 기본값을 AI가 기억해 `--cmd`를 손으로 조립하던 방식을 대신한다.

- 1단계(2026-09-23 [kyle] 승인): 설정 파일, `kadan start --profile` 자동 채움, 다른 명령의 이유 기록, 같은 계열 거부, 원장 기록.
- 2단계(2026-09-23): 대시보드 '실행 모델' 화면에서 역할 값과 활성 프리셋을 바꾼다. 아래 [대시보드 화면](#대시보드-화면)을 본다.
- 3단계(폴백 목록 편집·`--fallback N`)는 아직 없다.

## 파일

`$KADAN_HOME/runner-settings.json`이 기계가 읽는 유일한 기준이다. 사람용 설명·결정 근거는 `agent-runners.json`에 둔다.

| 필드 | 뜻 |
| --- | --- |
| `revision` | 저장할 때마다 1씩 오른다. 읽은 revision과 다르면 저장을 거부한다 |
| `activePreset`, `presets.<이름>.roles` | 역할(`worker`·`reviewer`·`conductor`·`super`)별 `{runner, model, effort}` |
| `runners.<실행기>.spawn` | 실행 명령 틀. `{model}`·`{effort}`를 채운다 |
| `runners.codex.catalog` | `codex-models-cache`면 `~/.codex/models_cache.json`의 모델과 `supported_reasoning_levels`만 고를 수 있다 |
| `runners.<그 밖>.models` | 목록 파일이 없는 실행기는 실측한 `{model, efforts}`만 적는다 |
| `families` | 모델 이름 앞머리로 계열을 읽는 규칙 |
| `blocked` | 정책으로 막은 모델과 적용 역할 |

## 명령

```sh
kadan runners init --reason <이유>          # agent-runners.json의 실행기 틀만 옮겨 처음 만든다
kadan runners set worker --runner codex --model xai/grok-4.7-build-fast --effort xhigh --revision N --reason <이유>
kadan runners show                          # 역할별 값과 채워질 실행 명령
kadan runners runner claude --spawn '<명령 틀>' --revision N --reason <이유>      # 실행기 명령 틀(래퍼 포함)
kadan runners model claude claude-opus-5-5 --efforts low,medium,high,xhigh,max --revision N --reason <이유>  # 목록 파일이 없는 실행기의 실측 모델
kadan runners block gpt-6-astra --roles reviewer --revision N --reason <이유>      # 정책 차단(역할 생략 시 모든 역할)
kadan runners preset A --revision N --reason <이유>          # 활성 프리셋 전환(있는 프리셋만)
kadan start <역할> --profile worker          # --cmd 없이: 설정의 명령으로 띄운다
kadan start <역할> --profile worker --cmd '<명령>' --reason <이유>   # 설정과 다른 명령
```

- 역할은 실행기·모델·추론 강도 세 값으로 정한다. 실행기가 명령 틀을 정하고, 모델·강도가 틀을 채운다.
- `set`은 목록에 없는 모델, 지원하지 않는 강도, 정책으로 막은 모델, 작업자와 같은 계열의 검수자를 거부한다. 모르는 계열끼리는 막지 않는다.
- 모든 변경은 원장에 `runner-settings` 사건으로 남는다(`by`·`t`·`revision`·`before`·`after`·`reason`).
- `start`의 start 기록에는 `launchSource`(`settings`/`override`), `settingsRevision`을 남긴다. `override`면 `overrideReason`과 그때의 설정 명령(`settingsCmd`)도 남긴다.
- 설정 파일이 없으면 `start`는 예전처럼 `--cmd`가 필요하다. 인계 후임 생성은 선임 명령을 이유("인계: 선임 실행 명령 유지")와 함께 그대로 쓴다.
- `work auto-configure`는 작업자·검수자 세션을 실제로 띄운 모델의 계열이 같으면 거부한다.
- 설정을 바꿔도 떠 있는 세션은 그대로다. 다음 발령부터 적용된다. 자동 라우팅·자동 폴백은 만들지 않는다.

## 대시보드 화면

대시보드 위 메뉴의 **실행 모델**(`#runner-settings`)에서 명령어 없이 바꾼다.

- 활성 프리셋의 역할 4개(작업자·검수자·일반감독·슈퍼감독)마다 실행기 → 모델 → 추론 강도를 고른다. 선택지는 `set`과 같은 목록(codex는 모델 목록 파일, 그 밖은 실측 목록)에서만 온다. 실행기를 바꾸면 그 실행기의 모델만, 모델을 바꾸면 그 모델이 지원하는 강도만 남는다. 강도를 받지 않는 실행기는 "해당 없음"이다.
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
