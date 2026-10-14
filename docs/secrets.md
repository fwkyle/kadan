# 비밀값 위치 규칙 (`kadan secrets`)

## Why

카단을 다른 사람이 설치해도 디스코드 웹훅·봇 토큰·설명 AI 키를 **어디에 두는지** 정해져 있어야 한다. 기능마다 경로를 따로 받으면(`notify set discord --env-file` 같은) 다음 기능이 올 때마다 규칙이 늘어난다. 그래서 비밀 파일을 **이름**으로 부르고, 이름마다 같은 순서로 위치를 찾는다. 카단은 값을 저장하지도 출력하지도 않는다.

## 이름과 기본 위치

기본 폴더는 `$KADAN_HOME/secrets/`(권한 700), 파일은 `<이름>.env`(권한 600)이고 안에는 `KEY=VALUE` 줄만 둔다.

| 이름 | 기본 파일 | 쓰는 곳 |
|---|---|---|
| `discord` | `secrets/discord.env` | 사용자 알림 웹훅. `DISCORD_WEBHOOK_URL`·`DISCORD_USER_ID`·`DISCORD_WEBHOOK_URL_<레포>` → [사용자 알림](user-notify.md) |
| `discord-bot` | `secrets/discord-bot.env` | 디스코드 3단계(봇). `DISCORD_BOT_TOKEN`·`DISCORD_APPLICATION_ID`, 선택 `DISCORD_SECRETARY_CHANNEL_ID` → [디스코드 #비서 대화](discord-chat.md) |
| `explain-ai` | `secrets/explain-ai.env` | 설명 AI용. 지금은 비어도 된다 |

이름 목록은 코드 한 곳(`src/secrets.mjs`의 `SECRET_NAMES`)에만 있다. 알 수 없는 이름은 거절한다.

## 읽는 순서

이름마다 **환경변수 > 기계 설정 > 기본 위치** (창 설정·알림 설정과 같은 순서). 하나로 정해질 뿐 폴백 체인이 아니다.

1. 환경변수 `KADAN_SECRET_<이름 대문자, -는 _>_FILE` — `KADAN_SECRET_DISCORD_FILE`, `KADAN_SECRET_DISCORD_BOT_FILE`, `KADAN_SECRET_EXPLAIN_AI_FILE`. 값은 절대경로여야 한다.
2. 기계 설정 `$KADAN_HOME/secrets-setting.json` — 이름 → 절대경로만 저장한다(임시 파일 → rename, 권한 600).
3. 기본 위치 `$KADAN_HOME/secrets/<이름>.env`. 파일이 없으면 오류가 아니라 "아직 안 만듦"이다(디코는 시스템 알림만 쓴다).

`discord`에는 옛 이름이 별칭으로 남아 있다.

- 환경변수 `KADAN_NOTIFY_ENV_FILE` = `KADAN_SECRET_DISCORD_FILE`과 같은 자리. **둘 다 있으면 `KADAN_SECRET_DISCORD_FILE`이 이긴다.**
- 옛 알림 설정 `$KADAN_HOME/notify-setting.json`(`discord.envFile`)은 **그대로 읽힌다**. `secrets-setting.json`의 `discord`가 있으면 그쪽이 이긴다.
- 호환 방식: **읽을 때 변환**한다. 옛 파일을 옮기거나 지우는 이행 작업이 없다. 이유: 운영 홈에서 이미 `notify set discord`를 했으므로 새 코드로 재시작해도 알림이 끊기면 안 되고, 파일을 바꾸는 단계가 없으면 되돌릴 일도 없다. 새 명령(`secrets set discord`·`notify set discord`)은 `secrets-setting.json`에만 쓰고, `unset`은 두 파일 모두에서 `discord` 고정을 푼다(안 그러면 지운 경로가 옛 파일에서 되살아난다).

## 명령

```
kadan secrets show [이름]
kadan secrets set <이름> --file <절대경로>
kadan secrets unset <이름>
kadan secrets init
```

- `show`: 이름별 출처(환경변수·기계 설정·기본 위치), 경로, **키 이름만**, 권한 경고. 값은 보이지 않는다.
- `set`: 다른 경로를 가리킨다. 상대경로·알 수 없는 이름은 거절한다. 손상된 설정 위에는 쓰지 않는다(먼저 `unset`).
- `unset`: 그 이름의 고정만 푼다. 손상된 설정 파일도 지울 수 있다.
- `init`: 빈 `secrets/` 폴더를 700으로 만들고 끝. 값 파일은 만들지 않고, 이미 있으면 권한을 바꾸지 않는다. `kadan init`(처음 준비)도 같은 폴더를 만든다.
- `kadan notify set discord --env-file <경로>`는 `kadan secrets set discord --file <경로>`와 같은 설정을 쓰는 별칭이고, `notify unset`은 `secrets unset discord`와 같다.

## 권한 경고

파일이 600보다, 기본 폴더 `secrets/`가 700보다 넓으면 `show`와 읽을 때 경고 한 줄을 남긴다(알림은 `notify-log.jsonl`의 `warning`). **막지는 않는다.** 링크는 가리키는 실제 파일 기준으로 본다. 오류 문구에는 이름·경로·키 이름만 있고 값은 없다.

## 복사에서 빠진다

`$KADAN_HOME/secrets/`는 홈 전체 복사에 들어가지 않는다. `kadan storage export`·`import`·`activate`가 홈 **최상위** `secrets`(링크 포함)를 뺀다. 최상위가 아닌 같은 이름 폴더는 그대로 복사한다. 설정 파일(`secrets-setting.json`)에는 경로만 있고 값은 없지만, 사본에서 같은 경로를 가리키지 않도록 격리 시험에서는 가짜 파일과 가짜 링크만 쓴다.
