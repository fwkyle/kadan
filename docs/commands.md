# 명령어 사전

## Why

[kyle]과 에이전트가 카단 명령을 쓸 때, 어떤 명령이 있고 무엇을 하는지 한곳에서 찾게 한다.
명령마다 한 줄 설명과 자주 쓰는 옵션만 적고, 규칙·판단 기준은 링크한 상세 문서가 원본이다.

## 읽는 법

- 모든 옵션은 명령이 직접 알려 준다. 묶음 명령(`work`, `card`, `decision`, `inbox`, `runners`, `storage`, `hierarchy`, `watch-report`, `slot`, `limit`)은 `kadan <명령> --help`, 나머지는 대상 없이 실행하면 사용법이 나온다.
- `<역할>`은 세션 이름에서 `kadan-`을 뺀 부분이다(`kadan-비서` → `비서`).
- 명령이 PATH에 없으면 `node <저장소>/src/cli.mjs <명령>`으로 같은 일을 한다.
- 새 명령을 추가하면 이 표와 `src/cli.mjs`의 전체 사용법 줄을 같은 커밋에서 고친다.

## 환경 설정

| 변수 | 뜻 |
|---|---|
| `KADAN_HOME` | 원장·카드·설정이 사는 폴더. 기본 `~/.kadan` (옛 이름 `KADAN_LITE_HOME`도 읽음) |
| `KADAN_FLOOR` | 에이전트가 사는 바닥. `tmux`(기본). 로티는 바닥이 아니라 창(`KADAN_WINDOW=rottie`)이라 `rottie`를 주면 `KADAN_FLOOR_INVALID`다. 시험 기능 `herdr`는 별도 `KADAN_HOME`으로 명시 선택하며, 실행 중 전환·자동 폴백 없음 |
| `KADAN_HERDR_SOCKET` | herdr 시험 기능의 named server 절대 소켓 경로. `KADAN_HOME`과 함께 필수. 서버 자동 기동·훅 설치 없음. [실행 방법](experiments/herdr-roundtrip.md) |
| `KADAN_WINDOW` | tmux 바닥에서 시작할 때 여는 창. `none`(기본) · `rottie` · `orca`. 있으면 기계 설정(`kadan window`)보다 먼저다 |
| `KADAN_ROTTIE_BIN` | `KADAN_WINDOW=rottie`일 때 말 걸 로티 CLI의 절대경로. 있으면 기계 설정의 경로보다 먼저다 |

| `KADAN_SECRET_<이름>_FILE` | 이름별 비밀 파일의 절대경로(`KADAN_SECRET_DISCORD_FILE`·`_DISCORD_BOT_FILE`·`_EXPLAIN_AI_FILE`). 있으면 기계 설정(`kadan secrets`)보다 먼저다 → [비밀값 위치 규칙](secrets.md) |
| `KADAN_NOTIFY_ENV_FILE` | `KADAN_SECRET_DISCORD_FILE`의 옛 이름(별칭). 둘 다 있으면 `KADAN_SECRET_DISCORD_FILE`이 이긴다. 없으면 설정, 그다음 기본 위치(`$KADAN_HOME/secrets/discord.env`), 모두 없으면 시스템 알림만 쓴다 → [사용자 알림](user-notify.md) |
| `KADAN_NOTIFY` | `off`면 디스코드와 결정 알림, 사용자 우편함 알림을 보내지 않는다(시험용) |
| `KADAN_TEST_SYSTEM_NOTIFY_TIMEOUT_MS` | **시험 전용, 운영에서 설정하지 않는다.** 맥 시스템 알림(osascript) 한 건을 기다리는 상한(밀리초)을 늘린다. 1000~120000 정수만 받고 그 밖의 값은 기본 3000 |
| `KADAN_SOCKET` | tmux 구획 이름. 기본 `kadan` (`tmux -L kadan`). `KADAN_HOME`이 기본 홈(`~/.kadan`, 링크면 실제 경로)이 아닌데 이 값이 없거나 `kadan`이면 tmux 호출을 `KADAN_LIVE_FLOOR_DENIED`로 거절한다(시험이 운영 창으로 새는 것을 막는 장치). 기본이 아닌 홈에서는 격리 이름을 주고, `KADAN_WINDOW=rottie`·`orca`도 기본이 아닌 홈에서는 같은 이유로 거절한다 |
| `KADAN_ALLOW_LIVE_FLOOR` | `1`이면 위 거절을 끈다. 기본이 아닌 홈으로 운영 구획·창을 일부러 다룰 때만 쓴다 |
| `KADAN_ROLE` | 카단 세션 안에서 자동으로 붙는 자기 역할. 원장의 `by`가 된다 |

창 선택의 읽는 순서는 **환경변수 > 기계 설정(`$KADAN_HOME/window-setting.json`) > 기본 `none`** 이다. 값이 하나로 정해지는 우선순위이며 실패하면 다른 창으로 넘어가는 폴백이 아니다. 로그인 자동 시작과 대시보드의 '비서 켜기'는 `KADAN_WINDOW=none`을 명시하므로 설정이 `rottie`여도 창 없이 뜬다. `KADAN_WINDOW=""`처럼 빈 문자열은 미지정으로 보고 설정이 채워진다. **설정 파일이 손상**(깨진 JSON·잘못된 창 값·상대 로티 경로)이면 창을 여는 명령(`start`·`attach`·`handover`·`adopt`·`up`·`restore`)은 역할·창을 만들기 전에 `WINDOW_SETTING_CORRUPT`와 복구 명령을 알리고 종료 코드 2로 멈춘다. 다른 창으로 넘어가지 않는다. 단 `KADAN_WINDOW`가 비어 있지 않게 주어지면 그 값이 창을 정하므로 막지 않는다(`KADAN_WINDOW=rottie`인데 `KADAN_ROTTIE_BIN` 환경변수가 없어 설정의 경로가 필요할 때는 멈춘다). `send`·`status`·`read`·`watch`·대시보드처럼 창과 무관한 명령은 경고만 하고 진행한다. 복구는 `kadan window unset`(손상 파일도 지운다) 또는 `kadan window set ...`.

## 처음 준비

| 명령 | 하는 일 | 자주 쓰는 옵션 |
|---|---|---|
| `kadan init` | 환경 확인, 스킬 링크, 실행기 선택. 처음 한 번 | `--runner codex\|claude`, `--no-skills` |
| `kadan up` | 비서 세션과 대시보드 세션을 띄운다. 살아 있으면 그대로 쓰며, 이전 Codex 비서는 저장된 대화로 복원한다. tmux에서는 데이터 폴더에 기본 감시 프로필(`watch-profile.json`)이 있고 감시 프로세스가 없을 때 감시기도 세션 `kadan-watch`에 띄운다(재부팅 뒤 자동 시작에서 감시기가 빠지지 않게, 2026-10-13) | `--cmd <실행기 명령>`, `--port 8790`, `--hidden`, `--no-prompt` `--auto`는 launchd가 1분마다 부르는 자동 실행이다: 살아 있는 것은 그대로 두고 꺼진 기반 프로세스 4개(비서·대시보드·디코 다리·감시기)만 다시 띄운다. 사람이 `kadan stop`으로 끈 대상과 1시간에 3번 넘게 꺼진 대상(상한)은 건너뛰고, 바뀐 것이 있을 때만 출력한다. `--auto` 없이 친 `kadan up`은 그 멈춤을 모두 풀고 상한 집계를 새로 센다. 프로세스가 죽어 창만 남은 감시기·다리 세션은 마지막 화면을 `<데이터 폴더>/revive/`에 저장하고 치운 뒤 다시 만든다(감시기·다리 세션은 `remain-on-exit`를 켠다). 세션의 모든 창이 죽었을 때만 세션을 치운다(살아 있는 창이 하나라도 있거나 조회에 실패하면 지우지 않고 막힘으로 한 번 울린다). 다시 띄운 기록은 원장 `revive` 사건(`by autostart`)이고 start 사건이 아니다. 조용한 되살림 알림은 디코로만 보내고 맥 알림으로 대신하지 않는다(못 보냈으면 사건의 `notice`와 로그에 남긴다). 상한·막힘·손상 경보는 울림이며 맥 알림으로 대신한다. 기반 4개의 `kadan stop`도 같은 `revive.lock` 아래에서 멈춤 표시를 먼저 저장한 뒤 끈다(잠금을 못 잡으면 끄지 않고 안내하며, 끄기가 실패하면 표시를 되돌린다). 주인이 죽었거나(좀비 포함) pid 없이 2분 넘은 잠금은 되찾고 `autostart.log`에 한 줄 남긴다. `revive-state.json`이 깨지면 `--auto`는 모든 대상을 건너뛰고 한 번 울리며, 사람이 친 `up`·`stop`이 깨진 파일을 `<데이터 폴더>/.trash/`로 옮기고 새로 시작한다. 같은 때 자동 실행과 손으로 친 `up`이 겹치지 않게 `<데이터 폴더>/revive.lock`을 쓴다. 재부팅 뒤 로그인 시작이면 4개가 한꺼번에 되살아나 조용한 알림이 4건 나가고 1시간 창의 1번으로 센다. 사람이 친 `up`은 `gui/dist/index.html`을 읽을 수 없으면(대시보드 주소가 503이 되는 원인) 주소 다음 줄에 `경고: 대시보드 화면 빌드가 없다 — npm --prefix gui ci && npm run build:gui` 한 줄만 낸다. 빌드를 대신 돌리지 않고 종료 코드도 바꾸지 않으며, `--auto`는 내지 않는다 |
| `kadan doctor [--json]` | **읽기 전용 한 방 점검.** 막힌 곳과 풀려면 칠 명령을 한 줄씩 보인다. 카단의 데이터와 상태(원장·설정·체크포인트·잠금)를 바꾸지 않고 tmux 세션도 만들지 않는다(`--fix` 없음). 원장 SQLite의 `-wal`·`-shm`과 tmux 런타임 폴더는 `kadan status` 같은 다른 읽기 명령처럼 생길 수 있다. 한 줄 꼴은 `항목 \| 상태 \| 이유 \| 풀려면: 명령`, 상태는 정상·해당 없음(선택 기능을 안 깐 정상)·주의·막힘·확인 불가(조회 자체 실패). 점검 11개: node·tmux, 대시보드 화면(`gui/dist/index.html`을 읽을 수 있는지), 데이터 폴더·원장, 기반 프로세스 4개와 되살리기 멈춤 표시, 비서 복원 체크포인트(codex 비서만 대상, claude 비서는 해당 없음), 로그인 자동 시작, 창·모델 설정 손상, 비밀 폴더 권한(값은 읽지 않음), 운영 바닥 거절 장치(기본이 아닌 `KADAN_HOME`일 때만), 스킬 링크, 복원 잠금 잔류(경로만 보이고 지우지 않음). 막힘이 하나라도 있으면 종료 코드 1, `--json`은 같은 내용을 JSON으로 낸다. 막히면 먼저 이것부터 → [복구](recovery.md) | `--json` |
| `kadan window show\|set rottie [--rottie-bin <절대경로>]\|set none\|unset` | 창 선택(로티/백그라운드)을 이 기계의 `KADAN_HOME`에 고정한다. 환경변수를 못 물려받은 AI 셸도 같은 값을 읽는다. `rottie`에는 로티 실행 파일의 절대경로가 필요하다(`--rottie-bin` 또는 환경변수 `KADAN_ROTTIE_BIN`). 설정이 없고 켜진 로티가 보이면 `start`가 stderr로 고정 명령을 안내하지만 자동으로 고르지 않고 시작도 막지 않는다. 설정 파일은 자동으로 고쳐 쓰지 않는다 | `--rottie-bin` |
| `kadan stop-hook claude-settings\|status` | Stop 훅 빠른 길. `claude-settings`는 `$KADAN_HOME/stop-hook/claude-settings.json` 한 파일만 만든다(이 체크아웃의 `scripts/stop-hook.sh` 절대 경로가 들어가므로 main에서 실행). 파일이 있으면 새로 띄우는 claude 역할 명령에 `--settings`가 붙는다. `status`는 읽기만: claude 파일, codex `hooks.json`·신뢰 상태, 훅 증거 파일을 보인다. codex 쪽 설치는 사람이 한다 → [Stop 훅](stop-hook.md) | — |
| `kadan secrets show [이름]\|set <이름> --file <절대경로>\|unset <이름>\|init` | 비밀 파일(`discord`·`discord-bot`·`explain-ai`)의 위치 규칙. 읽는 순서는 환경변수 `KADAN_SECRET_<이름>_FILE` > 기계 설정(`$KADAN_HOME/secrets-setting.json`) > 기본 `$KADAN_HOME/secrets/<이름>.env`. `show`는 출처·경로·키 이름·권한 경고만 보이고 값은 보이지 않는다. `init`은 빈 `secrets/`(700)만 만든다. `storage export`·`import`·`activate`는 이 폴더를 복사하지 않는다 → [비밀값 위치 규칙](secrets.md) | `--file` |
| `kadan notify show\|set discord --env-file <절대경로>\|unset` | **`kadan secrets set discord --file`의 별칭.** 사용자 알림을 디스코드로 보낼 **비밀 파일 하나**의 경로만 이 기계의 `KADAN_HOME`에 고정한다(읽는 순서: 환경변수 `KADAN_SECRET_DISCORD_FILE` > `KADAN_NOTIFY_ENV_FILE` > 새 설정 `secrets-setting.json` > 옛 설정 `notify-setting.json` > 기본 위치 `secrets/discord.env`). 파일의 키: `DISCORD_WEBHOOK_URL`(기본 #브리핑), `DISCORD_USER_ID`, `DISCORD_WEBHOOK_URL_<레포>`(레포 이름을 대문자로, `-` 등 영숫자 아닌 글자는 `_`: `my-app` → `_MY_APP`. **포럼 채널** 웹훅). 레포 키는 업무 키(`저장소/업무`)가 있는 알림에만 쓰인다: 업무마다 포럼 글 하나를 `thread_name`(업무 키+제목, 100자 안)으로 만들고 그 글 id를 `$KADAN_HOME/notify-threads.json`에 `업무 키 → 글 id`로 기록해 다음부터 `thread_id`로 이어 붙인다(글이 지워져 4xx면 새 글 한 번). 업무 키가 없는 알림, 레포 키가 없는 레포는 기본 웹훅이다. 레포 키 형식이 틀리면 기본으로 새지 않고 시스템 알림으로 내려간다. `DISCORD_WEBHOOK_URL_SECRETARY`(#비서)는 알림에는 쓰지 않고, 3단계 대화(`kadan discord`)가 #비서 채널 ID를 얻는 데만 쓴다 → [사용자 알림](user-notify.md) | `--env-file` |
| `kadan discord watch [--once] [--interval 초] [--to-mail [역할]]\|send [텍스트] [--reply-to 메시지ID\|--thread 스레드ID] [--edit 메시지ID] [--quiet]\|thread <스레드ID> [--rename 이름] [--archive]\|check` | 디스코드 #비서 대화(3단계, 조회·답변만). `watch`는 봇 REST 주기 조회(기본 5초)로 `DISCORD_USER_ID` 한 명의 새 글을 JSON 한 줄씩 낸다(감시 도구가 있는 실행기가 구독). `--to-mail [역할]`(기본 비서)이면 줄 대신 **우편함에 저장**하고(보낸이 `디코`, 우편이 저장돼 우편 ID가 돌아오면 출력 완료, 같은 글 id는 원장에서 거름), `kadan up`이 이 모드의 다리 세션 `kadan-디코`를 보장한다(`discord-bot` 비밀값이 있을 때만, 끄기는 `kadan stop 디코`). 인용·전달은 `quoted`로 표시, 읽음 반응 👀, 처음은 기준선만, 상태는 `$KADAN_HOME/discord-chat-state.json`. `send`는 2,000자 단위로 나눠 보내고 `--reply-to`로 새 주제에 스레드를 열며 `--edit`로 자기 글을 고친다. `--thread`·`thread`는 #비서 또는 `DISCORD_WEBHOOK_URL_<레포>`로 등록한 레포 포럼 채널의 스레드만 되고(그 밖은 거절), 채널에 바로 쓰는 새 글과 `--reply-to`는 #비서만 된다. `watch`는 등록한 레포 포럼 스레드 안의 kyle 글도 받는다(처음 등록하면 기준선부터라 옛 글은 받지 않는다). 새 글은 기본으로 kyle을 멘션해 휴대폰이 울리고(나뉘면 첫 조각만), `--quiet`는 멘션 없이 조용히, 고치기는 울리지 않는다. `check`는 봇·채널·등록한 레포 포럼·Message Content Intent를 값 없이 점검한다. 비밀은 `kadan secrets`의 `discord-bot`·`discord`. 실제 디스코드로 나가지 않게 `KADAN_NOTIFY=off`면 `KADAN_DISCORD_API_BASE` 없이는 거절 → [디스코드 #비서 대화](discord-chat.md) | `--once` `--interval` `--to-mail` `--reply-to` `--thread` `--edit` `--quiet` `--thread-name` `--stdin` `--rename` `--archive` |
| `kadan autostart show\|status\|install\|remove` | macOS에서 로그인할 때 `kadan up --hidden --auto`를 창 없이(`KADAN_WINDOW=none`, 로그인 직후엔 로티가 없으므로) 한 번, 그 뒤 60초마다 `kadan up --hidden --auto`로 실행하는 LaunchAgent(`~/Library/LaunchAgents/dev.kadan.up.plist`)를 관리한다. KeepAlive는 쓰지 않고, 주기 `up --auto`가 꺼진 기반 프로세스 4개만 되살린다(AI 역할은 아님). 설치된 plist가 새 내용과 다르면 `status`가 '다름'을 보이고, 바꾸려면 `remove` → `install` → `launchctl` 재적재를 사람이 한다. `show`는 만들 파일만 보여 주고, `install`은 없을 때만 쓰며, `remove`는 지우지 않고 `<데이터 폴더>/.trash/`로 옮긴다. 설치 때의 PATH·`KADAN_*` 환경과 현재 폴더를 적어 둔다 | — |

## 역할(세션) 다루기

| 명령 | 하는 일 | 자주 쓰는 옵션 |
|---|---|---|
| `kadan start <역할>` | 바닥에 세션을 만들고 창을 연다. 이미 살아 있으면 창만 다시 연다. `--profile`을 달고 **새로 만든** AI 실행기 세션이면 화면이 안정된 뒤 그 프로필의 지침이 붙은 첫 안내(super→`kadan-super`, conductor→`kadan-conductor`, secretary→`kadan-secretary`, worker·reviewer→카드 계약)를 내부 `send`로 한 번 보낸다. 재사용 세션·`--no-prompt`·`--cmd sh` 같은 비 AI 명령·같은 대화를 `--resume`으로 이어 연 세션과 새 대화인지 확실하지 않은 명령은 보내지 않고(새 대화로 확실함 = 알려진 실행기에 `--model`·`--effort`·`-c` 설정 같은 알려진 무해 옵션만 있거나 실행기 이름만 있는 경우. 모르는 옵션·`resume` 하위 명령·첫 프롬프트가 있으면 보내지 않음), 못 보내도(화면 대기 시간 초과 등) 한 줄만 알리고 종료 코드 0이다. `kadan up`의 비서 첫 안내도 이 경로다(`kadan restart`는 늘 같은 대화로 이어 열어 보내지 않음) | `--profile worker\|reviewer\|conductor\|super\|secretary`, `--cmd <명령> --reason <이유>`, `--fallback N --reason <이유>`, `--hidden`, `--no-prompt`(첫 안내 생략), `--parent <상위\|@user>`(만든 역할 대신 이 상위로 관계표에 등록. `--profile super`는 없으면 `@user`. 예전에 쓴 이름을 새 대화로 다시 쓰면 관계표의 자기 상위 줄을 이번 상위로 바꾼다), `--inherit-mail`(예전에 쓴 이름이면 바로 앞 세대 하나의 미확인 우편과 업무·카드 책임을 이어받음. 같은 대화를 `--resume`으로 다시 여는 명령이면 자동으로 이어감, `--fork-session`·새 대화는 끊음). 새 이름이 `<레포>-`로 시작하지 않으면 경고, 예전 이름이면 이전 세대 우편을 넘겨받지 않았다고 알림([이름 규칙·세대](hierarchy.md#역할-이름-규칙과-같은-이름-재사용-2026-10-13)) |
| `kadan mail <역할> <메시지>` | 우편 전용. 실행 주소를 연결해도 발령으로 바뀌지 않는다. `--task`는 거절 | `--work`·`--execution`(연결 주소), `--expect-reply`, `--reply-to <우편ID>`, `--reply-final`, `--raw` |
| `kadan dispatch <역할> --task <카드ID> <지시>` | 카드 발령 전용. 카드 필수, 기존 배정·범위·수신자·실행기 검사 유지. 질문·답장·저장 우편은 거절 | `--work`, `--execution`(같은 카드 확인), `--allow-old-runner <이유>`, `--raw` |
| `kadan send <역할> <메시지>` | 기존 호환 명령. `--task` 또는 수신자의 배정 카드를 가리키는 `--execution`으로 발령 가능 | 기존 옵션 유지. 새 호출은 우편 `mail`, 발령 `dispatch` 권장 |
| `kadan adopt <감독이름>` | 앱·터미널에서 이야기하던 AI 대화를 복제해 카단 감독 세션으로 이어 연다(Claude Code는 `--resume <ID> --fork-session`, Codex는 `fork`). 대화 ID·생각 강도는 Claude Code에서 자동으로 읽고, 현재 권한도 이어받는다. 상위는 기본 사용자. 새 감독의 인수 확인 뒤 정확히 식별한 원본 Rottie 탭을 닫는다([인수 절차](adopt.md)) | `--model <모델>`(필수), `--resume <대화ID> --harness claude\|codex`, `--effort`, `--parent @user\|<역할>`, `--profile conductor\|super`, `--hidden`, `--no-prompt`, `--inherit-mail` |
| `kadan adopt accept <인수ID>` | 새 감독이 이어받은 목표·승인 범위와 다음 행동을 확인한다. 새 감독 프로세스·실제 권한과 원본 탭을 대조한 뒤 원본 탭을 닫고 목록에서 제거한다 | `--summary "<한 문장>"` |
| `kadan adopt status <인수ID>` | 인수 대기·확인·원본 탭 정리 결과를 읽는다. 비서도 같은 기록으로 확인한다 | — |
| `kadan wait <역할>` | 완료 마커(DONE)나 조용함을 보고한다. 판정하지 않는다 | `--timeout 초`, `--quiet 초`, `--interval 초` |
| `kadan done <역할> <카드id> <ok\|failed>` | 사람·감독이 확인한 완료를 원장에 적는다. 한 번 발령으로 끝나는 카드는 `--close-card`로 카드도 함께 닫는다([카드 닫기](card-center.md#실행-완료와-카드-닫기)) | `--from-screen`(결과 대신 작업자 화면의 DONE을 읽어 확정. 짧은 카드id·정식 주소·응답 머리표 `•`/`⏺` 모두 인정, 그 카드 마지막 발령 전부터 있던 마커는 제외. 없으면 기록·전송 없이 종료 코드 3), `--wait <초>`(`--from-screen`과 함께. 마커가 없으면 2초 간격으로 화면만 다시 읽는 유한 대기, 최대 600. 완료 편지가 마커보다 먼저 오는 경합용이며 시간이 다 되면 종료 코드 3 그대로), `--close-card`(ok 확정 뒤 카드 `done`, 실패해도 실행 완료 유지), `--note <이유>`(카드 기록 이유) |
| `kadan read <역할>` | 화면 끝부분을 읽는다. 입력칸 모양이 확인된 흐린 추천은 `(추천 문구: …)`로 보이고, 애매하면 원문을 보존한다 | `--lines N` |
| `kadan status` | 살아 있는 세션, 창 붙음 여부, PID 일치, 실행기·모델 | — |
| `kadan attach <역할>` | 살아 있는 세션에 창을 하나 더 연다 | — |
| `kadan restore [역할...]` | 로티 데몬 재시작 뒤, 기록된 로티 탭이 죽은 살아 있는 세션에 새 탭을 붙인다 | `--dry-run` |
| `kadan restart <역할>` | 살아 있는 역할의 프로그램만 다시 띄우고 대화 기억은 유지한다. 같은 이름·같은 대화(resume)·같은 작업 폴더·같은 모델 옵션이라 우편·책임 세대·관계표가 끊기지 않는다. 대화를 확정하지 못하면 기존 세션을 끄지 않고 거절한다([자세히](#kadan-restart-자세히)) | `--force`(끝나지 않은 카드가 있어도 진행, 사람 확인용), `--reason <이유>`(stop·start 기록에 이유), `--expect-pid <pane PID>`(세대 대조, 화면용) |
| `kadan stop <역할>` | 카단이 만든 세션만 끝내고 연결된 로티 탭을 닫는다. 미확정 카드가 있으면 알린다 | — |
| `kadan hierarchy prune` | 끝난 역할의 관계를 정리할 후보와 보존 이유를 표시한다. [정리 기준](hierarchy.md#끝난-역할-정리) | `--apply`(백업 후 적용), `--file <절대경로>`(복사본 등 대상 지정) |

### 우편과 발령 선택

- 맥락·질문·답장·보고는 `mail`, 실행 카드 발령은 `dispatch --task`를 쓴다.
- 두 명령은 인자에 본문이 없으면 표준 입력을 읽고, `--help`로 사용법을 보여 준다.
- `mail --execution`은 우편에 실행 주소만 연결한다. `--task`는 빈 값이나 값 없는 옵션도 거절한다.
- `dispatch`는 카드 ID 한 개를 요구하며 `--execution`만으로 추론하지 않는다.
  비서·사람 우편함 대상, `--expect-reply`, `--reply-to`, `--reply-final`은 거절한다. 옛 `--mailbox`는 받되 무시하고 알린다.
- 기존 `send`는 동작을 바꾸지 않는다. 터미널로 보내는 `send --execution`은 연결 카드가 수신자에게
  배정되어 있고 `--reply-to`·`--expect-reply`가 없으면 발령으로 추론한다. 새 우편에 이 명령을 쓰지 않는다.
- 전송·원장·읽음 확인·발령 감시는 기존 경로를 재사용한다. 원장의 `send` 사건 이름은 바뀌지 않는다.

### `kadan stop`의 로티 탭 정리

tmux 세션을 종료한 뒤 원장의 최신 탭 ID를 조회하고, `terminal close` → `terminal remove` 순서로 닫고 목록에서 지운다. `restore`로 새 탭을 붙였다면 그 탭을 쓴다.

- 로티 실행 파일이 없어졌거나 연결되지 않으면 `start`와 같은 규칙으로 경로를 교정한다. 실행 중인 후보가 정확히 하나이고 연결될 때만 바꾸며, `KADAN_ROTTIE_AUTO_ATTACH=off`이면 바꾸지 않는다. 앱을 새로 켜지는 않는다.
- 원장에 기록된 탭을 조회하지 못하면 닫기·제거를 보내지 않는다. 로티 탭 기록이 없으면 로티를 조회하지 않는다.
- 탭 정리에 실패하면 세션 종료 사실과 실패 이유를 표준 오류에 알리고 종료 코드 `1`을 반환한다. `stop` 원장에는 닫기·제거 결과와 경로 교정 내역을 남긴다.
- 이때 tmux 세션은 이미 종료됐으므로 같은 `stop`을 다시 실행해도 탭 정리가 재시도되지는 않는다. 원장에 남은 탭 ID와 실패 원인을 확인해야 한다.

### `kadan restore` 자세히

로티 데몬을 다시 켜면 tmux 세션(에이전트)은 살고, 그 세션을 보여 주던 로티 탭만 끊긴다. `restore`는 탭만 다시 붙인다.

- 바닥이 tmux이고 `KADAN_WINDOW=rottie`일 때만 쓴다.
- 세션마다 원장에 적힌 로티 탭 상태를 로티에 묻는다. `running`·`created`면 건너뛰고, `unknown`·`closed`·`exited`이거나 탭이 없으면 새 탭을 붙인다.
- 마지막 `start`에 로티 탭이 없는 세션(숨김으로 띄운 watch·대시보드)은 건너뛴다.
- 탭 조회가 하나라도 실패하면 아무것도 하지 않고 이유를 보고한다.
- 새 탭 번호는 원장에 `window` 기록으로 남는다. 이후 `stop`은 새 탭을 닫는다. 죽은 옛 탭은 한 번 지워 보고, 실패하면 알리기만 한다.
- 실측: 2026-09-24 데몬 실제 재시작에서 세션 5개를 되살렸고 에이전트 PID는 그대로였다.

## 판과 현황 보기

| 명령 | 하는 일 | 자주 쓰는 옵션 |
|---|---|---|
| `kadan plan <판> <카드id[:제목]>...` | 판을 열 때 카드 목록을 원장에 먼저 적는다 | `--about "<판 설명>"` |
| `kadan tree` | 판·카드·실행·살아 있는 역할 요약(JSON) | `--legacy`(옛 세션 나무) |
| `kadan log` | 원장 최근 30줄 | — |
| `kadan wall` / `kadan dashboard` | 로컬 관제 화면(HTML)을 띄운다 | `--port 8790`, `--cache-sec 초` (같은 주소 응답 재사용, 기본 10) |

## 감시

| 명령 | 하는 일 | 자세히 |
|---|---|---|
| `kadan watch` | 정체·끊김·완료 후보를 감독에게 알리는 감시를 돌린다. `--hierarchy`가 있으면 하루 한 번 관계표를 자동 정리한다(`--hierarchy-prune off`로 끔) | [감시 기준](watch-overview.md), [제한 재개](rate-limit-retry.md), [책임 관계](hierarchy.md#감시기의-하루-한-번-자동-정리-2026-10-12) |
| `kadan watch-report [호출ID]` | 감시 AI가 판정 결과를 돌려준다 | `--verdict 진행중\|입력대기\|실행완료\|응답장애\|정체\|모름\|조정 --reason <이유>` (`죽음`은 옛 규약 호환으로 받되 새 보고에서는 거절). 호출ID는 생략하면 환경·점검 폴더에서 읽고, 넘긴 ID가 원장에 없는 값(오타)일 때만 그 값으로 복구한다 |

## 업무·카드·결정

| 명령 | 하는 일 | 자세히 |
|---|---|---|
| `kadan work` | 결과 중심 업무 한 장과 그 안의 실행. `create`·`list`·`show`·`update`·`execute`(`--assign <역할> [--dispatch "<지시>"]`로 생성·배정·묶음·plan·전송을 한 번에)·`link`/`unlink`·`mail`·`complete`/`cancel`·`reopen` | [업무 카드와 실행](business-work.md) |
| `kadan work auto-*` | 구현·검수 자동 전달. `auto-configure`·`auto-show`·`auto-run`·`auto-report` 등 | [자동 전달](automatic-review.md) |
| `kadan card` | 중앙 카드. `list`·`show`·`create`·`update`·`note`·`brief`·`progress`·`report`·`link` 등 | [중앙 카드](card-center.md) |
| `kadan decision` | 사용자 결정 요청. `request`·`list`·`show`·`answer`·`cancel`. 답은 디코 레포 포럼의 요청 글에 번호·정확한 문구로 답해도 다리가 같은 `answer` 경로로 기록한다(답에 `source`·`messageId`가 남는다) → [디코에서 결정 답하기](discord-chat.md#디코에서-결정-답하기) | [결정 기록](decisions.md) |
| `kadan senior <카드키> --question <질문>` | 작업 결과에 결정할 부분이 있을 때 감독이 **등록된 시니어 전원(최대 2명)에게 동시에** 의견을 한 번 묻고 모델별 답을 받는다(감독은 모델을 고르지 않는다). `--file <절대경로>`(5개·64KB까지), `--timeout <초>`(기본 1800), `--effort <강도>`(이번 호출만, 부르는 모델마다 검사, 실측 시험은 low), `--runner/--model`(등록된 시니어 한 명만 고를 때, 등록 밖은 거절) | [시니어](senior.md) |

## 우편

| 명령 | 하는 일 | 자세히 |
|---|---|---|
| `kadan inbox` | 역할 우편함 조회. `list`·`received`·`sent`·`to-reply`·`waiting`·`read`·`ack`·`cancel`. 기본 목록은 같은 이름의 새 세션이 시작되기 전 미확인(이전 세대)을 빼고 `--previous-generations`로 따로 본다(키로 한 번도 못 넣고 보관된 새 우편은 예외로 새 세션에도 보인다) | [우편함 명령](secretary-mailbox.md), [원장 계약](mail-task-ledgers.md) |

보내기는 `kadan mail <역할> …`다. 받는 세션이 없으면 아는 역할에는 자동 보관한다(`--mailbox`는 더 이상 쓰지 않으며 붙여도 무시). 조회는 읽음 처리하지 않고, `ack`가 읽음만 표시한다.

## 운영 설정·저장

| 명령 | 하는 일 | 자세히 |
|---|---|---|
| `kadan runners` | 역할별 실행기·모델·폴백 순서 설정. `show`·`init`·`set`·`runner`·`model`·`block`·`preset`·`fallback` | [실행 모델 설정](runner-settings.md) |
| `kadan handover <선임> --to <후임> …` | 담당 인계. `accept`·`finish`·`status`·`abort` | [인계 안내](handover.md) |
| `kadan storage` | 원장 저장소 점검·전환. `inspect`·`verify`·`activate`·`import`·`export`·`pause`·`resume` | [SQLite 저장](sqlite-storage.md) |

## 자원 아끼기

| 명령 | 하는 일 | 자세히 |
|---|---|---|
| `kadan slot` | 저장소마다 다시 쓰는 검수용 worktree(기본 4자리). `acquire <저장소> --for <카드> [--ref <SHA>]`·`deps <자리경로>`·`release <자리경로>\|--for <카드>`·`status` | [검수 자리](review-slots.md) |
| `kadan limit` | 무거운 명령의 기계 전체 동시 개수 제한. `run <rust\|install\|build> -- <명령...>`·`status`. rust는 `CARGO_BUILD_JOBS=2` | [무거운 명령 제한](review-slots.md#무거운-명령-제한-kadan-limit) |

### `kadan restart` 자세히

실행기를 업데이트하거나 설정을 바꾼 뒤 역할의 **대화는 그대로 두고 프로그램만** 다시 띄운다(2026-10-14 [kyle]). 실행기마다 다른 "같은 대화 다시 열기·대화 ID 찾기" 지식은 코드가 아니라 실행 모델 설정의 [실행기 명령 표](runner-settings.md#실행기-명령-표)에 있다.

순서(거절할 수 있는 확인은 모두 기존 세션을 끄기 **전에** 끝낸다):

1. 역할 잠금 → 마지막 `start` 기록 확인(이미 `stop`된 역할·죽은 pane·기록과 다른 PID·자기 자신은 거절).
2. 끝나지 않은 카드(`stop`이 알리는 것과 같은 판정)가 있으면 목록을 보이고 거절. `--force`면 진행하고 stop·start 기록에 `forced`·`forcedTasks`를 남긴다. 역할은 `--force`를 쓰지 않는다(스스로 밝힌 신분이라 사람인지 검증할 수 없다 — 역할 지침에 한 줄).
3. 이 pane의 **실행기 본체 사슬**이 **지금 실제로** 연 대화를 표의 `conversation`으로 확정한다. 본체 사슬 = 트리에서 마지막 `start` 명령의 실행기·모델과 `ps` 인자가 맞는 프로세스 중 조상에 맞는 것이 없는 **뿌리 1개**와, 그 아래로 맞는 프로세스가 하나씩 이어진 것(codex의 node 래퍼→네이티브 바이너리). 뿌리가 0·2개 이상이거나 사슬이 갈리면 거절한다(같은 실행기의 하위 에이전트와 구분할 수 없다). `open-file`은 사슬이 연 파일에서, `pid-json`은 **뿌리 PID의 파일만** 읽는다. 표의 `conversation.evidence`(lock 등 저장 여부와 무관하게 ID를 드러내는 파일의 정규식)까지 합쳐 서로 다른 대화 ID가 둘 이상 보이면 거절한다. 자식 도구가 연 파일은 후보가 아니다(2026-10-14 실측: 열린 rollout·lock은 네이티브 codex가 가진다).
4. 마지막 `start`의 명령에서 대화 인자만 바꾼다(`resume` 틀의 꼬리). 실행기·모델이 같고 같은 대화(resume)로 읽혀야 한다. 갈라 연 명령(`adopt`의 `--fork-session` 등)은 표에 `fork` 틀이 있으면 그 꼬리를 떼고 살아 있는 대화로 resume한다.
5. `stop`(`restart: true` 표시) → 같은 작업 폴더에서 새 명령으로 시작 → 기계 창 설정(`KADAN_WINDOW`)대로 창을 연다 → `start`에 `restartOf`(옛 start의 지문)·`restartConversation`을 적는다. `restartOf`는 `restoredFrom`처럼 새 세대가 아니다(우편·책임·감시 발령을 이어받음).

- 비서 복원 명령의 `--model`·`-c`는 키마다 시작 명령의 것이 이기고 대화의 옵션은 빈 키만 채운다([복원 규칙](recovery.md#로그인-때-비서-대화-복원)).
- `비서`는 일반 찾기 대신 `kadan up`과 같은 체크포인트(`secretary-resume.json`) 경로로 같은 `start` 사건을 만든다. 체크포인트를 못 만들면(codex가 아닌 비서·래퍼 명령) 끄지 않고 거절하며, 새 `start`에도 `restartOf`(`--force`면 `forced`·`forcedTasks`)를 남겨 감시 발령이 이어진다. `restart: true`인 `stop`은 사용자가 직접 끈 것으로 읽히지 않는다.
- 감시: `stop`과 `start` 사이 몇 초 동안 감시가 그 세션을 죽은 것으로 볼 수 있다. 감시 한 주기보다 훨씬 짧아 보통 경보가 나기 전에 끝나지만, 따로 감시를 멈추는 표시는 없다(한계).
- 운영 소켓의 역할에 쓰려면 먼저 해당 `runner-settings.json`에 표를 채워야 한다(없으면 "미지원"으로 거절).
- `--reason <이유>`(선택): restart가 남기는 `stop`(`restart: true`)·`start`(`restartOf`) 두 사건에 `reason` 칸으로 적는다. 옛 기록은 고치지 않는다.
- `--expect-pid <pane PID>`(선택): 원장의 최신 `start`의 pane PID와 다르면 끄기 전에 거절한다. 화면이 본 세대와 지금 세대를 대조해 두 번 재시작을 막는 장치다.
- 역할 이름은 정규화 전후가 같아야 한다. 앞뒤 하이픈 등 별칭(`-역할`·`역할-`)은 같은 세션을 가리켜도 거절한다 — 미해결 카드와 원장 기록이 항상 같은 이름을 쓰게 하려는 것이다(2026-10-15 2라운드).
- 화면 진입점(2026-10-15): 대시보드 실행 모델(`#runner-settings`) 화면의 '담당자 상태 · 지금 열린 창' 절에서 살아 있는 역할 줄의 '다시 띄우기' 버튼. 이유 칸은 필수이고, 서버는 POST `/roles/restart`로 받아 `kadan restart <역할>`을 자식 프로세스로 부른다(사람 명의). 이유·세대 표시는 CLI 옵션으로 재해석되지 않게 환경변수(`KADAN_RESTART_REASON`·`KADAN_RESTART_EXPECT_PID`)로만 넘긴다. CLI는 읽은 즉시 자기 환경에서 지워 새 역할·tmux 서버에 남지 않게 하고(자식 프로세스를 만들기 전), 명시 옵션과 환경값이 둘 다 있고 다르면 어느 쪽인지 사람이 확인하도록 거절한다. 화면 응답 상한은 28초이고, 넘기면 '진행 중' 안내를 답한 뒤 자식은 끊지 않고 최종 상한 120초까지 돌게 한다(끊으면 stop만 남는 반쯤 끝난 상태가 되므로). `--force`는 화면에서 보내지 않는다 — 끝나지 않은 카드 거절은 CLI 메시지가 그대로 보인다.
- 최종 상한·도중 실패로 남은 회복 잠금(`<홈>/recovery/role-*.lock`)은 자동으로 지우지 않는다. 다음 restart·start가 '역할 복원이 진행 중입니다'로 거절되면 잠금 경로를 확인하고 사람이 지운다(기존 dir-lock 규칙).
- 아직 안 한 것: 실행 모델 화면에 표 보이기.
