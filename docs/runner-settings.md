# 실행 모델 설정

## Why

역할별 실행기·모델·강도를 한 곳에서 정하면, 사람이 발령하든 AI 감독이 발령하든 같은 값으로 뜬다. 기본값을 AI가 기억해 `--cmd`를 손으로 조립하던 방식을 대신한다.

- 1단계(2026-09-23 [kyle] 승인): 설정 파일, `kadan start --profile` 자동 채움, 다른 명령의 이유 기록, 같은 계열 거부, 원장 기록.
- 2단계(대시보드 화면)와 3단계(폴백 목록 편집)는 아직 없다.

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
kadan start <역할> --profile worker          # --cmd 없이: 설정의 명령으로 띄운다
kadan start <역할> --profile worker --cmd '<명령>' --reason <이유>   # 설정과 다른 명령
```

- `set`은 목록에 없는 모델, 지원하지 않는 강도, 정책으로 막은 모델, 작업자와 같은 계열의 검수자를 거부한다. 모르는 계열끼리는 막지 않는다.
- 모든 변경은 원장에 `runner-settings` 사건으로 남는다(`by`·`t`·`revision`·`before`·`after`·`reason`).
- `start`의 start 기록에는 `launchSource`(`settings`/`override`), `settingsRevision`을 남긴다. `override`면 `overrideReason`과 그때의 설정 명령(`settingsCmd`)도 남긴다.
- 설정 파일이 없으면 `start`는 예전처럼 `--cmd`가 필요하다. 인계 후임 생성은 선임 명령을 이유("인계: 선임 실행 명령 유지")와 함께 그대로 쓴다.
- `work auto-configure`는 작업자·검수자 세션을 실제로 띄운 모델의 계열이 같으면 거부한다.
- 설정을 바꿔도 떠 있는 세션은 그대로다. 다음 발령부터 적용된다. 자동 라우팅·자동 폴백은 만들지 않는다.
