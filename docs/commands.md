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
| `KADAN_FLOOR` | 에이전트가 사는 바닥. `tmux`(기본) 또는 `rottie`. 기계당 하나 |
| `KADAN_WINDOW` | tmux 바닥에서 시작할 때 여는 창. `none`(기본) · `rottie` · `orca` |
| `KADAN_ROTTIE_BIN` | `KADAN_WINDOW=rottie`일 때 말 걸 로티 CLI의 절대경로 |
| `KADAN_SOCKET` | tmux 구획 이름. 기본 `kadan` (`tmux -L kadan`) |
| `KADAN_ROLE` | 카단 세션 안에서 자동으로 붙는 자기 역할. 원장의 `by`가 된다 |

## 처음 준비

| 명령 | 하는 일 | 자주 쓰는 옵션 |
|---|---|---|
| `kadan init` | 환경 확인, 스킬 링크, 실행기 선택. 처음 한 번 | `--runner codex\|claude`, `--no-skills` |
| `kadan up` | 비서 세션과 대시보드 세션을 띄운다. 이미 있으면 그대로 쓴다 | `--cmd <실행기 명령>`, `--port 8790`, `--hidden`, `--no-prompt` |

## 역할(세션) 다루기

| 명령 | 하는 일 | 자주 쓰는 옵션 |
|---|---|---|
| `kadan start <역할>` | 바닥에 세션을 만들고 창을 연다. 이미 살아 있으면 창만 다시 연다 | `--profile worker\|reviewer\|conductor\|super\|secretary`, `--cmd <명령> --reason <이유>`, `--fallback N --reason <이유>`, `--hidden` |
| `kadan send <역할> <메시지>` | 생존 확인 뒤 입력창에 넣는다. 원장에 영수증을 남긴다 | `--task <카드id>`(작업 발령), `--work`·`--execution`(우편 연결), `--mailbox`, `--expect-reply`, `--reply-to <우편ID>`, `--raw` |
| `kadan wait <역할>` | 완료 마커(DONE)나 조용함을 보고한다. 판정하지 않는다 | `--timeout 초`, `--quiet 초`, `--interval 초` |
| `kadan done <역할> <카드id> <ok\|failed>` | 사람·감독이 확인한 완료를 원장에 적는다. 한 번 발령으로 끝나는 카드는 `--close-card`로 카드도 함께 닫는다([카드 닫기](card-center.md#실행-완료와-카드-닫기)) | `--from-screen`(결과 대신 작업자 화면의 DONE을 읽어 확정. 짧은 카드id·정식 주소·응답 머리표 `•`/`⏺` 모두 인정, 그 카드 마지막 발령 전부터 있던 마커는 제외. 없으면 기록·전송 없이 종료 코드 3), `--wait <초>`(`--from-screen`과 함께. 마커가 없으면 2초 간격으로 화면만 다시 읽는 유한 대기, 최대 600. 완료 편지가 마커보다 먼저 오는 경합용이며 시간이 다 되면 종료 코드 3 그대로), `--close-card`(ok 확정 뒤 카드 `done`, 실패해도 실행 완료 유지), `--note <이유>`(카드 기록 이유) |
| `kadan read <역할>` | 화면 끝부분을 읽는다 | `--lines N` |
| `kadan status` | 살아 있는 세션, 창 붙음 여부, PID 일치, 실행기·모델 | — |
| `kadan attach <역할>` | 살아 있는 세션에 창을 하나 더 연다 | — |
| `kadan restore [역할...]` | 로티 데몬 재시작 뒤, 기록된 로티 탭이 죽은 살아 있는 세션에 새 탭을 붙인다 | `--dry-run` |
| `kadan stop <역할>` | 카단이 만든 세션만 끝내고 연결된 로티 탭을 닫는다. 미확정 카드가 있으면 알린다 | — |
| `kadan hierarchy prune` | 끝난 역할의 관계를 정리할 후보와 보존 이유를 표시한다. [정리 기준](hierarchy.md#끝난-역할-정리) | `--apply`(백업 후 적용), `--file <절대경로>`(복사본 등 대상 지정) |

### `kadan stop`의 로티 탭 정리

tmux 세션을 종료한 뒤 원장의 최신 탭 ID를 조회하고, `terminal close` → `terminal remove` 순서로 닫고 목록에서 지운다. `restore`로 새 탭을 붙였다면 그 탭을 쓴다.

- 로티 실행 파일이 없어졌거나 연결되지 않으면 `start`와 같은 규칙으로 경로를 교정한다. 실행 중인 후보가 정확히 하나이고 연결될 때만 바꾸며, `KADAN_ROTTIE_AUTO_ATTACH=off`이면 바꾸지 않는다. 앱을 새로 켜지는 않는다.
- 원장에 기록된 탭을 조회하지 못하면 닫기·제거를 보내지 않는다. 로티 탭 기록이 없으면 로티를 조회하지 않는다.
- 탭 정리에 실패하면 세션 종료 사실과 실패 이유를 표준 오류에 알리고 종료 코드 `1`을 반환한다. `stop` 원장에는 닫기·제거 결과와 경로 교정 내역을 남긴다.
- 이때 tmux 세션은 이미 종료됐으므로 같은 `stop`을 다시 실행해도 탭 정리가 재시도되지는 않는다. 원장에 남은 탭 ID와 실패 원인을 확인해야 한다.

### `kadan restore` 자세히

로티 데몬을 다시 켜면 tmux 세션(에이전트)은 살고, 그 세션을 보여 주던 로티 탭만 끊긴다. `restore`는 탭만 다시 붙인다.

- 바닥이 tmux이고 `KADAN_WINDOW=rottie`일 때만 쓴다. 로티 바닥은 데몬과 함께 에이전트도 끝나므로 되살릴 것이 없다.
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
| `kadan wall` / `kadan dashboard` | 로컬 관제 화면(HTML)을 띄운다 | `--port 8790`, `--cache-sec 초` |

## 감시

| 명령 | 하는 일 | 자세히 |
|---|---|---|
| `kadan watch` | 정체·끊김·완료 후보를 감독에게 알리는 감시를 돌린다 | [감시 기준](watch-overview.md), [제한 재개](rate-limit-retry.md), [책임 관계](hierarchy.md) |
| `kadan watch-report <호출ID>` | 감시 AI가 판정 결과를 돌려준다 | `--verdict 진행중\|입력대기\|실행완료\|응답장애\|정체\|모름\|조정 --reason <이유>` (`죽음`은 옛 규약 호환으로 받되 새 보고에서는 거절) |

## 업무·카드·결정

| 명령 | 하는 일 | 자세히 |
|---|---|---|
| `kadan work` | 결과 중심 업무 한 장과 그 안의 실행. `create`·`list`·`show`·`update`·`execute`·`link`/`unlink`·`mail`·`complete`/`cancel`·`reopen` | [업무 카드와 실행](business-work.md) |
| `kadan work auto-*` | 구현·검수 자동 전달. `auto-configure`·`auto-show`·`auto-run`·`auto-report` 등 | [자동 전달](automatic-review.md) |
| `kadan card` | 중앙 카드. `list`·`show`·`create`·`update`·`note`·`brief`·`progress`·`report`·`link` 등 | [중앙 카드](card-center.md) |
| `kadan decision` | 사용자 결정 요청. `request`·`list`·`show`·`answer`·`cancel` | [결정 기록](decisions.md) |

## 우편

| 명령 | 하는 일 | 자세히 |
|---|---|---|
| `kadan inbox` | 역할 우편함 조회. `list`·`received`·`sent`·`to-reply`·`waiting`·`read`·`ack`·`cancel` | [우편함 명령](secretary-mailbox.md), [원장 계약](mail-task-ledgers.md) |

보내기는 `kadan send <역할> --mailbox …`다. 조회는 읽음 처리하지 않고, `ack`가 읽음만 표시한다.

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
